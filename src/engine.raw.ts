// src/engine.raw.ts
import { chromium, Page } from "playwright";
import { autodetectFromHtml } from "./detect/autodetect.js";
import {
  loadLearnedSelectors,
  getBestProfile,
  upsertProfile,
} from "./learn/learn.js";
import { extractItems } from "./extract/extract.js";
import { writePageOnce, writeItems, getStats } from "./storage/storage.js";
import { waitIdle } from "./steps/steps.js";
import { classifyPage } from "./detect/router.js";
import { loadSelectors } from "./utils.js";
import { enableTeachMode, waitForTeachOverlay } from "./learn/manual.js";

/* logging */
const LOG_LEVEL = (process.env.FS_LOG_LEVEL || "info").toLowerCase();
const ORDER: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const canLog = (lvl: string) => (ORDER[lvl] ?? 20) >= (ORDER[LOG_LEVEL] ?? 20);
const log = {
  debug: (...a: any[]) => canLog("debug") && console.log("[debug]", ...a),
  info:  (...a: any[]) => canLog("info")  && console.log("[info]",  ...a),
  warn:  (...a: any[]) => canLog("warn")  && console.log("[warn]",  ...a),
  error: (...a: any[]) => canLog("error") && console.log("[error]", ...a),
};

type LearnedSavePayload = {
  list?: string[];
  anchors?: string[];
  containers?: string[];
  broad?: string[];
  candidates?: string[];
  fields?: Record<string, any>;
};

type AutoDetectLike = {
  listSelector?: string | string[];
  candidates?: string[];
  fields?: Record<string, any>;
  confidence?: number;
};

/* ===== small helpers (shared) ===== */

// title+href guard for precision
const hasTitleHref = (x: any): x is { title: any; href: any } =>
  !!(x && x.title && x.href);

function toArray(x: string[] | string | undefined): string[] {
  if (!x) return [];
  return Array.isArray(x) ? x : x.split(",").map(s => s.trim()).filter(Boolean);
}

