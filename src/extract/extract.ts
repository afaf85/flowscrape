// src/extract/extract.ts
import { load, Cheerio, CheerioAPI } from "cheerio";
import {
  resolvePrice,
  resolveTitle,
  resolveImage,
  resolveDescription,
} from "./resolvers";

/* ========================= constants ========================= */

const BAD_WRAPPERS = [
  "header",
  "footer",
  "nav",
  ".breadcrumbs",
  ".hero",
  ".carousel",
  ".slick-slider",
  ".owl-carousel",
  "[role='banner']",
  ".site-header",
  ".announcement-bar",
  "[data-sticky]",
];

const PRODUCTISH_CONTAINERS = [
  ".productGrid",
  ".product-grid",
  "[data-product-grid]",
  ".card-grid",
  ".products",
];

const PRODUCT_CARD_WRAPPERS = [
  ".product-card",
  ".product-grid__card",
  "[data-testid='product-card']",
  "[data-product-position]",
];

const DEBUG_EXTRACT = process.env.FLOWSCRAPE_DEBUG === "1";

/* ========================= typing ========================= */

type RuleObj = {
  sel?: string;
  attr?: string;
  text?: boolean;
  html?: boolean;
  textLen?: boolean;
};
type FieldRule = RuleObj | string[] | null | undefined;

type FieldPlan = {
  sels?: string[];
  attr?: string[];
  mode?: ("text" | "html")[];
};

/* ========================= helpers ========================= */

function isInBadWrapper($: CheerioAPI, el: Cheerio<any>) {
  return el.parents(BAD_WRAPPERS.join(",")).length > 0;
}

function isInProductish($: CheerioAPI, el: Cheerio<any>) {
  return el.parents(PRODUCTISH_CONTAINERS.join(",")).length > 0;
}

