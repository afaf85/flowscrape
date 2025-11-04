// src/autodetect.ts
import { load, CheerioAPI } from "cheerio";
import type { Element as CheerioElement } from "domhandler";

export type AutoDetect = {
  // primary selector to try first (same contract as before)
  listSelector: string;
  // keep everything we saw (ranked best → worst)
  candidates: string[];
  // minimal field hints so extract can proceed
  fields: Record<string, { text?: boolean; html?: boolean; attr?: string; textLen?: boolean }>;
  // 0..1-ish confidence for the primary
  confidence: number;
};

const PRODUCT_HINTS = [/\/product/i, /\/products?\//i, /item/i, /sku/i];

// areas to down-rank / avoid as primary
const BAD_WRAPPERS = [
  "header",
  "footer",
  "nav",
  "form",
  ".breadcrumbs",
  "[role='navigation']",
  "[role='banner']",
  ".newsletter",
  ".subscribe",
  ".pagination",
];

// typical filter/facet containers
const FILTER_HINTS = [
  ".facets",
  ".facets__wrapper",
  ".filters",
  ".collection-filters",
  "[data-filters]",
  ".sidebar",
  ".collection-sidebar",
];

// “product-ish” nodes
const ITEMISH = [
  "[data-product-id]",
  "[data-product]",
  ".product-card",
  ".product",
  ".card",
  ".grid__item",
  ".collection-product",
  ".productGrid .card",
  ".productGrid .product",
];

export function autodetectFromHtml(html: string, baseUrl: string): AutoDetect | null {
  const $ = load(html);

  const candidateSet = new Map<string, number>(); // selector → score
  const pushCandidate = (sel: string, s: number) => {
    if (!sel) return;
    // normalize tiny things
    sel = sel.trim();
    if (!sel) return;
    candidateSet.set(sel, Math.max(candidateSet.get(sel) ?? -Infinity, s));
  };

  // 0) Quick Shopify-ish detection (very high)
  if (
    /shopify-section-.*product-grid/i.test(html) ||
    /collection-product-grid/i.test(html) ||
    /data-section-type="collection-template"/i.test(html)
  ) {
    const primary =
      "[id*='product-grid'] .grid__item, [id*='product-grid'] .collection-product, .collection .grid__item";
    // also record variants as candidates (learn from everywhere)
    pushCandidate("[id*='product-grid'] .grid__item", 90);
    pushCandidate("[id*='product-grid'] .collection-product", 88);
    pushCandidate(".collection .grid__item", 80);

    return {
      listSelector: primary,
      candidates: Array.from(candidateSet.keys()),
      fields: withCommonFields(),
      confidence: 0.9,
    };
  }

  // 1) JSON-LD / Microdata → help DOM detection, but also emit container candidates
  const ldNodes = $("script[type='application/ld+json']")
    .toArray()
    .flatMap((s: CheerioElement) => {
      try {
        const txt = $(s).contents().text() || "[]";
        const parsed = JSON.parse(txt);
        return Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        return [];
      }
    });

  const ldFlat = flattenJsonLd(ldNodes);
  const ldProducts = ldFlat.filter((n) => asType(n, "Product"));

  // 2) Microdata/RDFA Product
  const microProducts = $(
    "[itemtype*='schema.org/Product'], [typeof*='schema.org/Product']"
  ).toArray();
  if (microProducts.length >= 6) {
    const container = smallestCommonAncestor($, microProducts);
    if (container) {
      const contSel = uniqueSelector($, container) || "body";
      // prefer card-level, but also keep "container a[href]"
      pushCandidate(`${contSel} a[href]`, 70);
      // try to surface a card inside the container
      const $best = $(container as any);
      const card = $best.find(ITEMISH.join(",")).first()[0] || null;
      if (card) {
        pushCandidate(uniqueSelector($, card as any), 78);
      }
      // pick a strong primary from these
      const primary = pickPrimary(Array.from(candidateSet.entries()));
      return {
        listSelector: primary.selector,
        candidates: rankAndFlatten(candidateSet),
        fields: withCommonFields(),
        confidence: Math.min(0.85, primary.score / 100),
      };
    }
  }

  // 3) DOM heuristic (broad sweep, but keep *everything* we see)
  const roots = $("main, .content, .container, .page-width, body").toArray();

  for (const root of roots) {
    $(root)
      .find("div, ul, section")
      .each((_: number, el: CheerioElement) => {
        if (isBadWrapper($, el)) return;

        const $el = $(el);
        const anchors = $el.find("a[href]").toArray();
        if (anchors.length < 4) return;

        const productish = anchors.filter((a: CheerioElement) => {
          const href = String($(a).attr("href") || "");
          return PRODUCT_HINTS.some((rx) => rx.test(href));
        });

        const itemishCount = ITEMISH.reduce(
          (acc, sel) => acc + $el.find(sel).length,
          0
        );
        const filterish =
          FILTER_HINTS.some((sel) => $el.is(sel) || $el.find(sel).length) ||
          false;

        const imgs = $el.find("img").length;
        const headings = $el.find("h1,h2,h3,h4,.card-title,.product-title").length;

        let score = 0;
        score += productish.length * 3;
        score += Math.min(itemishCount, 10) * 2;
        score += Math.min(imgs, 12);
        score += Math.min(headings, 6);

        if (filterish) score -= 6;

        const classAttr = $el.attr("class") || "";
        if (/\b(sidebar|col-2|col-md-3|facets|filters)\b/i.test(classAttr)) {
          score -= 4;
        }

        if (score > 4) {
          const containerSel = uniqueSelector($, el);
          // record container link sweep (broad)
          pushCandidate(`${containerSel} a[href]`, clampScore(score * 2)); // broad but ranked
          // record card-level if present (narrow)
          const card = $el.find(ITEMISH.join(",")).first()[0] || null;
          if (card) {
            pushCandidate(uniqueSelector($, card as any), clampScore(score * 3)); // better
          }
        }
      });
  }

  if (candidateSet.size) {
    // try to discover repeated price/img inside the best container for hints (optional)
    const bestEntry = pickPrimary(Array.from(candidateSet.entries()));
    const bestSel = bestEntry.selector;
    let priceSel: string | null = null;
    let imageSel: string | null = null;

    // try to scope hints if bestSel is a container; otherwise just rely on defaults
    try {
      const $best = $(bestSel);
      if ($best.length) {
        priceSel = detectRepeatingPrice($, $best);
        imageSel = detectRepeatingImage($, $best);
      }
    } catch {
      // ignore invalid scopes
    }

    return {
      listSelector: bestSel,
      candidates: rankAndFlatten(candidateSet),
      fields: {
        title: { text: true },
        href: { attr: "href" },
        image: { attr: "src" }, // keep simple; extractor can refine
        price: { text: true, textLen: true },
      },
      confidence: Math.min(0.75, bestEntry.score / 100),
    };
  }

  // 4) Generic fallbacks — also emit candidates
  if ($("main a[href]").length) {
    pushCandidate("main a[href]", 30);
    return {
      listSelector: "main a[href]",
      candidates: rankAndFlatten(candidateSet),
      fields: { title: { text: true }, href: { attr: "href" } },
      confidence: 0.35,
    };
  }

  if ($("a[href]").length) {
    pushCandidate("a[href]", 20);
    return {
      listSelector: "a[href]",
      candidates: rankAndFlatten(candidateSet),
      fields: { title: { text: true }, href: { attr: "href" } },
      confidence: 0.2,
    };
  }

  return null;
}

/* ----------------- helpers ----------------- */

function withCommonFields() {
  return {
    title: { text: true },
    href: { attr: "href" },
    price: { text: true, textLen: true },
    image: { attr: "src" },
  };
}

function isBadWrapper($: CheerioAPI, el: CheerioElement): boolean {
  const $el = $(el as any);
  const tag = ($el.prop("tagName") || "").toString().toLowerCase();
  if (tag === "header" || tag === "footer" || tag === "nav") return true;

  const classes = ($el.attr("class") || "").toLowerCase();
  if (/footer|header|navbar|topbar|breadcrumb|newsletter/.test(classes))
    return true;

  for (const sel of BAD_WRAPPERS) {
    if ($el.is(sel)) return true;
  }
  return false;
}

function asType(node: any, t: string) {
  const ty = node?.["@type"];
  if (!ty) return false;
  return Array.isArray(ty) ? ty.includes(t) : ty === t;
}

function flattenJsonLd(n: any): any[] {
  if (!n) return [];
  if (Array.isArray(n)) return n.flatMap(flattenJsonLd);
  if (typeof n !== "object") return [];
  const out = [n];
  for (const v of Object.values(n)) out.push(...flattenJsonLd(v));
  return out;
}

function smallestCommonAncestor($: CheerioAPI, els: CheerioElement[]) {
  const paths = els.map((el) => pathToRoot($, el));
  let i = 0;
  while (true) {
    const tag = paths[0][i];
    if (!tag) break;
    if (paths.every((p) => p[i] === tag)) {
      i++;
      continue;
    }
    break;
  }
  const lastShared = paths[0][i - 1];
  return lastShared || null;
}

function pathToRoot($: CheerioAPI, el: CheerioElement) {
  const chain: CheerioElement[] = [];
  let cur: any = el;
  while (cur) {
    chain.unshift(cur);
    cur = cur.parent;
  }
  return chain;
}

function uniqueSelector($: CheerioAPI, el: CheerioElement): string {
  const $el = $(el as any);
  const id = $el.attr("id");
  if (id) return `#${cssEscape(id)}`;
  const classes = ($el.attr("class") || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const tag = (String(($el.prop("tagName") as any) || "div")).toLowerCase();
  if (classes.length) return `${tag}.${classes.map(cssEscape).join(".")}`;
  return tag;
}

function cssEscape(s: string) {
  return s.replace(/[^a-zA-Z0-9_-]/g, (m) => `\\${m}`);
}

function detectRepeatingPrice($: CheerioAPI, $container: ReturnType<CheerioAPI>): string | null {
  const PRICE_HINTS = [
    ".price",
    ".product-price",
    ".product-price__wrapper",
    ".price__sale",
    ".price__regular",
    "[data-test='product-price']",
    "[data-test='product-card-price']",
    "[class*='price']",
  ];

  const counts: Record<string, number> = {};
  for (const hint of PRICE_HINTS) {
    const found = $container.find(hint);
    if (found.length) counts[hint] = found.length;
  }

  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return null;
  const [bestSel, bestCount] = entries[0];
  if (bestCount >= 3) return bestSel;
  return null;
}

function detectRepeatingImage($: CheerioAPI, $container: ReturnType<CheerioAPI>): string | null {
  const imgs = $container.find("img");
  if (imgs.length >= 3) return "img";
  return null;
}

function clampScore(s: number) {
  return Math.max(1, Math.min(100, Math.round(s)));
}

function pickPrimary(entries: [string, number][]) {
  // prefer more specific (card-like) over broad "container a[href]"
  entries.sort((a, b) => {
    const [selA, scoreA] = a;
    const [selB, scoreB] = b;
    const specA = selectorSpecificity(selA);
    const specB = selectorSpecificity(selB);
    if (scoreB !== scoreA) return scoreB - scoreA;
    return specB - specA;
  });
  const [selector, score] = entries[0];
  return { selector, score };
}

function selectorSpecificity(sel: string): number {
  // very rough: reward length & presence of attribute/class chains
  let spec = 0;
  spec += (sel.match(/\./g) || []).length * 3; // classes
  spec += (sel.match(/\[/g) || []).length * 4; // attributes
  spec += (sel.match(/\s+/g) || []).length * 1; // depth
  return spec;
}

function rankAndFlatten(map: Map<string, number>): string[] {
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([sel]) => sel);
}
