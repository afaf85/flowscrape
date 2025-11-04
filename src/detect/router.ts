// src/router.ts
export type PageKind =
  | "shopify"
  | "bigcommerce"
  | "woocommerce"
  | "retail"
  | "docs"
  | "blog"
  | "generic";

export type PageClassification = {
  kind: PageKind;
  confidence: number; // 0..1
};

const KNOWN_RETAIL_DOMAINS = [
  // big global
  "adidas.", "nike.", "puma.", "reebok.", "underarmour.", "lululemon.",
  // sports / outdoor
  "mec.ca", "rei.com", "decathlon.", "basspro.", "cabelas.",
  // electronics
  "bestbuy.", "mediamarkt.", "fnac.",
  // fashion
  "zara.", "hm.com", "uniqlo.", "asos.", "shein.",
];

const RETAIL_PATH_HINTS = [
  "/men",
  "/women",
  "/kids",
  "/girls",
  "/boys",
  "/sale",
  "/outlet",
  "/new",
  "/new-arrivals",
  "/collections",
  "/collection",
  "/category",
  "/shop",
  "/products",
  "/product",
];

export async function classifyPage(
  html: string,
  url: string,
  opts?: {
    autodetectConfidence?: number;
  }
): Promise<PageClassification> {
  const u = url.toLowerCase();
  const h = html.toLowerCase();
  const combo = u + h;

  // 0) let autodetect win if it was very sure
  if (opts?.autodetectConfidence && opts.autodetectConfidence >= 0.85) {
    return { kind: "generic", confidence: 0.2 };
  }

  // 1) strong platform patterns
  if (/x-shopify|data-shopify|shopify-section-|cdn\.shopify\.com/.test(combo)) {
    return { kind: "shopify", confidence: 0.95 };
  }

  if (/stencil-utils|mybigcommerce|data-bc|data-theme="bigcommerce"/.test(combo)) {
    return { kind: "bigcommerce", confidence: 0.9 };
  }

  if (/woocommerce|wc_add_to_cart|\/product-category\/|wp-content\/plugins\/woocommerce/.test(combo)) {
    return { kind: "woocommerce", confidence: 0.9 };
  }

  // 2) known retail domains (brand-based)
  if (KNOWN_RETAIL_DOMAINS.some((d) => u.includes(d))) {
    return { kind: "retail", confidence: 0.85 };
  }

  // 3) retail-y URL structures (list/category pages, before blog)
  if (
    /\/category\//.test(u) ||        // bestbuy.ca/en-ca/category/...
    /\/en\/c\//.test(u) ||           // mec.ca/en/c/...
    /\/c\/[a-z0-9-]+/.test(u) ||     // generic /c/slug
    /\/cart\b/.test(u) ||
    /\/checkout\b/.test(u)
  ) {
    return { kind: "retail", confidence: 0.8 };
  }

  // 4) generic retail path hints (for Adidas/Nike-style URLs)
  if (RETAIL_PATH_HINTS.some((p) => u.includes(p))) {
    return { kind: "retail", confidence: 0.75 };
  }

  // 5) docs
  if (/\bdocs?\b|developer|readthedocs|docusaurus|mkdocs/.test(combo)) {
    return { kind: "docs", confidence: 0.9 };
  }

  // 6) blog AFTER retail
  if (/blog|news|article|post|medium\.com|ghost\.io/.test(combo)) {
    return { kind: "blog", confidence: 0.85 };
  }

  // 7) retail generic fallback (DOM/content signals)
  if (/add-to-cart|cart|variant|sku|price|product|shop|collection|category/i.test(combo)) {
    return { kind: "retail", confidence: 0.6 };
  }

  // 8) last resort
  return { kind: "generic", confidence: 0.3 };
}