// REPLACE looksLikePdp with this:
function looksLikePdp(href: string) {
  if (!href) return false;
  const u = href.toLowerCase();

  // generic producty hints
  if (/\/product/.test(u) || /\/products?\//.test(u)) return true;

  // two+ path segments, not an obvious listing/filter route, has a slug/sku-ish token
  const path = u.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
  const segs = path.split("/").filter(Boolean);
  const listing = /(search|filter|category|collection|tag|sale|new|mens|womens|kids|home)\b/;
  if (segs.length >= 2 && !listing.test(path) && segs.some(s => /-/.test(s) || /\d{3,}/.test(s))) {
    return true;
  }
  return false;
}


function normalizeHref(href: string) {
  if (!href) return "";
  return href.replace(/#.*/, "");
}

function findNearestProductCard($: CheerioAPI, el: Cheerio<any>): Cheerio<any> {
  const wrapperSel = [
    ...PRODUCT_CARD_WRAPPERS,
    "[data-product]", "[data-item]", "[data-sku]",
    "[itemscope][itemtype*='Product']",
    ".grid__item", ".card", ".product", ".product-card", ".product-tile"
  ].join(",");
  if (el.is(wrapperSel)) return el;
  const parents = el.parents();
  for (let i = 0; i < parents.length; i++) {
    const p = parents.eq(i);
    if (p.is(wrapperSel)) return p;
  }
  return el;
}

function pickFirst(
  $: CheerioAPI,
  root: Cheerio<any>,
  selectors: string[]
): string | null {
  for (const s of selectors) {
    const el = root.find(s).first();
    if (!el.length) continue;

    const txt = el.text().trim();
    if (txt) return txt;

    const href = el.attr("href");
    if (href) return href.trim();

    const src = el.attr("src") || el.attr("data-src") || el.attr("data-srcset");
    if (src) return src.trim();
  }
  return null;
}

// REPLACE findAny with this:
function findAny($: CheerioAPI, root: Cheerio<any>, sels?: string[], cap = 200) {
  if (!sels?.length) return $([]);
  for (const s of sels) {
    try {
      const self = root.is(s) ? root : $([]);
      const found = self.length ? self : root.find(s);
      if (found.length) return $(found.slice(0, cap));
    } catch {
      // ignore bad selectors
    }
  }
  return $([]);
}


function getListNodes($: CheerioAPI, buckets?: any) {
  let list = $([]);
  list = list.add(findAny($, $.root(), buckets?.list));
  if (!list.length) list = list.add(findAny($, $.root(), buckets?.containers));
  return list;
}

// REPLACE getCardNodes with this version
function getCardNodes($: CheerioAPI, listNode: Cheerio<any>, buckets?: any) {
  // If the list node itself is an anchor, treat it as a card
  if (listNode.is("a[href]")) return listNode;

  // If it *contains* repeated anchors, prefer those
  const as = listNode.find("a[href]").slice(0, 200);
  if (as.length >= 6) return as;

  // Otherwise, try declared containers inside the list
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
  if (!cards.length) {
    // fallback: any element with children (grid items)
    cards = listNode.children().filter((_, el) => $(el).children().length > 0);
  }
  return cards;
}


// REPLACE planForField with this version
function planForField(
  name: string,
  learnedFields: Record<string, any> | undefined,
  buckets: any
): FieldPlan {
  const lf = learnedFields?.[name] || {};
  const sels = Array.isArray(lf.sel) ? lf.sel : lf.sel ? [lf.sel] : [];
  const composed = sels.length
    ? sels
    : [
        ...(buckets?.candidates || []),
        ...(buckets?.anchors || []),
        ...(buckets?.broad || []),
      ];

  // prepend "" so we check the card/anchor itself first
  const selsWithSelf = ["", ...composed];

  // default attribute preference
  let attr = lf.attr
    ? Array.isArray(lf.attr) ? lf.attr : [lf.attr]
    : ["href", "src", "data-src", "data-srcset", "content"];

  // ⬇️ SPECIAL-CASES
  // titles/descriptions: text/html only
  if (name === "title" || name === "description") attr = [];
  // price: text only (prevents "/sku/product/" being saved as price)
  if (name === "price") attr = [];

  const mode: ("text" | "html")[] =
    name === "title" || name === "description"
      ? (lf.html ? ["html"] : ["text"])
      : []; // href/image => no text fallback; price already text-only via attr=[]
  return { sels: selsWithSelf, attr, mode };
}

// REPLACE readField with this version
function readField(
  $: CheerioAPI,
  card: Cheerio<any>,
  plan: FieldPlan,
  _fieldName: string
) {
  if (!plan.sels?.length) return undefined;

  for (const s of plan.sels) {
    const el = s ? card.find(s).first() : card;
    if (!el.length) continue;

    // attributes first (unless plan.attr is empty)
    for (const a of plan.attr || []) {
      const v = el.attr(a);
      if (v) return v.trim();
    }

    // then read mode(s)
    for (const m of plan.mode || []) {
      if (m === "html") {
        const v = el.html();
        if (v) return v;
      } else {
        const v = el.text().trim();
        if (v) return v;
      }
    }
  }
  return undefined;
}


/* ========================= price helpers ========================= */

function normalizePriceText(txt: string): string | null {
  if (!txt) return null;
  // 🚫 ignore obvious URL/path-y stuff
  if (/https?:\/\//i.test(txt) || /\/[A-Za-z0-9._-]/.test(txt)) return null;

  const cleaned = txt.replace(/\s+/g, " ").trim();

  // Common currency symbols/variants
  const m1 = cleaned.match(/(?:C?A?\$|US\$|\$)\s*\d[\d,]*(?:\.\d{2})?/i);
  if (m1) return m1[0].replace(/\s+/g, "");

  // 12.34 CAD / CAD 12.34 / USD 12.34
  const m2 = cleaned.match(/(?:CAD|CA|USD)\s*\d[\d,]*(?:\.\d{2})?/i);
  if (m2)
    return m2[0]
      .replace(/\s+/g, "")
      .replace(/^(CAD|CA|USD)/i, "$");

  // “Now $99.99”, “From $50”
  const m3 = cleaned.match(/(?:Now|From)\s*(?:C?A?\$|US\$|\$)\s*\d[\d,]*(?:\.\d{2})?/i);
  if (m3)
    return m3[0]
      .replace(/^(Now|From)\s*/i, "")
      .replace(/\s+/g, "");

  // Ranges: $50 – $70 → pick lower
  const m4 = cleaned.match(
    /(?:C?A?\$|US\$|\$)\s*\d[\d,]*(?:\.\d{2})?\s*[–-]\s*(?:C?A?\$|US\$|\$)\s*\d[\d,]*(?:\.\d{2})?/
  );
  if (m4) {
    const low = m4[0].match(/(?:C?A?\$|US\$|\$)\s*\d[\d,]*(?:\.\d{2})?/);
    if (low) return low[0].replace(/\s+/g, "");
  }

  return null;
}

function findDeepPrice($: CheerioAPI, root: Cheerio<any>): string | null {
  const DEBUG = process.env.FLOWSCRAPE_DEBUG === "1";

  // First, targeted Nike-ish selectors if present
  const nikePrice = root
    .find(
      ".product-card__price [data-testid='product-price'], .product-card__price [class*='product-price'], .product-card__price, .css-196r7ux"
    )
    .first()
    .text()
    .trim();
  const nikeNorm = normalizePriceText(nikePrice);
  if (nikeNorm) {
    if (DEBUG) console.log("[extract:debug] nike price hit:", nikePrice);
    return nikeNorm;
  }

  // Price-ish generic scan
  const priceish = root.find(
    ".product-price, .product-card__price, .product-card__price-wrapper, .css-196r7ux, [data-testid*='price'], [class*='price']"
  );

  if (DEBUG) {
    console.log(
      `[extract:debug] found ${priceish.length} price-ish nodes in card`,
      priceish
        .map((_, e) => $(e).text().trim())
        .get()
        .slice(0, 5)
    );
  }

  const candidates = priceish.length ? priceish : root.find("*");
  const MAX_SCAN = 140;

  let scanned = 0;
  for (const el of candidates.toArray()) {
    if (scanned++ > MAX_SCAN) break;
    const $el = $(el);
    const txt = $el.text().trim();
    const norm = normalizePriceText(txt);
    if (norm) return norm;
  }

  return null;
}

function readPrice($: CheerioAPI, card: Cheerio<any>, plan: FieldPlan) {
  const raw = readField($, card, plan, "price");
  if (!raw) return undefined;
  const txt = String(raw);
  return normalizePriceText(txt) ?? txt;
}

/* ========================= image helpers ========================= */

function pickBestSrc(v?: string) {
  if (!v) return v;
  // Handle srcset
  if (v.includes(",")) {
    const first = v.split(",")[0].trim();
    const url = first.split(" ")[0];
    return url;
  }
  // Avoid massive data URIs
  if (v.startsWith("data:")) return undefined;
  return v;
}

/* ========================= JSON-LD ========================= */

function collectProductsFromLd(node: any, out: any[]) {
  if (!node || typeof node !== "object") return;

  if (node["@type"] === "Product") {
    out.push(node);
  }

  if (node["@type"] === "ItemList" && Array.isArray(node.itemListElement)) {
    for (const el of node.itemListElement) {
      const it = el?.item || el;
      if (it) collectProductsFromLd(it, out);
    }
  }

  if (Array.isArray(node["@graph"])) {
    for (const g of node["@graph"]) {
      collectProductsFromLd(g, out);
    }
  }
}

function extractFromJsonLd(
  html: string,
  fields: Record<string, FieldRule>
): any[] {
  const $ = load(html);
  const results: any[] = [];

  const scripts = $("script[type='application/ld+json']").toArray();
  const blobs: any[] = [];
  for (const s of scripts) {
    const txt = $(s).contents().text();
    if (!txt) continue;
    try {
      const parsed = JSON.parse(txt);
      if (Array.isArray(parsed)) blobs.push(...parsed);
      else blobs.push(parsed);
    } catch {
      // ignore malformed json-ld
    }
  }

  const products: any[] = [];
  for (const b of blobs) collectProductsFromLd(b, products);

  for (const p of products) {
    const item: Record<string, any> = {};

    for (const [name] of Object.entries(fields || {})) {
      if (name === "title" || name === "name") {
        const v = (p as any).name || (p as any).title;
        if (v) item.title = String(v).trim();
        continue;
      }

      if (name === "price") {
        const v =
          (p as any).offers?.price ??
          (Array.isArray((p as any).offers)
            ? (p as any).offers[0]?.price
            : undefined) ??
          (p as any).price;
        if (v != null) {
          const txt = String(v);
          item.price = normalizePriceText(txt) ?? txt;
        }
        continue;
      }

      if (name === "image") {
        const img = Array.isArray((p as any).image)
          ? (p as any).image[0]
          : (p as any).image;
        if (img) item.image = String(img);
        continue;
      }

      if (name === "href") {
        const url = (p as any).url || (p as any)["@id"];
        if (url) item.href = String(url);
        continue;
      }

      const v = (p as any)[name];
      if (v != null) item[name] = v;
    }

    if (Object.keys(item).length) results.push(item);
  }

  // light dedupe/normalize
  const byHref: Record<string, any> = {};
  for (const it of results.slice(0, 600)) {
    const hrefNorm = normalizeHref(String(it.href || ""));
    const key = hrefNorm || `__idx_${Object.keys(byHref).length}`;
    const cur = byHref[key];
    if (!cur) byHref[key] = it;
    else if (Object.keys(it).length > Object.keys(cur).length) byHref[key] = it;
  }
  return Object.values(byHref).slice(0, 150);
}

/* ========================= scoring helpers ========================= */

function publicFieldCount(obj: Record<string, any>) {
  return Object.keys(obj).filter((k) => !k.startsWith("_")).length;
}

/* ========================= main extractor ========================= */

export function extractItems(
  html: string,
  listSelectors: string[],
  fields: Record<string, FieldRule>,
  learned?: any
): any[] {
  const $ = load(html);
  const raw: any[] = [];

  const buckets = learned?.buckets || {};
  const learnedLists = getListNodes($, buckets);
  const lists: Cheerio<any>[] = [];
  if (learnedLists.length) {
    learnedLists.each((_, n) => { lists.push($(n)); });
    // or: learnedLists.each((_, n) => void lists.push($(n)));
  }

  if (!lists.length && Array.isArray(listSelectors) && listSelectors.length) {
    for (const sel of listSelectors) {
      try {
        const nodes = $(sel);
        if (nodes.length) nodes.each((_, n) => { lists.push($(n)); });
        // or: nodes.each((_, n) => void lists.push($(n)));
      } catch {
        // ignore bad selector
      }
    }
  }

  if (!lists.length) {
    // No lists detected — fall back to JSON-LD
    return extractFromJsonLd(html, fields || {});
  }

  const learnedFields = (buckets && buckets.fields) || {};
  const plans: Record<string, FieldPlan> = {};
  for (const name of Object.keys(fields || {})) {
    plans[name] = planForField(name, learnedFields, buckets);
  }
  for (const core of ["title", "price", "image", "href", "description"]) {
    if (!plans[core]) plans[core] = planForField(core, learnedFields, buckets);
  }

  let debugPrinted = false;

  for (const ln of lists) {
    const cards = getCardNodes($, ln, buckets);
    cards.each((_, el) => {
      // Optionally tighten to nearest product-card
      const card = findNearestProductCard($, $(el));
      const item: Record<string, any> = {};

      // read fields (learned-first)
      const titleRaw = readField($, card, plans.title, "title");
      if (titleRaw) item.title = String(titleRaw).trim();

      const hrefRaw = readField($, card, plans.href, "href");
      if (hrefRaw) item.href = String(hrefRaw).trim();

      const imgRaw = readField($, card, plans.image, "image");
      if (imgRaw) item.image = pickBestSrc(String(imgRaw));

      const descRaw = readField($, card, plans.description, "description");
      if (descRaw) item.description = String(descRaw);

      const p = readPrice($, card, plans.price);
      if (p) item.price = p;

      // --- ANCHOR-AWARE FALLBACKS ---
      const isAnchor = card.is("a[href]");

      // href
      if (!item.href && isAnchor) {
        const h = card.attr("href");
        if (h) item.href = h.trim();
      }

      // title
      if (!item.title) {
        if (isAnchor) {
          const t = card.text().trim();
          if (t) item.title = t;
        } else {
          const t = card.find("h1,h2,h3,[itemprop='name'],.title,.name,a").first().text().trim();
          if (t) item.title = t;
        }
      }

      // image
      if (!item.image) {
        const img = (isAnchor ? card : card.find("a, img"))
          .find("img[data-src], img[src], img[srcset]")
          .first();
        const src =
          img.attr("data-src") ||
          img.attr("src") ||
          (img.attr("srcset") || "").split(",")[0]?.trim().split(/\s+/)[0];
        if (src) item.image = pickBestSrc(src);
      }

      // price (shallow)
      if (!item.price) {
        const shallowPrice = card.find("[class*='price'], [data-price], [data-testid*='price']").first().text().trim();
        const norm = normalizePriceText(shallowPrice);
        if (norm) item.price = norm;
      }

      // --- SANITIZERS FOR MISASSIGNED FIELDS ---
      function isUrlish(s?: string) {
        if (!s) return false;
        return /^(https?:)?\/\//i.test(s) || s.startsWith("/") || s.startsWith("./");
      }

      function likelyImagePath(s?: string) {
        if (!s) return false;
        return /\.(jpg|jpeg|png|webp|gif|avif)(\?|#|$)/i.test(s);
      }

      // quick field cleanup before resolvers
      if (item.price && isUrlish(item.price)) {
        item.price = undefined; // invalid, retry in resolver
      }

      if (!item.image) {
        const img = card.find("img[data-src], img[srcset], img[src]").first();
        const c =
          img.attr("data-src") ||
          (img.attr("srcset") || "").split(",")[0]?.trim().split(/\s+/)[0] ||
          img.attr("src");
        if (c) item.image = pickBestSrc(c);
      }

      if (!item.href) {
        const a = card.is("a[href]") ? card : card.find("a[href]").first();
        const h = a.attr("href");
        if (h) item.href = h.trim();
      }



      // resolvers (fallbacks)
      if (!item.title) {
        const rt = resolveTitle($, card, { learned, fields, $doc: $ });
        if (rt?.value) item.title = rt.value;
      }
      if (!item.image) {
        const ri = resolveImage($, card, { learned, fields, $doc: $ });
        if (ri?.value) item.image = pickBestSrc(String(ri.value));
      }
      if (!item.price) {
        const deep = findDeepPrice($, card);
        if (deep) item.price = deep;
        else {
          const rp = resolvePrice($, card, { learned, fields, $doc: $ });
          if (rp?.value) item.price = rp.value;
        }
      }
      if (!item.description) {
        const rd = resolveDescription($, card, { learned, fields, $doc: $ });
        if (rd?.value) item.description = rd.value;
      }

      // guard over-long stuff
      if (item.description && String(item.description).length > 1200) {
        item.description = String(item.description).slice(0, 1200);
      }
      if (item.title && item.title.length > 200) {
        item.title = item.title.slice(0, 200);
      }

      if (DEBUG_EXTRACT && !debugPrinted) {
        console.log(
          "[extract:debug] learned-first: list size",
          lists.length,
          "cards",
          cards.length
        );
        console.log("[extract:debug] card classes:", card.attr("class"));
        console.log("[extract:debug] built item (pre-score):", item);
        debugPrinted = true;
      }

      raw.push({ ...item, _node: card });
    });
  }

  // SCORING + DEDUPE
  const byHref: Record<string, any> = {};

  for (const r of raw) {
    const node: Cheerio<any> = r._node;
    delete r._node;

    const hrefNorm = normalizeHref(r.href || "");
    const title = (r.title || "").trim();
    const price = (r.price || "").trim();

    // drop obvious non-PDPs
    if (/\/search\/?#\/filter:/i.test(hrefNorm)) continue;

    // if title equals price, price is probably wrong
    if (title && price && title === price) {
      r.price = undefined;
    }

    let score = 0;
    if (hrefNorm && looksLikePdp(hrefNorm)) score += 3;
    if (isInProductish($, node)) score += 2;
    if (r.image && title) score += 1;
    if (r.price) score += 1;
    if (isInBadWrapper($, node)) score -= 2;
    if (!title || title.length > 120) score -= 1;
    if (!hrefNorm) score -= 1;

    if (score < 1) continue;

    r._score = score;

    const key = hrefNorm || `__idx_${Object.keys(byHref).length}`;
    const existing = byHref[key];

    if (!existing) {
      byHref[key] = r;
    } else {
      const existingFields = publicFieldCount(existing);
      const newFields = publicFieldCount(r);
      if (r._score > existing._score || newFields > existingFields) {
        byHref[key] = r;
      }
    }
  }

  const out = Object.values(byHref);

  return out.slice(0, 150);
}
