// src/extract/resolvers.ts
import { CheerioAPI, Cheerio } from "cheerio";

type ResolverCtx = {
  learned?: any;
  fields?: any;
  $doc?: CheerioAPI; // for page-level meta/ld
};

const DEBUG = process.env.FLOWSCRAPE_DEBUG === "1";

/* ==================== helpers ==================== */

function log(...args: any[]) {
  if (DEBUG) console.log("[resolvers:debug]", ...args);
}

function firstUrlFromSrcset(srcset?: string | null): string | null {
  if (!srcset) return null;
  const first = srcset.split(",")[0]?.trim() ?? "";
  const url = first.split(/\s+/)[0];
  return url || null;
}

function textOf($: CheerioAPI, el: Cheerio<any>): string {
  return el.text().replace(/\s+/g, " ").trim();
}

function attrOf(el: Cheerio<any>, names: string[]): string | null {
  for (const n of names) {
    const v = el.attr(n);
    if (v) return v.trim();
  }
  return null;
}

/** A bit more forgiving; returns a normalized money string when possible. */
function normalizePriceText(txt: string): string | null {
  if (!txt) return null;
  const cleaned = txt.replace(/\s+/g, " ").trim();

  // Common currency symbols / variants, incl. CA$, C$, US$, €, £
  const m1 = cleaned.match(
    /(?:C?A?\$|US\$|\$|€|£)\s*\d[\d,]*(?:[.,]\d{2})?/i
  );
  if (m1) return m1[0].replace(/\s+/g, "");

  // Suffix currency codes: 12.34 CAD / CAD 12.34 / USD 12.34
  const m2 = cleaned.match(
    /(?:(?:CAD|CA|USD|EUR|GBP)\s*\d[\d,]*(?:[.,]\d{2})?|\d[\d,]*(?:[.,]\d{2})?\s*(?:CAD|CA|USD|EUR|GBP))/i
  );
  if (m2) {
    // Normalize to leading symbol when possible; otherwise keep as-is
    const s = m2[0].replace(/\s+/g, "");
    // CAD123.45 or 123.45CAD → $123.45 (best effort)
    const num = s.replace(/^(CAD|CA|USD|EUR|GBP)/i, "").replace(/(CAD|CA|USD|EUR|GBP)$/i, "");
    if (/^\d/.test(num)) return "$" + num;
    return s;
  }

  // “Now $99.99”, “From $50”, “As low as $12”
  const m3 = cleaned.match(
    /(?:Now|From|As\s+low\s+as)\s*(?:C?A?\$|US\$|\$|€|£)\s*\d[\d,]*(?:[.,]\d{2})?/i
  );
  if (m3) return m3[0].replace(/^(Now|From|As\s+low\s+as)\s*/i, "").replace(/\s+/g, "");

  // Ranges: $50 – $70 → pick lower
  const m4 = cleaned.match(
    /(?:C?A?\$|US\$|\$|€|£)\s*\d[\d,]*(?:[.,]\d{2})?\s*[–-]\s*(?:C?A?\$|US\$|\$|€|£)\s*\d[\d,]*(?:[.,]\d{2})?/
  );
  if (m4) {
    const low = m4[0].match(/(?:C?A?\$|US\$|\$|€|£)\s*\d[\d,]*(?:[.,]\d{2})?/);
    if (low) return low[0].replace(/\s+/g, "");
  }

  // Plain number near price-y keywords (last resort): “Price 49.99”, “from 12,99”
  const nearPrice = cleaned.match(
    /\b(price|from|now|as\s+low\s+as|our\s+price)\b[^0-9]{0,12}(\d[\d,]*(?:[.,]\d{2})?)/i
  );
  if (nearPrice) return "$" + nearPrice[2].replace(/\s+/g, "");

  return null;
}

function extractMoney(txt: string): string | null {
  if (!txt) return null;
  const norm = normalizePriceText(txt);
  return norm || null;
}

function extractJsonLdProducts($: CheerioAPI): any[] {
  const out: any[] = [];
  $("script[type='application/ld+json']")
    .toArray()
    .forEach((s) => {
      const txt = $(s).contents().text();
      if (!txt) return;
      try {
        const parsed = JSON.parse(txt);
        const arr = Array.isArray(parsed) ? parsed : [parsed];
        for (const node of arr) collectLd(node, out);
      } catch {
        /* ignore malformed ld-json */
      }
    });
  return out;
}

