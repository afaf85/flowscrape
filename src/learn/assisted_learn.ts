// Lightweight "suggestion engine": from a single HTML snapshot,
// propose field selectors + a few list/container anchors.
// It’s deterministic (no LLM), fast, and safe to run on-demand.

import { load, CheerioAPI } from "cheerio";
import type { AnyNode, Element } from "domhandler";
import { isTag } from "domhandler";


export type AssistInput = {
  url: string;
  html: string;
  // optionally pass seeds from autodetect/learned to bias proposals
  seeds?: {
    list?: string[];
    fields?: Record<string, { sel: string; attr?: string }>;
  };
};

export type AssistOutput = {
  suggestedFields: Record<string, { sel: string; attr?: string; confidence: number }>;
  suggestedBuckets: {
    anchors: string[];
    containers: string[];
    candidates: string[];
  };
  notes: string[];
};

const FIELD_HINTS: Record<string, RegExp> = {
  price: /(price|amount|money|sale|from)/i,
  title: /(title|name|heading|product)/i,
  image: /(image|img|picture|thumb)/i,
  desc: /(description|desc|copy|details)/i,
};

export async function runAssistedLearn(input: AssistInput): Promise<AssistOutput> {
  const $ = load(input.html);
  const notes: string[] = [];

  const candidates = collectCandidates($);
  const suggestedFields = pickFieldSelectors($, candidates, input.seeds, notes);
  const suggestedBuckets = buildBuckets(candidates);

  return {
    suggestedFields,
    suggestedBuckets,
    notes,
  };
}

/* ---------------- internals ---------------- */

function collectCandidates($: CheerioAPI) {
  const anchors: string[] = [];
  const containers: string[] = [];
  const candidates: string[] = [];

  // obvious anchor/list shapes
  push(anchors, [
    "a[href*='/product']",
    "a[href*='/products/']",
    "[data-product-id] a[href]",
    ".product-card a[href]",
  ]);

  // common container shapes
  push(containers, [
    "[data-product-id]",
    "[data-product-card]",
    ".product-card",
    ".product-grid, [data-product-grid]",
    "#product-grid .grid__item, .collection .grid__item",
  ]);

  // ✅ Attribute-driven nodes WITHOUT using invalid [data-*]
  // Grab itemprop/aria/role via normal CSS:
  try {
    $("[itemprop],[aria-label],[role]")
      .slice(0, 300)
      .each((_, el) => {
        const sel = toShortSelector($, el as any);
        if (sel) candidates.push(sel);
      });
  } catch { /* ignore */ }

  // Collect elements that HAVE ANY data-* attribute via traversal
  // (No CSS for wildcard attribute names; we manually check attribs)
  try {
    let seen = 0;
    $("*").each((_, el) => {
      if (seen > 800) return false; // keep it light
      const node = $(el).get(0) as AnyNode | undefined;
      const attribs = getAttribs(node);
      const hasDataAttr = Object.keys(attribs).some(n => n.startsWith("data-"));
      if (hasDataAttr) {
        const sel = toShortSelector($, el as any);
        if (sel) candidates.push(sel);
        seen++;
      }
      return undefined;
    });
  } catch { /* ignore */ }

  // also grab headings & price-like nodes
  try {
    $("h1,h2,h3,h4,.price,.amount,[itemprop='price'],[data-price]")
      .slice(0, 200)
      .each((_, el) => {
        const sel = toShortSelector($, el as any);
        if (sel) candidates.push(sel);
      });
  } catch { /* ignore */ }

  return {
    anchors: uniq(anchors).slice(0, 40),
    containers: uniq(containers).slice(0, 40),
    candidates: uniq(candidates).slice(0, 120),
  };
}


function pickFieldSelectors(
  $: CheerioAPI,
  c: ReturnType<typeof collectCandidates>,
  seeds: AssistInput["seeds"],
  notes: string[]
) {
  const out: Record<string, { sel: string; attr?: string; confidence: number }> = {};

  // Bias: if we already have a seed, keep it unless it fails totally
  if (seeds?.fields) {
    for (const [k, v] of Object.entries(seeds.fields)) {
      const hit = tryPick($, v.sel, v.attr);
      if (hit) out[k] = { sel: v.sel, attr: v.attr, confidence: 0.9 };
    }
  }

  // TITLE
  if (!out.title) {
    const titleSel = firstHit($, [
      "h1[itemprop='name']",
      "h1.product-title",
      ".card-title a, .card__heading a",
      "[itemprop='name']",
      "h1, h2",
    ]);
    if (titleSel) out.title = { sel: titleSel, attr: "text", confidence: confOf($, titleSel, "title") };
  }

  // PRICE
  if (!out.price) {
    const priceSel = firstHit($, [
      "[itemprop='price']",
      "[data-price]",
      ".price .amount",
      ".price-item",
      ".productView-price .price",
    ]);
    if (priceSel) out.price = { sel: priceSel, attr: pickPriceAttr($, priceSel), confidence: confOf($, priceSel, "price") };
  }

  // IMAGE
  if (!out.image) {
    const imgSel = firstHit($, [
      ".product-card img",
      ".productView-image img",
      "img[loading][srcset], img[srcset], img[src]",
    ]);
    if (imgSel) out.image = { sel: imgSel, attr: pickImgAttr($, imgSel), confidence: confOf($, imgSel, "image") };
  }

  // DESC
  if (!out.desc) {
    const dSel = firstHit($, [
      "#tab-description, [itemprop='description']",
      ".product__description, .productView-description",
    ]);
    if (dSel) out.desc = { sel: dSel, attr: "text", confidence: confOf($, dSel, "desc") };
  }

  // LINK/HREF (PLP bias)
  if (!out["href"]) {
    const hrefSel = firstHit($, [
      ".product-card a[href]",
      "[data-product-id] a[href]",
      "a[href*='/product'], a[href*='/products/']",
    ]);
    if (hrefSel) out["href"] = { sel: hrefSel, attr: "href", confidence: confOf($, hrefSel, "href") };
  }

  // annotate low-confidence
  for (const [k, v] of Object.entries(out)) {
    if (v.confidence < 0.5) notes.push(`Low confidence for ${k}: ${v.sel}`);
  }

  return out;
}

