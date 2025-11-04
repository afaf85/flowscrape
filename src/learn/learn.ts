// src/learn/learn.ts
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { load as loadCheerio } from "cheerio";

const LEARNED_PATH = "storage/learned.json";

/* ================= helpers ================= */

function normalizeHost(host: string) {
  let h = host.replace(/^https?:\/\//, "").replace(/^www\./, "");
  h = h.replace(/^([a-z]{2})\./i, ""); // drop country subdomain
  return h;
}

function stripHashedClasses(sel: string): string {
  // remove hashed/compiled class segments like .css-1gk6hs6 or .chakra-abc123
  return sel.replace(/\.(?:css|chakra|sc|tw|_)[a-z0-9_-]+/gi, "");
}

function toArray(x?: string | string[]) {
  if (!x) return [];
  return Array.isArray(x) ? x : x.split(",").map(s => s.trim()).filter(Boolean);
}

function normalizeList(list?: string | string[]) {
  const cleaned = Array.from(new Set(toArray(list).map(stripHashedClasses).filter(Boolean)));
  return cleaned.length ? cleaned : undefined;
}

const CAPS = { list: 20, anchors: 40, containers: 40, broad: 40, candidates: 80 };
const cap = <T>(arr: T[] | undefined, n: number) => (arr ? arr.slice(0, n) : arr);

/** Cheap, stable-ish layout fingerprint (layout GUID) */
function makeTemplateHash(html: string): string {
  const count = (re: RegExp) => (html.match(re) || []).length;
  const has   = (re: RegExp) => re.test(html);

  const cards = count(/\b(card|tile|result|entry|product|item|grid__item)\b/g);
  const dataA = count(/\bdata-[a-z0-9_-]+\b/g);
  const ld    = has(/application\/ld\+json/)?1:0;

  const anchors = count(/<a\b[^>]*href=/g);
  const divs    = count(/<div\b/g) || 1;
  const dens    = Math.min(999, Math.round((anchors/divs)*1000));

  const topWrap = (html.match(/<(main|body)\b[^>]*class="([^"]+)"/) || [])[2] || "";
  const topSig  = topWrap.split(/\s+/).slice(0,2).join("-").toLowerCase();

  return `c${cards}-d${dens}-da${dataA}-ld${ld}-${topSig}`;
}

/* ================= types ================= */

export type Buckets = {
  list?: string[]; anchors?: string[]; containers?: string[];
  broad?: string[]; candidates?: string[]; fields?: Record<string, any>;
};

export type Match = {
  pathRegex?: string;        // e.g. "^/collections/[^/]+$"
  queryKeys?: string[];      // e.g. ["q","page"]
  templateHash?: string;     // light DOM fingerprint
};

export type Profile = {
  id: string;
  match: Match;
  buckets: Buckets;
  metrics?: { runs: number; avgItems: number; lastSeen: string };
};

type HostRecord = { profiles: Profile[] };

let learnedByHost: Record<string, HostRecord> = {};

/* ================= load/save ================= */

export function loadLearnedSelectors() {
  const dir = dirname(LEARNED_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (existsSync(LEARNED_PATH)) {
    const raw = readFileSync(LEARNED_PATH, "utf8");
    const data = raw ? JSON.parse(raw) : {};
    // migrate legacy {list, anchors,..., fields} into a default profile
    for (const [host, rec] of Object.entries<any>(data)) {
      if (rec?.profiles) continue;
      data[host] = {
        profiles: [{
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
          metrics: { runs: 0, avgItems: 0, lastSeen: new Date().toISOString() }
        }]
      };
    }
    learnedByHost = data;
  } else {
    learnedByHost = {};
  }
}

function persist() {
  const dir = dirname(LEARNED_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(LEARNED_PATH, JSON.stringify(learnedByHost, null, 2), "utf8");
}

/* ================= matching ================= */

function scoreProfile(u: URL, html: string, p: Profile): number {
  let s = 0;
  if (p.match.pathRegex && new RegExp(p.match.pathRegex).test(u.pathname)) s += 2;
  if (p.match.queryKeys?.length) {
    const keys = new Set(Array.from(u.searchParams.keys()));
    s += p.match.queryKeys.filter(k => keys.has(k)).length; // +1 per key match
  }
  if (p.match.templateHash && p.match.templateHash === makeTemplateHash(html)) s += 3; // strong
  return s;
}

export function getBestProfile(host: string, url: string, html: string): {
  profile: Profile | null;
  buckets: Buckets; // merged + normalized buckets for the chosen profile (or empty)
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
    if (sc > bestScore) { best = p; bestScore = sc; }
  }
  const buckets = best ? normalizeBuckets(best.buckets) : {};
  return { profile: best, buckets, score: bestScore };
}

function normalizeBuckets(b: Buckets): Buckets {
  const norm = (x?: string[] | string) => {
    const arr = normalizeList(x as any);
    return (arr && arr.length) ? arr : undefined;
  };
  return {
    fields: b.fields || {},
    list:       cap(norm(b.list),       CAPS.list),
    anchors:    cap(norm(b.anchors),    CAPS.anchors),
    containers: cap(norm(b.containers), CAPS.containers),
    broad:      cap(norm(b.broad),      CAPS.broad),
    candidates: cap(norm(b.candidates), CAPS.candidates),
  };
}

/* ============== generic page-guided miner (site-agnostic) ============== */

function mineCandidatesFromHtml(html: string): Buckets {
  const $ = loadCheerio(html);
  const out: Buckets = { list: [], anchors: [], containers: [], broad: [], candidates: [], fields: {} };

  // A) JSON-LD Product hints
  $("script[type='application/ld+json']").each((_, s) => {
    const txt = $(s).contents().text() || "";
    try {
      const data = JSON.parse(txt);
      const arr = Array.isArray(data) ? data : [data];
      const hasProduct = arr.some(
        x => x && (x["@type"] === "Product" || (Array.isArray(x["@type"]) && x["@type"].includes("Product")))
      );
      if (hasProduct) {
        out.candidates!.push(
          "[itemscope][itemtype*='Product']",
          "[data-product]",
          "[data-sku]"
        );
      }
    } catch {}
  });

  // B) Frequency-based container discovery
  const freq: Record<string, number> = {};
  $("*").each((_, el) => {
    const tag = (el as any).tagName ? String((el as any).tagName).toLowerCase() : "div";
    const cls = ($(el).attr("class") || "").split(/\s+/).filter(Boolean).sort().join(".");
    const key = cls ? `${tag}.${cls}` : tag;
    freq[key] = (freq[key] || 0) + 1;
  });

  const common = Object.entries(freq)
    .filter(([k, v]) => v >= 6 && /\b(card|product|item|grid|tile|result|entry|listing)\b/i.test(k))
    .slice(0, 20)
    .map(([k]) => {
      const parts = k.split(".");
      return parts.length > 1 ? "." + parts.slice(1).join(".") : parts[0];
    })
    .filter(Boolean);

  out.containers!.push(...common);

  // C) Derive list selectors from children with anchors + (image|price)
  const priceRe = /\b(\$|€|£|¥|cad|usd|eur)\s?\d|^\s*\d+(?:[.,]\d{2})?\s*(usd|cad|eur|mxn)?\b/i;

  const strongAnchors: string[] = [];

  common.forEach(contSel => {
    try {
      const cont = $(contSel).first();
      if (!cont.length) return;

      const kids = cont.children().slice(0, 250);
      const signatures: Record<string, number> = {};
      kids.each((_, k) => {
        const tag = (k as any).tagName ? String((k as any).tagName).toLowerCase() : "div";
        const cls = ($(k).attr("class") || "").trim().split(/\s+/).filter(Boolean).sort().join(".");
        const sig = cls ? `.${cls}` : tag;
        signatures[sig] = (signatures[sig] || 0) + 1;
      });

      const childCommon = Object.entries(signatures)
        .filter(([, n]) => n >= 3)
        .map(([sig]) => `${contSel} > ${sig}`);

      childCommon.forEach(sel => {
        const nodes = $(sel);
        const ok = nodes.filter((_, n) => {
          const hasA = $(n).find("a[href]").length > 0;
          const hasImg = $(n).find("img[src], img[data-src], img[srcset]").length > 0;
          const txt = $(n).text();
          const hasPrice = priceRe.test(txt);
          return hasA && (hasImg || hasPrice);
        });
        if (ok.length >= 3) {
          out.list!.push(sel);                         // card-as-item
          out.anchors!.push(`${sel} a[href]`);         // anchor inside card
          strongAnchors.push(`${sel} a[href]`);        // remember strong anchors
        }
      });
    } catch {}
  });

  // D) If cards weren’t obvious, **promote strong anchors as list items**
  // (Some sites like Zara have the anchor as the “card”)
  if (!out.list?.length && strongAnchors.length) {
    out.list!.push(...strongAnchors);
  }

  // E) Broad + generic candidates
  out.broad!.push("main a[href]", "body a[href]");
  out.candidates!.push("[data-product]", "[data-item]", "[data-sku]", "[itemscope][itemtype*='Product']");

  // Dedup/clean
  const uniq = (a?: string[]) => Array.from(new Set((a || []).filter(Boolean)));
  out.list = uniq(out.list);
  out.anchors = uniq(out.anchors);
  out.containers = uniq(out.containers);
  out.broad = uniq(out.broad);
  out.candidates = uniq(out.candidates);
  return out;
}


/* ================= upsert (learn again) ================= */

export function upsertProfile(host: string, baseUrl: string, html: string, incoming: {
  id?: string;                // if provided, update that profile
  match?: Partial<Match>;     // otherwise create with inferred matchers
  buckets: Buckets;           // tried/winners + fields merged by caller
  metrics?: { items?: number };
}) {
  const key = normalizeHost(host);
  learnedByHost[key] ||= { profiles: [] };
  const rec = learnedByHost[key];

  const MAX_PROFILES = 8;

  let p: Profile | undefined;
  if (incoming.id) {
    p = rec.profiles.find(x => x.id === incoming.id);
  }

  if (!p) {
    const u = new URL(baseUrl);
    const inferred: Match = {
      pathRegex: `^/${u.pathname.split("/").filter(Boolean)[0] || ""}(/|$)`,
      queryKeys: Array.from(new Set(Array.from(u.searchParams.keys()))).slice(0, 3),
      templateHash: makeTemplateHash(html),
      ...incoming.match
    };
    p = {
      id: incoming.id || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2,7)}`,
      match: inferred,
      buckets: {},
      metrics: { runs: 0, avgItems: 0, lastSeen: new Date().toISOString() }
    };
    // enforce cap (LRU by lastSeen)
    if (rec.profiles.length >= MAX_PROFILES) {
      rec.profiles.sort((a,b) => (a.metrics?.lastSeen || "").localeCompare(b.metrics?.lastSeen || ""));
      rec.profiles.shift();
    }
    rec.profiles.push(p);
  }

  // ---- Merge policy (holistic) ----
  // 1) Auto-mine generic hints from final HTML
  const mined = normalizeBuckets(mineCandidatesFromHtml(html));

  // 2) Normalize incoming
  const ib = normalizeBuckets({
    fields: incoming.buckets.fields,
    list:       [...(incoming.buckets.list||[]),       ...(mined.list||[])],
    anchors:    [...(incoming.buckets.anchors||[]),    ...(mined.anchors||[])],
    containers: [...(incoming.buckets.containers||[]), ...(mined.containers||[])],
    broad:      [...(incoming.buckets.broad||[]),      ...(mined.broad||[])],
    candidates: [...(incoming.buckets.candidates||[]), ...(mined.candidates||[])],
  });

  const nb = normalizeBuckets(p.buckets);
  const items = incoming.metrics?.items ?? 0;

  const mergeUniq = (a?: string[], b?: string[], capSize = 50) =>
    cap(Array.from(new Set([...(a||[]), ...(b||[])]).values()).filter(Boolean), capSize);

  // ✅ No-degrade rule: only adopt new `list` when we actually extracted items.
  const mergedList = items > 0 ? mergeUniq(nb.list, ib.list, CAPS.list) : nb.list;

  p.buckets = {
    fields: { ...(nb.fields||{}), ...(ib.fields||{}) },
    list: mergedList,
    anchors:    mergeUniq(nb.anchors,    ib.anchors,    CAPS.anchors),
    containers: mergeUniq(nb.containers, ib.containers, CAPS.containers),
    broad:      mergeUniq(nb.broad,      ib.broad,      CAPS.broad),
    candidates: mergeUniq(nb.candidates, ib.candidates, CAPS.candidates),
  };

  // metrics
  const runs = (p.metrics?.runs ?? 0) + 1;
  const prevAvg = p.metrics?.avgItems ?? 0;
  const avgItems = Math.round(((prevAvg * (runs - 1)) + items) / Math.max(runs, 1));
  p.metrics = { runs, avgItems, lastSeen: new Date().toISOString() };

  persist();
}

/* ===== Convenience (legacy compatibility) ===== */

export function getLearnedForHost(host: string): Buckets | null {
  const key = normalizeHost(host);
  const rec = learnedByHost[key];
  if (!rec?.profiles?.length) return null;
  // fallback = last profile (roughly most recent) without scoring context
  const p = rec.profiles[rec.profiles.length - 1];
  return normalizeBuckets(p.buckets);
}

export function saveLearnedForHost(host: string, payload: Buckets) {
  // keep legacy surface by upserting into a “default” profile
  upsertProfile(host, `https://${normalizeHost(host)}/`, "", {
    id: "default",
    buckets: payload
  });
}