function collectLd(node: any, out: any[]) {
  if (!node || typeof node !== "object") return;

  if (node["@type"] === "Product") out.push(node);

  if (Array.isArray(node["@graph"])) {
    for (const g of node["@graph"]) collectLd(g, out);
  }

  if (node["@type"] === "ItemList" && Array.isArray(node.itemListElement)) {
    for (const el of node.itemListElement) {
      const it = el?.item ?? el;
      collectLd(it, out);
    }
  }
}

/* Resolve learned rules into selector array (accepts flexible forms) */
function toSelectorArray(rule: any): string[] {
  return Array.isArray(rule)
    ? rule
    : rule?.sel
    ? [rule.sel]
    : typeof rule === "string"
    ? [rule]
    : [];
}

/* ==================== resolvers ==================== */

export function resolvePrice(
  $: CheerioAPI,
  card: Cheerio<any>,
  ctx: ResolverCtx = {}
): { value: string; score: number; source: string } | null {
  // 0) PAGE-LEVEL STRUCTURED DATA
  if (ctx.$doc) {
    const products = extractJsonLdProducts(ctx.$doc);
    if (products.length) {
      const p = products[0];
      const price =
        p?.offers?.price ??
        (Array.isArray(p?.offers) ? p.offers[0]?.price : null) ??
        p?.price;
      if (price != null) {
        const val = String(price);
        const norm = normalizePriceText(val) ?? val;
        log("ldjson price", norm);
        return { value: norm, score: 0.95, source: "ldjson" };
      }
    }
  }

  // 1) CARD-LEVEL price-ish selectors (broadened)
  const PRICE_SEL = [
    "[data-price]",
    "[data-price-amount]",
    "[itemprop='price']",
    "[data-testid*='price']",
    ".price,.prices",
    ".price__current,.price__value",
    ".price--main,.price--large",
    ".product-price,.product__price,.product-card__price,.product-price__price",
    ".money,.amount",
    ".pc__as-low-as" // HPG Brands
  ].join(",");

  // Prefer nearest visible/short price
  let priceNode = card.find(PRICE_SEL).filter((_, el) => !!textOf($, $(el))).first();
  if (!priceNode.length) {
    // Sometimes price is on the same row container
    priceNode = card.parent().find(PRICE_SEL).filter((_, el) => !!textOf($, $(el))).first();
  }
  if (priceNode.length) {
    const money = extractMoney(textOf($, priceNode));
    if (money) {
      log("card/parent price", money);
      return { value: money, score: 0.9, source: "card" };
    }
  }

  // 2) LEARNED (host-specific)
  const learnedSelectors = toSelectorArray(ctx.learned?.fields?.price ?? ctx.learned?.price);
  for (const sel of learnedSelectors) {
    const n = card.find(sel).first();
    if (!n.length) continue;
    const money = extractMoney(textOf($, n));
    if (money) {
      log("learned price", sel, money);
      return { value: money, score: 0.78, source: "learned" };
    }
  }

  // 3) FALLBACK: look for anchors with price-ish sibling text
  const linkNearby = card.find("a:has(.price), a:has([itemprop='price']), a:has(.money)").first();
  if (linkNearby.length) {
    const money = extractMoney(textOf($, linkNearby));
    if (money) return { value: money, score: 0.7, source: "link-near-price" };
  }

  // 4) FINAL: regex over card text
  const rawTxt = textOf($, card);
  const m = extractMoney(rawTxt);
  if (m) {
    log("regex price", m);
    return { value: m, score: 0.6, source: "regex" };
  }

  return null;
}

