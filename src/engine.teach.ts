// src/engine.teach.ts
import { chromium, Page } from "playwright";
import {
  loadLearnedSelectors,
  getBestProfile,
  upsertProfile,
} from "./learn/learn.js";
import { extractTeachItems } from "./extract/extract.teach.js";
import { writePageOnce, writeItems, getStats } from "./storage/storage.js";
import {
  enableTeachMode,
  waitForTeachOverlay,
  waitForTeachSaveResilient,
  squelchPageErrors,
} from "./learn/manual.js";

/* ================= logging ================= */

const LOG_LEVEL = (process.env.FS_LOG_LEVEL || "info").toLowerCase();
const ORDER: Record<string, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};
const canLog = (lvl: string) =>
  (ORDER[lvl] ?? 20) >= (ORDER[LOG_LEVEL] ?? 20);

const log = {
  debug: (...a: any[]) => canLog("debug") && console.log("[debug]", ...a),
  info: (...a: any[]) => canLog("info") && console.log("[info]", ...a),
  warn: (...a: any[]) => canLog("warn") && console.warn("[warn]", ...a),
  error: (...a: any[]) => canLog("error") && console.error("[error]", ...a),
};

/* ================= small helpers ================= */

const hasTitleHref = (x: any): x is { title: any; href: any } =>
  !!(x && x.title && x.href);

const toArray = (x?: string[] | string) =>
  !x
    ? []
    : Array.isArray(x)
    ? x
    : x
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

const unique = (arr: string[]) =>
  Array.from(new Set(arr.filter(Boolean)));

function toAbsUrl(base: string, href?: string) {
  try {
    return href ? new URL(href, base).toString() : href;
  } catch {
    return href;
  }
}

function canonicalHref(href?: string) {
  if (!href) return href;
  const u = href.replace(/\/+$/, "");
  const noUtm = u
    .replace(/(\?|&)utm_[^=]+=[^&]+/gi, "")
    .replace(/[?&]$/, "");
  return noUtm;
}

function stripBoilerplateDescription(desc?: string) {
  return (desc || "").trim();
}

function coalescePrice(it: any) {
  const pick = (s?: string) => (s && /\d/.test(s) ? s : undefined);
  it.price =
    pick(it.salePrice) ||
    pick(it.price) ||
    pick(it.compareAt) ||
    it.price;
  return it;
}

/**
 * Build a stable key used for dedupe/sort.
 * Priority:
 *  1) href/url/link/productUrl
 *  2) title+image
 *  3) title
 *  4) image
 *  5) fallback idx-based key
 */
function makeKey(it: any, idx: number): string {
  const primary =
    it.href ||
    it.url ||
    it.link ||
    it.productUrl;

  if (primary) return String(primary).toLowerCase();

  if (it.title && it.image) {
    return String(it.title + "¦" + it.image).toLowerCase();
  }
  if (it.title) return String(it.title).toLowerCase();
  if (it.image) return String(it.image).toLowerCase();

  return `idx-${idx}`;
}

/**
 * Smarter dedupe:
 * - Does NOT require href to exist beforehand.
 * - Derives href from url/link/productUrl when present.
 * - Falls back to a synthetic href to keep teach samples usable.
 * - Uses a _key for stable dedupe.
 */
function dedupeItemsSmart(items: any[], baseUrl: string) {
  const seen = new Set<string>();
  const out: any[] = [];

  items.forEach((raw, idx) => {
    if (!raw) return;
    const it = { ...raw };

    // Derive href from known link-like fields
    it.href = it.href || it.url || it.link || it.productUrl;

    if (it.href) {
      it.href = canonicalHref(toAbsUrl(baseUrl, it.href));
    }

    // If still no href, create a synthetic but stable one
    if (!it.href) {
      it.href = `${baseUrl.replace(/\/+$/, "")}#teach-${idx + 1}`;
    }

    // Normalize other fields
    it.description = stripBoilerplateDescription(it.description);
    if (Array.isArray(it.images) && it.images.length && !it.image) {
      it.image = it.images[0];
    }
    coalescePrice(it);

    const key = makeKey(it, idx);
    if (!key || seen.has(key)) return;

    seen.add(key);
    it._key = key;
    out.push(it);
  });

  return out;
}

function scoreItem(it: any) {
  let s = 0;
  if (it.title) s += 2;
  if (it.href) s += 2;
  if (it.price) s += 1;
  if (it.image) s += 1;
  if (it.description) s += 1;
  return s;
}

function postProcessItemsSmart(items: any[], baseUrl: string) {
  const deduped = dedupeItemsSmart(items, baseUrl);
  const scored = deduped.map((it) => ({
    ...it,
    _score: scoreItem(it),
  }));

  scored.sort(
    (a, b) =>
      b._score - a._score ||
      String(a.title || "").localeCompare(String(b.title || "")) ||
      String(a._key || a.href || "").localeCompare(
        String(b._key || b.href || "")
      )
  );

  return scored;
}

/* ================= page helpers ================= */