function buildBuckets(c: ReturnType<typeof collectCandidates>) {
  return {
    anchors: c.anchors,
    containers: c.containers,
    candidates: c.candidates,
  };
}

function tryPick($: CheerioAPI, sel?: string, attr?: string) {
  if (!sel) return null;
  const el = $(sel).first();
  if (!el.length) return null;
  if (!attr || attr === "text") return (el.text() || "").trim() || null;
  if (attr === "srcset:first") {
    const ss = el.attr("srcset") || "";
    const first = (ss.split(",")[0] || "").trim().split(/\s+/)[0] || "";
    return first || null;
  }
  return el.attr(attr) || null;
}

function firstHit($: CheerioAPI, list: string[]) {
  for (const sel of list) {
    try { if ($(sel).length) return sel; } catch { /* skip invalid */ }
  }
  return null;
}


function pickImgAttr($: CheerioAPI, sel: string): "data-src" | "srcset:first" | "src" {
  const el = $(sel).first();
  if (el.attr("data-src")) return "data-src";
  if (el.attr("srcset")) return "srcset:first";
  return "src";
}

function pickPriceAttr($: CheerioAPI, sel: string): "text" | "content" {
  const el = $(sel).first();
  if (el.is("[itemprop='price']") && el.attr("content")) return "content";
  return "text";
}


function getAttribs(node: AnyNode | undefined): Record<string, string> {
  return node && isTag(node) ? (node.attribs as Record<string, string>) ?? {} : {};
}
function getTagName(node: AnyNode | undefined): string {
  return node && isTag(node) ? (node.name?.toLowerCase?.() ?? "div") : "div";
}


function confOf($: CheerioAPI, sel: string, field: string): number {
  let base = 0.6;
  const node = $(sel).first().get(0) as AnyNode | undefined;

  const attribs = getAttribs(node);
  const hasStableAttr = Object.keys(attribs).some((n) => /^data-|^itemprop$|^aria-/.test(n));

  if (hasStableAttr) base += 0.15;

  const txt = $(sel).first().text().trim();
  if (field === "price" && /\d/.test(txt)) base += 0.1;
  if (field === "title" && txt.length >= 8) base += 0.05;
  if (FIELD_HINTS[field]?.test?.(sel)) base += 0.05;

  return Math.min(0.95, base);
}


function toShortSelector($: CheerioAPI, el: AnyNode): string | null {
  const $node = $(el);
  if (!$node.length) return null;

  const node = $node.get(0) as AnyNode | undefined;
  const attribs = getAttribs(node);

  const idRaw = attribs["id"];
  const id = typeof idRaw === "string" ? idRaw : undefined;
  if (id && !/^react-/.test(id)) return `#${cssEscape(id)}`;

  // prefer the real HTML tag name
  const segTag = getTagName(node);

  // prefer stable attributes first
  const stableEntry = Object.entries(attribs).find(([n]) => /^data-|^itemprop$|^aria-/.test(n));

  let seg = segTag;
  if (stableEntry) {
    const [n, v] = stableEntry;
    seg += `[${n}="${cssEscape(String(v))}"]`;
  } else {
    // fall back to class names if present
    const classRaw = attribs["class"];
    const classes = String(classRaw || "")
      .split(/\s+/)
      .filter(Boolean)
      .filter((c) => !/^\d+$/.test(c) && c.length > 2 && !/^(css|sc-|chakra|tw-)/i.test(c))
      .slice(0, 2);
    if (classes.length) seg += "." + classes.map((c) => cssEscape(String(c))).join(".");
  }

  // keep it shallow (no ancestry here); caller can scope later
  return seg;
}


function cssEscape(s: string) {
  return s.replace(/([ !"#$%&'()*+,./:;<=>?@\[\\\]^`{|}~])/g, "\\$1");
}


function push(arr: string[], list: string[]) { for (const x of list) arr.push(x); }
function uniq<T>(xs: T[]) { return Array.from(new Set(xs)); }
