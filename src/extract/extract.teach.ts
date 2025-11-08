// src/extract/extract.teach.ts
import { load, Cheerio, CheerioAPI } from "cheerio";

/* ---------------- helpers (neutral) ---------------- */

type RuleObj = { sel?: string | string[]; attr?: string | string[]; html?: boolean };
export type FieldRule = RuleObj | string[] | null | undefined;
type FieldPlan = { sels: string[]; attr: string[]; mode: ("text" | "html")[] };

const hasTitleHref = (x: any): x is { title: any; href: any } => !!(x && x.title && x.href);

function normalizeHref(href: string) {
  if (!href) return "";
  return href.replace(/#.*/, "");
}

function pickBestSrc(v?: string) {
  if (!v) return v;
  if (v.includes(",")) {
    const first = v.split(",")[0].trim();
    const url = first.split(" ")[0];
    return url;
  }
  if (v.startsWith("data:")) return undefined;
  return v;
}

function normalizePriceText(txt: string): string | null {
  if (!txt) return null;
  // guard against URL/path-like garbage
  if (/https?:\/\//i.test(txt) || /\/[A-Za-z0-9._-]/.test(txt)) return null;

  const cleaned = txt.replace(/\s+/g, " ").trim();

  // $9.99, CA$9.99, US$9.99
  const m1 = cleaned.match(/(?:C?A?\$|US\$|\$)\s*\d[\d,]*(?:\.\d{2})?/i);
  if (m1) return m1[0].replace(/\s+/g, "");

  // CAD 9.99, USD 9.99, CA 9.99
  const m2 = cleaned.match(/(?:CAD|CA|USD)\s*\d[\d,]*(?:\.\d{2})?/i);
  if (m2) return m2[0].replace(/\s+/g, "").replace(/^(CAD|CA|USD)/i, "$");

  // "Now $9.99" / "From $9.99"
  const m3 = cleaned.match(/(?:Now|From)\s*(?:C?A?\$|US\$|\$)\s*\d[\d,]*(?:\.\d{2})?/i);
  if (m3) return m3[0].replace(/^(Now|From)\s*/i, "").replace(/\s+/g, "");

  // ranges: $9.99 - $19.99 → pick low end
  const m4 = cleaned.match(
    /(?:C?A?\$|US\$|\$)\s*\d[\d,]*(?:\.\d{2})?\s*[–-]\s*(?:C?A?\$|US\$|\$)\s*\d[\d,]*(?:\.\d{2})?/
  );
  if (m4) {
    const low = m4[0].match(/(?:C?A?\$|US\$|\$)\s*\d[\d,]*(?:\.\d{2})?/);
    if (low) return low[0].replace(/\s+/g, "");
  }
  return null;
}

function looksLikePathOrUrl(s?: string) {
  return !!s && (/^(https?:)?\/\//i.test(s) || /\/[A-Za-z0-9._-]/.test(s));
}
function looksLikeImagePath(s?: string) {
  return !!s && /\.(png|jpe?g|webp|gif|avif)(\?|#|$)/i.test(s);
}

/** Try selectors in order. If `s` is invalid, skip. Returns up to `cap` matches. */
function findAny($: CheerioAPI, root: Cheerio<any>, sels?: string[] | string, cap = 200) {
  const arr = Array.isArray(sels) ? sels : (sels ? [sels] : []);
  if (!arr.length) return $([]);
  for (const s of arr) {
    try {
      const self = root.is(s) ? root : $([]);
      const found = self.length ? self : root.find(s);
      if (found.length) return $(found.slice(0, cap));
    } catch {
      /* ignore invalid selectors */
    }
  }
  return $([]);
}

/** In teach mode, buckets.list is the primary source of truth */
function getListNodes($: CheerioAPI, buckets: any) {
  let list = $([]);
  list = list.add(findAny($, $.root(), buckets?.list));
  if (!list.length) list = list.add(findAny($, $.root(), buckets?.anchors));
  if (!list.length) list = list.add(findAny($, $.root(), buckets?.containers));
  return list;
}

/** Given a list node, decide which sub-nodes are the “cards” */
function getCardNodes($: CheerioAPI, listNode: Cheerio<any>, buckets: any) {
  // If the list node itself is an anchor (or filled with anchors), treat anchors as cards
  const anchors = listNode.find("a[href]").slice(0, 200);
  if (listNode.is("a[href]") || anchors.length >= 6) return anchors.length ? anchors : listNode;

  // Else try declared containers/candidates inside the list
  let cards = findAny($, listNode, buckets?.containers);
  if (!cards.length) {
    const cand = findAny($, listNode, buckets?.candidates);
    if (cand.length) {
      cards = $(
        cand
          .toArray()
          .map((e) => $(e).parent()[0])
          .filter(Boolean)
      );
    }
  }

  // Final fallback: direct children with children
  if (!cards.length) {
    cards = listNode.children().filter((_, el) => $(el).children().length > 0);
  }
  return cards;
}

/** Build a simple plan (selectors, attrs, text/html) for a given field */
function planForField(name: string, learnedFields: Record<string, any> | undefined, buckets: any): FieldPlan {
  const lf = learnedFields?.[name] || {};
  const sels = Array.isArray(lf.sel) ? lf.sel : lf.sel ? [lf.sel] : [];

  const composed = sels.length
    ? sels
    : [
        ...(buckets?.candidates || []),
        ...(buckets?.anchors || []),
        ...(buckets?.broad || []),
      ];

  // prepend "" to allow checking the card itself first
  const selsWithSelf = ["", ...composed];

  let attr = lf.attr
    ? (Array.isArray(lf.attr) ? lf.attr : [lf.attr])
    : ["href", "src", "data-src", "data-srcset", "content"];

  let mode: ("text" | "html")[] = [];

  if (name === "title" || name === "description") {
    // Prefer text by default; only use attrs if explicitly requested
    if (!lf.attr) attr = [];
    mode = lf.html ? ["html"] : ["text"];
  }

  // price: prefer text only to avoid path-looking attrs
  if (name === "price") attr = [];

  return { sels: selsWithSelf, attr, mode };
}

/** Read a field’s value from a card, trying plan.sels -> plan.attr -> plan.mode */
function readField($: CheerioAPI, card: Cheerio<any>, plan: FieldPlan, fieldName?: string) {
  if (!plan.sels.length) return undefined;

  for (const s of plan.sels) {
    const el = s ? card.find(s).first() : card;
    if (!el.length) continue;

    // Prefer attributes if provided
    for (const a of plan.attr || []) {
      const isSrcset = a === "srcset" || a === "data-srcset";
      const raw = isSrcset
        ? el.attr(a)?.split(",")[0]?.trim()?.split(/\s+/)[0]
        : el.attr(a)?.trim();
      if (!raw) continue;

      // guard: avoid leaking hrefs into non-href fields
      if (fieldName && fieldName !== "href" && looksLikePathOrUrl(raw)) {
        if (fieldName === "image" && looksLikeImagePath(raw)) return pickBestSrc(raw);
        continue;
      }
      return isSrcset ? raw : raw;
    }

    // Then try text/html based on the plan
    for (const m of plan.mode || []) {
      const v = (m === "html") ? el.html() : el.text().trim();
      if (!v) continue;

      // skip sluggy strings in text fields
      if (fieldName && (fieldName === "title" || fieldName === "description") && looksLikePathOrUrl(v)) {
        continue;
      }
      return v;
    }
  }
  return undefined;
}

/* ---------------- main teach extractor ---------------- */

/**
 * Strict extract using ONLY learned buckets/fields (no resolvers/JSON-LD fallback).
 *
 * @param html  The page HTML
 * @param args  { buckets, fields, listSelectors?, cap? }
 *              - buckets.list is the primary source of truth for “list nodes”
 *              - listSelectors is an optional fallback if buckets.list yields nothing
 */
export function extractTeachItems(
  html: string,
  args: {
    buckets: any;                      // learned.buckets from learned.json
    fields: Record<string, FieldRule>; // learned.fields from learned.json (or {})
    listSelectors?: string[];          // optional fallback selectors
    cap?: number;                      // optional max items (default 150)
  }
): any[] {
  const { buckets, fields, listSelectors, cap = 150 } = args;
  const $ = load(html);

  // Lists from learned buckets first; optional manual fallback
  const listNodes = getListNodes($, buckets);
  const lists: Cheerio<any>[] = [];
  if (listNodes.length) {
    listNodes.each((_, n) => { lists.push($(n)); });
  } else if (Array.isArray(listSelectors) && listSelectors.length) {
    for (const sel of listSelectors) {
      try {
        const nodes = $(sel);
        if (nodes.length) {
          nodes.each((_, n) => { lists.push($(n)); });
        }
      } catch {
        /* ignore invalid */
      }
    }
  }
  if (!lists.length) return []; // teach mode: no JSON-LD fallback

  // Build field plans — merge fields from buckets + explicit fields arg
  const learnedFields = { ...(buckets as any)?.fields, ...(fields as any) };
  const plans: Record<string, FieldPlan> = {};
  for (const name of Object.keys(fields || {})) {
    plans[name] = planForField(name, learnedFields, buckets);
  }
  for (const core of ["title", "price", "image", "href", "description"]) {
    if (!plans[core]) plans[core] = planForField(core, learnedFields, buckets);
  }

  // Extract strictly (no resolvers/fallbacks)
  const raw: any[] = [];
  for (const ln of lists) {
    const cards = getCardNodes($, ln, buckets);
    cards.each((_, el) => {
      const card = $(el);
      const item: Record<string, any> = {};

      const titleRaw = readField($, card, plans.title, "title");
      if (titleRaw) item.title = String(titleRaw).trim();

      const hrefRaw = readField($, card, plans.href, "href");
      if (hrefRaw) item.href = String(hrefRaw).trim();

      const imgRaw = readField($, card, plans.image, "image");
      if (imgRaw) item.image = pickBestSrc(String(imgRaw));

      const descRaw = readField($, card, plans.description, "description");
      if (descRaw) item.description = String(descRaw);

      const priceRaw = readField($, card, plans.price, "price");
      if (priceRaw) {
        const norm = normalizePriceText(String(priceRaw));
        item.price = norm ?? String(priceRaw);
      }

      raw.push(item);
    });
  }

  // Deduplicate and lightly sanitize by href (preserve the item with more filled fields)
  const byHref: Record<string, any> = {};
  for (const it of raw) {
    const hrefNorm = normalizeHref(String(it.href || ""));
    const key = hrefNorm || `__idx_${Object.keys(byHref).length}`;
    if (!byHref[key]) {
      byHref[key] = it;
    } else {
      const a = Object.keys(byHref[key]).length;
      const b = Object.keys(it).length;
      if (b > a) byHref[key] = it;
    }
  }

  const out = Object.values(byHref).slice(0, cap);
  return out;
}
