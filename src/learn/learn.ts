// src/learn/learn.ts
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { load as loadCheerio } from "cheerio";

const LEARNED_PATH = "storage/learned.json";

/* ================= helpers ================= */

function normalizeHost(host: string) {
  let h = host.replace(/^https?:\/\//, "").replace(/^www\./, "");
  h = h.replace(/^([a-z]{2})\./i, ""); // drop country subdomain (generic ccTLD prefix)
  return h;
}

/**
 * Strip unstable / hashed utility classes so selectors stay reusable across deploys.
 * (Framework-agnostic: targets common hashed-style patterns only.)
 */
function stripHashedClasses(sel: string): string {
  return sel.replace(
    /\.(?:css|chakra|sc|tw|_)[a-z0-9_-]+/gi,
    ""
  );
}

function toArray(x?: string | string[]) {
  if (!x) return [];
  return Array.isArray(x)
    ? x
    : x
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
}

function normalizeList(list?: string | string[]) {
  const cleaned = Array.from(
    new Set(
      toArray(list)
        .map(stripHashedClasses)
        .filter(Boolean)
    )
  );
  return cleaned.length ? cleaned : undefined;
}

const CAPS = {
  list: 20,
  anchors: 40,
  containers: 40,
  broad: 40,
  candidates: 80,
};

const cap = <T>(arr: T[] | undefined, n: number) =>
  arr ? arr.slice(0, n) : arr;

/** Cheap, layout-oriented fingerprint (no site-specific logic). */
function makeTemplateHash(html: string): string {
  const count = (re: RegExp) => (html.match(re) || []).length;
  const has = (re: RegExp) => re.test(html);

  const cards = count(/\b(card|tile|result|entry|product|item|grid__item)\b/g);
  const dataAttrs = count(/\bdata-[a-z0-9_-]+\b/g);
  const ld = has(/application\/ld\+json/) ? 1 : 0;

  const anchors = count(/<a\b[^>]*href=/g);
  const divs = count(/<div\b/g) || 1;
  const density = Math.min(999, Math.round((anchors / divs) * 1000));

  const topWrapMatch =
    html.match(/<(main|body)\b[^>]*class="([^"]+)"/) || [];
  const topWrap = (topWrapMatch[2] || "").trim();
  const topSig = topWrap
    .split(/\s+/)
    .slice(0, 2)
    .join("-")
    .toLowerCase();

  return `c${cards}-d${density}-da${dataAttrs}-ld${ld}-${topSig}`;
}

/* ================= types ================= */

export type Buckets = {
  list?: string[];
  anchors?: string[];
  containers?: string[];
  broad?: string[];
  candidates?: string[];
  // normalized field map: name → { sel, attr? } or similar
  fields?: Record<string, any>;
};

export type Match = {
  pathRegex?: string; // e.g. "^/collections/[^/]+$"
  queryKeys?: string[]; // e.g. ["q","page"]
  templateHash?: string; // light DOM fingerprint
  // host?: string; // allowed if you ever want it; not required
};

export type Profile = {
  id: string;
  match: Match;
  buckets: Buckets;
  metrics?: {
    runs: number;
    avgItems: number;
    lastSeen: string;
  };
};

type HostRecord = { profiles: Profile[] };

let learnedByHost: Record<string, HostRecord> = {};

/* ================= load/save ================= */