function isAnchorish(s: string) {
  return /a\[href/.test(s) || /\/product/.test(s);
}

function isContainerish(s: string) {
  return /\b(grid|product|card|collection|item)\b/i.test(s) && !/a\[href/.test(s);
}

function toAnchorVariant(s: string) {
  // if looks like container → try inner anchor
  if (isContainerish(s) && !/a\[href/.test(s)) return `${s} a[href]`;
  return s;
}

function unique(arr: string[]) {
  return Array.from(new Set(arr.filter(Boolean)));
}

function simplifyClassSelector(sel: string): string {
  // remove responsive/variant classes like sm\:grid-cols-3, lg\:gap-6
  const cleaned = sel.replace(/\.[a-z0-9_-]*\\:[a-z0-9_-]+/gi, "");
  // collapse multiple spaces, trim
  return cleaned.replace(/\s+/g, " ").trim();
}

function bySimplicity(a: string, b: string) {
  // shorter selector first; fewer class segments preferred
  const score = (s: string) => (s.match(/\./g)?.length || 0) * 10 + s.length;
  return score(a) - score(b);
}

function toAbsUrl(base: string, href?: string) {
  try {
    if (!href) return href;
    return new URL(href, base).toString();
  } catch { return href; }
}

function stripBoilerplateDescription(desc?: string) {
  if (!desc) return desc;
  const d = desc.trim();
  // kill common marketing straplines; add more patterns as you find them
  if (/^shop hpg brands$/i.test(d)) return "";
  if (/^learn more$/i.test(d)) return "";
  return d;
}

function coalescePrice(it: any) {
  // prefer numeric-ish price text if present
  const pick = (s?: string) => s && /\d/.test(s) ? s : undefined;
  it.price = pick(it.salePrice) || pick(it.price) || pick(it.compareAt) || it.price;
  return it;
}

function canonicalHref(href?: string) {
  if (!href) return href;
  // remove trailing slashes and marketing params
  const u = href.replace(/\/+$/, "");
  const noUtm = u.replace(/(\?|&)utm_[^=]+=[^&]+/gi, "").replace(/[?&]$/,"");
  return noUtm;
}

function dedupeItems(items: any[], baseUrl: string) {
  const seen = new Set<string>();
  const out: any[] = [];
  for (const raw of items) {
    const it = { ...raw };
    it.href = canonicalHref(toAbsUrl(baseUrl, it.href));
    it.description = stripBoilerplateDescription(it.description);
    if (Array.isArray(it.images) && it.images.length && !it.image) {
      it.image = it.images[0];
    }
    coalescePrice(it);

    const key = (it.href || "") + "¦" + (it.title || "");
    if (it.href && !seen.has(key)) {
      seen.add(key);
      out.push(it);
    }
  }
  return out;
}

function scoreItem(it: any) {
  let s = 0;
  // title signals
  if (it.title) s += 2;
  if (it.title && it.title.length >= 20) s += 1;
  // link presence
  if (it.href) s += 2;
  // price signals
  if (it.price) s += 2;
  if (/\d/.test(String(it.price || "")) && /(\$|cad|usd|msrp|from)/i.test(String(it.price))) s += 1;
  // image
  if (it.image) s += 1;
  // SKU-ish slug (helps HPG)
  if (it.href && /\/[a-z0-9]{2,}\//i.test(it.href)) s += 1;
  // description non-boilerplate
  if (it.description && it.description.length > 10) s += 1;
  return s;
}

function postProcessItems(items: any[], baseUrl: string) {
  const deduped = dedupeItems(items, baseUrl);
  const scored = deduped.map(it => ({ ...it, _score: scoreItem(it) }));
  // stable sort: highest score first, tie-break by title then href
  scored.sort((a, b) => (b._score - a._score) || String(a.title).localeCompare(String(b.title)) || String(a.href).localeCompare(String(b.href)));
  return scored;
}


/* ===== main ===== */

export async function runRaw(
  url: string,
  opts: { headless?: boolean; assist?: boolean; teach?: boolean } = {}
) {
  loadLearnedSelectors();

  const browser = await chromium.launch({ headless: opts.headless ?? true });
  const page = await browser.newPage();

  /* ========== TEACH overlay injection (opt-in) ========== */
  if (opts.teach) {
    await enableTeachMode(page, url, log);
  }
  /* ========== /TEACH overlay injection ========== */

  log.info("[raw] launching:", url);
  const ok = await safeInitialGoto(page, url);
  if (ok) await waitIdle(page, 200);

  if (opts.teach) {
    await waitForTeachOverlay(page, log);
  }

  const html = await safeGetContent(page);
  log.debug("[raw] initial HTML length:", html.length);

  const host = new URL(url).host;
  log.info("[raw] host:", host);

  /* ensure page actually rendered products */
  await page.waitForTimeout(1000);
  await ensureCollectionReady(page);
  const finalHtml = await safeGetContent(page);

  /* learned — score against fully-rendered HTML */
  const { profile, buckets: learned, score } = getBestProfile(host, url, finalHtml);
  const learnedList = toArray(learned.list);
  log.info(
    "[raw] learned profile:",
    profile?.id || "(none)",
    "score:",
    score,
    "list:",
    learnedList.length,
    "anchors:",
    learned.anchors?.length || 0,
    "containers:",
    learned.containers?.length || 0,
    "broad:",
    learned.broad?.length || 0,
    "candidates:",
    learned.candidates?.length || 0
  );
  const COLD_THRESHOLD = 2;
  const isCold = (score ?? 0) < COLD_THRESHOLD;

  /* autodetect (use finalHtml) */
  const auto = (autodetectFromHtml(finalHtml, url) as AutoDetectLike | null) || null;

  /* classification (only if nothing at all) — use finalHtml too */
  let classified: any = null;
  if (!auto?.listSelector && !learnedList.length) {
    const cls = await classifyPage(finalHtml, url);
    const kind = typeof cls === "string" ? cls : cls?.kind;
    if (kind) {
      classified = loadSelectors(kind);
      log.info("[raw] classified as:", kind);
    }
  }

  /* fields (make mutable for assisted merge) */
  let fields: Record<string, { sel: string; attr?: string }> = {
    ...(classified?.fields || {}),
    ...(auto?.fields || {}),
    ...(learned?.fields || {}),
  };
  log.debug("[raw] merged field keys:", Object.keys(fields));

  /* ---------------- assisted learn (opt-in & lazy) ---------------- */
  let assistBuckets:
    | { anchors: string[]; containers: string[]; candidates: string[] }
    | undefined;

  if (opts.assist) {
    try {
      const mod = await import("./learn/assisted_learn.js");
      const assist = await (mod as any).runAssistedLearn({
        url,
        html: finalHtml,
        seeds: { list: toArray(auto?.listSelector), fields },
      });

      for (const [k, v] of Object.entries(assist.suggestedFields as Record<string, any>)) {
        if (!fields[k] && v.confidence >= 0.7) {
          fields[k] = { sel: v.sel, attr: v.attr };
        }
      }
      assistBuckets = assist.suggestedBuckets;
      if (assist.notes?.length) log.info("[assist] notes:", assist.notes.join(" | "));
      log.info("[assist] fields suggested:", Object.keys(assist.suggestedFields));
    } catch (e: any) {
      log.warn("[assist] failed:", e?.message || String(e));
    }
  }
  /* ---------------------------------------------------------------- */

  /* build buckets to TRY (ordered, no penalizing) */
  const buckets: Record<string, string[]> = {
    list: isCold ? [] : learnedList,
    anchors: unique([
      ...(learned.anchors || []),
      ...toArray(auto?.listSelector).map(toAnchorVariant),
      ...(auto?.candidates || []).filter(isAnchorish),
    ]),
    containers: unique([
      ...(learned.containers || []),
      ...(auto?.candidates || []).filter(isContainerish),
    ]),
    broad: unique([...(learned.broad || []), "a[href*='/product']", "a[href*='/products/']"]),
    candidates: unique([
      ...(learned.candidates || []),
      ...toArray(auto?.listSelector),
      ...(auto?.candidates || []),
      ...(Array.isArray(classified?.list) ? classified.list : []),
    ]),
  };

  if (assistBuckets) {
    const prepend = (xs: string[] | undefined, into: string[]) => unique([...(xs || []), ...into]);
    buckets.anchors    = prepend(assistBuckets.anchors, buckets.anchors).slice(0, 60);
    buckets.containers = prepend(assistBuckets.containers, buckets.containers).slice(0, 60);
    buckets.candidates = prepend(assistBuckets.candidates, buckets.candidates).slice(0, 120);
  }

  /* progressive testing */
  let items: any[] = [];
  const winners: string[] = [];
  const tried: string[] = [];

  for (const [bucketName, sels] of Object.entries(buckets)) {
    if (!sels.length) continue;
    log.info(`[raw] trying bucket: ${bucketName} (${sels.length} selectors)`);
    for (const sel of sels) {
      tried.push(sel);
      const res = extractItems(finalHtml, [sel], fields);
      if (res.length) {
        log.info(`[raw] ✓ success with ${bucketName}:`, sel, `→ ${res.length} items`);
        items = res; winners.push(sel); break;
      }
    }
    if (items.length) break;
    const batch = sels.slice(0, 10);
    if (batch.length) {
      const res = extractItems(finalHtml, batch, fields);
      if (res.length) {
        log.info(`[raw] ✓ batch success in ${bucketName}:`, batch.length, "selectors");
        items = res; winners.push(...batch); break;
      }
    }
  }

  log.info("[raw] extracted items:", items.length);
  if (!items.length) log.warn("[raw] 0 items — nothing worked this run");

  items = postProcessItems(items, url);

  const good = items.filter(hasTitleHref).length;
  const precision = items.length ? good / items.length : 0;
  log.info(`[raw] precision: ${(precision * 100) | 0}% (post-processed count: ${items.length})`);

  await writePageOnce(url, finalHtml);
  if (items.length) await writeItems(items);

  const learnedPayload = bucketizeForLearning(tried, winners);
  upsertProfile(host, url, finalHtml, {
    id: (isCold || precision < 0.5) ? undefined : profile?.id,
    buckets: { ...learnedPayload, fields },
    metrics: { items: items.length },
  });
  log.info("[raw] learned selectors saved (profile:", (isCold || precision < 0.5) ? "new" : (profile?.id || "default"), ")");

  const stats = getStats();
  log.info(`[raw] Summary → pages:${stats.pages} html:${stats.pagesHtml} items:${stats.items}`);

  await browser.close();
}



/* ===== categorize + learning helpers ===== */

function bucketizeForLearning(tried: string[], winners: string[]): LearnedSavePayload {
  const normalize = (s: string) => simplifyClassSelector(s);
  const uniqTried = unique(tried.map(normalize));
  const uniqWin = new Set(winners.map(normalize));

  const anchors: string[] = [];
  const containers: string[] = [];
  const broad: string[] = [];
  const candidates: string[] = [];
  const list: string[] = [];

  for (const s of uniqTried) {
    const anchorish = isAnchorish(s);
    const containerish = isContainerish(s);
    const veryBroad = /^(a\[href\]|ul a\[href\]|div\.site-main a\[href\])$/i.test(s);

    if (uniqWin.has(s)) {
      list.push(s);
      if (anchorish) anchors.push(s);
      else if (containerish) containers.push(s);
      else if (veryBroad) broad.push(s);
      else candidates.push(s);
      continue;
    }

    if (veryBroad) broad.push(s);
    else if (anchorish) anchors.push(s);
    else if (containerish) containers.push(s);
    else candidates.push(s);
  }

  // ✅ sort once here, after arrays are built
  list.sort(bySimplicity);
  anchors.sort(bySimplicity);
  containers.sort(bySimplicity);
  candidates.sort(bySimplicity);
  broad.sort(bySimplicity);

  return {
    list: unique(list).slice(0, 12),
    anchors: unique(anchors).slice(0, 40),
    containers: unique(containers).slice(0, 40),
    broad: unique(broad).slice(0, 40),
    candidates: unique(candidates).slice(0, 80),
    // fields will be added by caller
  };
}

/* ===== page helpers ===== */

async function safeGetContent(page: Page): Promise<string> {
  try {
    return await page.content();
  } catch {
    try { await page.waitForLoadState("domcontentloaded", { timeout: 2000 }); } catch {}
    try { return await page.content(); } catch {
      console.warn("[raw] WARN: could not get page.content()");
      return "";
    }
  }
}

async function safeInitialGoto(page: Page, url: string): Promise<boolean> {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
    return true;
  } catch (err: any) {
    console.warn("[raw] WARN: initial goto failed:", url, err?.message || "");
    return false;
  }
}

// make sure JS-rendered collections actually load (Shopify, etc.)
async function ensureCollectionReady(page: Page) {
  try { await page.locator("button:has-text('Accept')").first().click({ timeout: 1200 }); } catch {}
  try { await page.locator("[id*='onetrust'] button:has-text('Accept')").click({ timeout: 1200 }); } catch {}

  try {
    await page.evaluate(async () => {
      await new Promise<void>((resolve) => {
        let last = 0, idle = 0;
        const step = () => {
          const sh = document.documentElement.scrollHeight;
          window.scrollTo(0, sh);
          setTimeout(() => {
            const now = document.documentElement.scrollHeight;
            if (now > last) { last = now; idle = 0; step(); }
            else if (++idle < 4) step();
            else resolve();
          }, 350);
        };
        step();
      });
    });
  } catch {}

  try {
    await page.waitForFunction(
      () =>
        document.querySelectorAll(
          "[id*='product-grid'] .grid__item, .collection .grid__item, [data-product-id], .product-card"
        ).length >= 6,
      { timeout: 5000 }
    );
  } catch {}
  await page.waitForTimeout(400);
}