async function safeGetContent(page: Page): Promise<string> {
  try {
    return await page.content();
  } catch {
    try {
      await page.waitForLoadState("domcontentloaded", { timeout: 2000 });
    } catch {}
    try {
      return await page.content();
    } catch {
      console.warn("[teach] WARN: could not get page.content()");
      return "";
    }
  }
}

async function safeInitialGoto(page: Page, url: string): Promise<boolean> {
  try {
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 25000,
    });
    return true;
  } catch (err: any) {
    console.warn(
      "[teach] WARN: initial goto failed:",
      url,
      err?.message || ""
    );
    return false;
  }
}

async function ensureCollectionReady(page: Page) {
  try {
    await page.evaluate(async () => {
      await new Promise<void>((resolve) => {
        let last = 0;
        let idle = 0;

        const step = () => {
          const sh = document.documentElement.scrollHeight;
          window.scrollTo(0, sh);

          setTimeout(() => {
            const now = document.documentElement.scrollHeight;

            if (now > last) {
              last = now;
              idle = 0;
              step();
            } else if (++idle < 4) {
              step();
            } else {
              resolve();
            }
          }, 350);
        };

        step();
      });
    });
  } catch {
    // best-effort
  }

  await page.waitForTimeout(300);
}

/* ================= main (teach-only) ================= */

export async function runTeach(
  url: string,
  opts: { headless?: boolean } = {}
) {
  loadLearnedSelectors();

  const browser = await chromium.launch({
    headless: opts.headless ?? true,
  });

  const context = await browser.newContext({ bypassCSP: true });
  const page = await context.newPage();

  squelchPageErrors(page, log, { onlyTeachLogs: true });

  page.on("framenavigated", async (frame) => {
    if (frame === page.mainFrame()) {
      try {
        log.info("[teach] main-frame navigated →", frame.url());
        await enableTeachMode(page, frame.url(), log);
      } catch (e: any) {
        log.warn("[teach] reinject overlay failed:", e?.message || e);
      }
    }
  });

  await enableTeachMode(page, url, log);

  log.info("[teach] launching:", url);
  const ok = await safeInitialGoto(page, url);
  if (ok) await page.waitForTimeout(200);

  await waitForTeachOverlay(page, log);
  const payload = await waitForTeachSaveResilient(page, log, 10 * 60_000);

  if (!payload) {
    await browser.close();
    throw new Error("[teach] No manual picks received before timeout");
  }

  loadLearnedSelectors();
  log.info("[teach] manual picks saved; continuing…");
  log.info(
    "[teach] pure mode → using ONLY learned selectors for this host (no global strict gating)"
  );

  await ensureCollectionReady(page);
  const finalHtml = await safeGetContent(page);

  const host = new URL(url).host;
  const { profile, buckets: learned, score } = getBestProfile(
    host,
    url,
    finalHtml
  );

  const learnedList = toArray(learned.list);

  const fields: Record<string, { sel: string; attr?: string }> = {};
  if (learned.fields) {
    for (const [name, f] of Object.entries(learned.fields as any)) {
      const anyF = f as any;
      const sel: string | undefined =
        anyF.sel || anyF.abs || anyF.rel;
      if (!sel) continue;
      fields[name] = {
        sel,
        attr: anyF.attr,
      };
    }
  }

  log.info(
    "[teach] learned profile:",
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
  log.info(
    "[teach] using fields:",
    Object.keys(fields).join(", ") || "(none)"
  );

  const buckets = {
    list: learnedList,
    anchors: unique(learned.anchors || []),
    containers: unique(learned.containers || []),
    broad: unique(learned.broad || []),
    candidates: unique(learned.candidates || []),
  };

  let items: any[] = [];
  try {
    items = extractTeachItems(finalHtml, { buckets, fields });
  } catch (e: any) {
    log.warn("[teach] extractTeachItems threw:", e?.message || e);
    items = [];
  }

  log.info("[teach] extracted items (raw):", items.length);

  if (!items.length) {
    log.warn("[teach] 0 items — selectors from learned.json did not produce results");
  }

  // Smart post-process: dedupe + key + keep items even without original href
  items = postProcessItemsSmart(items, url);

  const persistable = items;
  const withTitleHref = items.filter(hasTitleHref).length;
  const coverage =
    items.length > 0 ? ((withTitleHref / items.length) * 100) | 0 : 0;

  log.info(
    `[teach] coverage: ${coverage}% of items have title+href`
  );
  log.info("[teach] sample item:", items[0]);

  // Persist page + items
  await writePageOnce(url, finalHtml);

  if (persistable.length) {
    await writeItems(persistable);
    log.info(
      `[teach] wrote ${persistable.length} items to storage (teach mode)`
    );
  } else {
    log.warn("[teach] nothing written — no persistable items");
  }

  // Persist updated profile (safe buckets only)
  {
    const u = new URL(url);
    const doc = {
      id: profile?.id,
      match: { host: u.host },
      buckets: {
        ...buckets,
        fields,
      },
      metrics: { items: persistable.length },
    };

    await upsertProfile(u.host, doc as any, finalHtml);
  }

  const stats = getStats();
  log.info(
    `[teach] Summary → pages:${stats.pages} html:${stats.pagesHtml} items:${stats.items}`
  );

  await browser.close();
}