export function loadLearnedSelectors() {
  const dir = dirname(LEARNED_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  if (!existsSync(LEARNED_PATH)) {
    learnedByHost = {};
    return;
  }

  const raw = readFileSync(LEARNED_PATH, "utf8");
  const data = raw ? JSON.parse(raw) : {};

  // migrate legacy {list, anchors,..., fields} into a default profile
  for (const [host, rec] of Object.entries<any>(data)) {
    if (rec?.profiles) continue;

    data[host] = {
      profiles: [
        {
          id: "default",
          match: {},
          buckets: {
            list: normalizeList(rec.list),
            anchors: normalizeList(rec.anchors),
            containers: normalizeList(rec.containers),
            broad: normalizeList(rec.broad),
            candidates: normalizeList(rec.candidates),
            fields: rec.fields || {},
          },
          metrics: {
            runs: 0,
            avgItems: 0,
            lastSeen: new Date().toISOString(),
          },
        },
      ],
    };
  }

  learnedByHost = data;
}

function persist() {
  const dir = dirname(LEARNED_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(
    LEARNED_PATH,
    JSON.stringify(learnedByHost, null, 2),
    "utf8"
  );
}

/* ================= matching ================= */

function scoreProfile(u: URL, html: string, p: Profile): number {
  let s = 0;

  if (p.match.pathRegex && new RegExp(p.match.pathRegex).test(u.pathname)) {
    s += 2;
  }

  if (p.match.queryKeys?.length) {
    const keys = new Set(Array.from(u.searchParams.keys()));
    s += p.match.queryKeys.filter((k) => keys.has(k)).length;
  }

  if (
    p.match.templateHash &&
    p.match.templateHash === makeTemplateHash(html)
  ) {
    s += 3; // strong signal
  }

  return s;
}

export function getBestProfile(
  host: string,
  url: string,
  html: string
): {
  profile: Profile | null;
  buckets: Buckets;
  score: number;
} {
  const key = normalizeHost(host);
  const rec = learnedByHost[key];

  if (!rec?.profiles?.length) {
    return { profile: null, buckets: {}, score: 0 };
  }

  const u = new URL(url);
  let best: Profile | null = null;
  let bestScore = -1;

  for (const p of rec.profiles) {
    const sc = scoreProfile(u, html, p);
    if (sc > bestScore) {
      best = p;
      bestScore = sc;
    }
  }

  const buckets = best ? normalizeBuckets(best.buckets) : {};
  return { profile: best, buckets, score: bestScore };
}

function normalizeBuckets(b: Buckets): Buckets {
  const norm = (x?: string[] | string) => {
    const arr = normalizeList(x as any);
    return arr && arr.length ? arr : undefined;
  };

  return {
    fields: b.fields || {},
    list: cap(norm(b.list), CAPS.list),
    anchors: cap(norm(b.anchors), CAPS.anchors),
    containers: cap(norm(b.containers), CAPS.containers),
    broad: cap(norm(b.broad), CAPS.broad),
    candidates: cap(norm(b.candidates), CAPS.candidates),
  };
}

/* ========== Generic, site-agnostic candidate mining ========== */

function mineCandidatesFromHtml(html: string): Buckets {
  const $ = loadCheerio(html);
  const out: Buckets = {
    list: [],
    anchors: [],
    containers: [],
    broad: [],
    candidates: [],
    fields: {},
  };

  // A) JSON-LD Product hints (generic schema usage)
  $("script[type='application/ld+json']").each((_, s) => {
    const txt = $(s).contents().text() || "";
    try {
      const data = JSON.parse(txt);
      const arr = Array.isArray(data) ? data : [data];
      const hasProduct = arr.some((x) => {
        const t = x && x["@type"];
        if (!t) return false;
        if (typeof t === "string") return t === "Product";
        if (Array.isArray(t)) return t.includes("Product");
        return false;
      });

      if (hasProduct) {
        out.candidates!.push(
          "[itemscope][itemtype*='Product']",
          "[data-product]",
          "[data-sku]"
        );
      }
    } catch {
      // ignore bad JSON-LD
    }
  });

  // B) Frequency-based container discovery (repeated structures)
  const freq: Record<string, number> = {};

  $("*").each((_, el) => {
    const tagName = (el as any).tagName || "div";
    const tag = String(tagName).toLowerCase();
    const cls = ($(el).attr("class") || "")
      .split(/\s+/)
      .filter(Boolean)
      .sort()
      .join(".");
    const key = cls ? `${tag}.${cls}` : tag;
    freq[key] = (freq[key] || 0) + 1;
  });

  const common = Object.entries(freq)
    .filter(
      ([k, v]) =>
        v >= 6 &&
        /\b(card|product|item|grid|tile|result|entry|listing)\b/i.test(k)
    )
    .slice(0, 20)
    .map(([k]) => {
      const parts = k.split(".");
      return parts.length > 1 ? "." + parts.slice(1).join(".") : parts[0];
    })
    .filter(Boolean);

  out.containers!.push(...common);

  // C) Derive list selectors from children with anchors + (image or price-like text)
  const priceRe =
    /\b(\$|€|£|¥)\s?\d|^\s*\d+(?:[.,]\d{2})?\s*(usd|cad|eur|gbp|aud|nzd|mxn|brl)?\b/i;

  const strongAnchors: string[] = [];

  common.forEach((contSel) => {
    try {
      const cont = $(contSel).first();
      if (!cont.length) return;

      const kids = cont.children().slice(0, 250);
      const signatures: Record<string, number> = {};

      kids.each((_, k) => {
        const tagName = (k as any).tagName || "div";
        const tag = String(tagName).toLowerCase();
        const cls = ($(k).attr("class") || "")
          .trim()
          .split(/\s+/)
          .filter(Boolean)
          .sort()
          .join(".");
        const sig = cls ? `.${cls}` : tag;
        signatures[sig] = (signatures[sig] || 0) + 1;
      });

      const childCommon = Object.entries(signatures)
        .filter(([, n]) => n >= 3)
        .map(([sig]) => `${contSel} > ${sig}`);

      childCommon.forEach((sel) => {
        const nodes = $(sel);
        const ok = nodes.filter((_, n) => {
          const hasA = $(n).find("a[href]").length > 0;
          const hasImg =
            $(n).find("img[src], img[data-src], img[srcset]").length > 0;
          const txt = $(n).text();
          const hasPrice = priceRe.test(txt);
          return hasA && (hasImg || hasPrice);
        });

        if (ok.length >= 3) {
          out.list!.push(sel); // card-as-item
          out.anchors!.push(`${sel} a[href]`);
          strongAnchors.push(`${sel} a[href]`);
        }
      });
    } catch {
      // best-effort
    }
  });

  // D) If no clear cards, promote anchors as items (generic pattern)
  if (!out.list?.length && strongAnchors.length) {
    out.list!.push(...strongAnchors);
  }

  // E) Broad / generic candidates
  out.broad!.push("main a[href]", "body a[href]");
  out.candidates!.push(
    "[data-product]",
    "[data-item]",
    "[data-sku]",
    "[itemscope][itemtype*='Product']"
  );

  const uniq = (a?: string[]) =>
    Array.from(new Set((a || []).filter(Boolean)));

  out.list = uniq(out.list);
  out.anchors = uniq(out.anchors);
  out.containers = uniq(out.containers);
  out.broad = uniq(out.broad);
  out.candidates = uniq(out.candidates);

  return out;
}

/* ================= upsert (learn/update) ================= */

export type UpsertProfileInput = {
  id?: string; // if provided, update that profile
  match?: Partial<Match>;
  buckets: Buckets; // learned + caller-provided
  metrics?: { items?: number };
};

export function upsertProfile(
  host: string,
  incoming: UpsertProfileInput,
  html: string,
  opts?: { source?: string }
)
 {
  const key = normalizeHost(host);
  learnedByHost[key] ||= { profiles: [] };
  const rec = learnedByHost[key];

  const MAX_PROFILES = 8;

  let p: Profile | undefined;

  if (incoming.id) {
    p = rec.profiles.find((x) => x.id === incoming.id);
  }

  // Create if missing
  if (!p) {
    const inferred: Match = {
      ...incoming.match,
      templateHash:
        incoming.match?.templateHash || (html ? makeTemplateHash(html) : undefined),
    };

    p = {
      id:
        incoming.id ||
        `${Date.now().toString(36)}-${Math.random()
          .toString(36)
          .slice(2, 7)}`,
      match: inferred,
      buckets: {},
      metrics: {
        runs: 0,
        avgItems: 0,
        lastSeen: new Date().toISOString(),
      },
    };

    // LRU trim
    if (rec.profiles.length >= MAX_PROFILES) {
      rec.profiles.sort((a, b) =>
        (a.metrics?.lastSeen || "").localeCompare(
          b.metrics?.lastSeen || ""
        )
      );
      rec.profiles.shift();
    }

    rec.profiles.push(p);
  }

  // 1) Auto-mine generic hints from final HTML
  const mined = html ? normalizeBuckets(mineCandidatesFromHtml(html)) : {};

  // 2) Normalize incoming (+ merge with mined before merging into profile)
  const mergedIncoming: Buckets = {
    fields: incoming.buckets.fields,
    list: [
      ...(incoming.buckets.list || []),
      ...(mined.list || []),
    ],
    anchors: [
      ...(incoming.buckets.anchors || []),
      ...(mined.anchors || []),
    ],
    containers: [
      ...(incoming.buckets.containers || []),
      ...(mined.containers || []),
    ],
    broad: [
      ...(incoming.buckets.broad || []),
      ...(mined.broad || []),
    ],
    candidates: [
      ...(incoming.buckets.candidates || []),
      ...(mined.candidates || []),
    ],
  };

  const ib = normalizeBuckets(mergedIncoming);
  const nb = normalizeBuckets(p.buckets);
  const items = incoming.metrics?.items ?? 0;

  const mergeUniq = (
    a?: string[],
    b?: string[],
    capSize = 50
  ): string[] | undefined => {
    const merged = Array.from(
      new Set([...(a || []), ...(b || [])])
    ).filter(Boolean);
    return merged.length ? cap(merged, capSize) : undefined;
  };

  // No-degrade for `list`: only accept new list selectors if we successfully extracted items.
  const mergedList =
    items > 0
      ? mergeUniq(nb.list, ib.list, CAPS.list)
      : nb.list;

  p.buckets = {
    fields: {
      ...(nb.fields || {}),
      ...(ib.fields || {}),
    },
    list: mergedList,
    anchors: mergeUniq(
      nb.anchors,
      ib.anchors,
      CAPS.anchors
    ),
    containers: mergeUniq(
      nb.containers,
      ib.containers,
      CAPS.containers
    ),
    broad: mergeUniq(
      nb.broad,
      ib.broad,
      CAPS.broad
    ),
    candidates: mergeUniq(
      nb.candidates,
      ib.candidates,
      CAPS.candidates
    ),
  };

  // metrics
  const runs = (p.metrics?.runs ?? 0) + 1;
  const prevAvg = p.metrics?.avgItems ?? 0;
  const avgItems =
    runs > 0
      ? Math.round(
          (prevAvg * (runs - 1) + items) / runs
        )
      : 0;

  p.metrics = {
    runs,
    avgItems,
    lastSeen: new Date().toISOString(),
  };

  persist();
}

/* ===== Convenience (legacy compatibility) ===== */

export function getLearnedForHost(host: string): Buckets | null {
  const key = normalizeHost(host);
  const rec = learnedByHost[key];
  if (!rec?.profiles?.length) return null;

  // Fallback: most recently appended profile
  const p = rec.profiles[rec.profiles.length - 1];
  return normalizeBuckets(p.buckets);
}

export function saveLearnedForHost(host: string, payload: Buckets) {
  // Legacy surface: write into a "default" profile in a generic way.
  upsertProfile(
    host,
    {
      id: "default",
      buckets: payload,
    },
    "",
    { source: "legacy" }
  );
}