export function resolveTitle(
  $: CheerioAPI,
  card: Cheerio<any>,
  ctx: ResolverCtx = {}
): { value: string; score: number; source: string } | null {
  // Rich set of common title selectors
  const TITLE_SEL = [
    ".product-card__title",
    ".card__heading a",
    ".card__heading",
    ".product-title",
    "a.full-unstyled-link",
    "h3 a,h3,.card-title a,.card-title",
    ".tile-title a,.tile-title",
    ".product-item__title a,.product-item__title"
  ].join(",");

  let el = card.find(TITLE_SEL).first();

  // If not found, try anchor with product-ish class inside the card
  if (!el.length) el = card.find("a[href*='/product'], a[href*='/products/']").first();

  if (!el.length) {
    // Walk up a level: some grids wrap titles in sibling nodes
    const parent = card.parent();
    if (parent && parent.length) el = parent.find(TITLE_SEL).first();
  }

  if (el.length) {
    const v = textOf($, el);
    if (v) return { value: v, score: 0.9, source: "card" };
  }

  // learned
  const sels = toSelectorArray(ctx.learned?.fields?.title ?? ctx.learned?.title);
  for (const sel of sels) {
    const n = card.find(sel).first();
    if (!n.length) continue;
    const v = textOf($, n);
    if (v) return { value: v, score: 0.72, source: "learned" };
  }

  // last resort: first link text that looks name-ish
  const a = card.find("a[href]").filter((_, e) => {
    const t = textOf($, $(e));
    return t.length >= 3 && t.length <= 120;
  }).first();
  if (a.length) {
    const v = textOf($, a);
    if (v) return { value: v, score: 0.6, source: "anchor" };
  }

  return null;
}

export function resolveImage(
  $: CheerioAPI,
  card: Cheerio<any>,
  ctx: ResolverCtx = {}
): { value: string; score: number; source: string } | null {
  // Prefer inside card
  let img = card.find("img[srcset], img[data-srcset], img[src], img[data-src]").first();

  if (!img.length) {
    // Sometimes image is on the sibling container
    const parent = card.parent();
    if (parent && parent.length) {
      img = parent.find("img[srcset], img[data-srcset], img[src], img[data-src]").first();
    }
  }

  if (img.length) {
    const srcset = attrOf(img, ["srcset", "data-srcset"]);
    const srcFromSet = firstUrlFromSrcset(srcset || "");
    const src = srcFromSet || attrOf(img, ["src", "data-src"]) || null;
    if (src && !src.startsWith("data:")) return { value: src, score: 0.9, source: "img" };
  }

  // learned image
  const sels = toSelectorArray(ctx.learned?.fields?.image ?? ctx.learned?.image);
  for (const sel of sels) {
    const n = card.find(sel).first();
    if (!n.length) continue;
    const viaSrcset = firstUrlFromSrcset(attrOf(n, ["srcset", "data-srcset"]) || "");
    const viaAttr = attrOf(n, ["src", "data-src"]);
    const v = viaSrcset || viaAttr || textOf($, n);
    if (v && !String(v).startsWith("data:")) return { value: v, score: 0.65, source: "learned" };
  }

  // fallback: background-image inline style
  const bg = card.find("[style*='background-image']").first();
  if (bg.length) {
    const style = bg.attr("style") || "";
    const m = style.match(/url\((['"]?)(.*?)\1\)/i);
    if (m?.[2]) return { value: m[2], score: 0.55, source: "bg-style" };
  }

  return null;
}

export function resolveDescription(
  $: CheerioAPI,
  card: Cheerio<any>,
  ctx: ResolverCtx = {}
): { value: string; score: number; source: string } | null {
  // card-level short copy (skip obvious CTA noise)
  let p = card.find(".subtitle, .product-card__subtitle, .card__subtitle, p").filter((_, e) => {
    const t = textOf($, $(e));
    return t && !/add to cart|wishlist|compare|quick view|view details/i.test(t);
  }).first();

  if (!p.length) {
    // sometimes next to title
    const t = card.find("h3, .card__heading, .product-card__title").first();
    if (t.length) {
      p = t.parent().find("p, .subtitle, .card__subtitle").filter((_, e) => {
        const s = textOf($, $(e));
        return s && s.length >= 10 && s.length <= 240;
      }).first();
    }
  }

  if (p.length) {
    const v = textOf($, p);
    if (v) return { value: v, score: 0.75, source: "card" };
  }

  // page-level meta
  if (ctx.$doc) {
    const meta =
      ctx.$doc("meta[name='description']").attr("content") ||
      ctx.$doc("meta[property='og:description']").attr("content");
    if (meta) return { value: meta.trim(), score: 0.55, source: "meta" };
  }

  return null;
}
