// src/engine.ts
import { chromium, Page } from "playwright";
import { classifyPage } from "./detect/router.js";
import { autodetectFromHtml } from "./detect/autodetect.js";
import { loadSelectorsForKind } from "./selectors/load.js";
import {
  loadLearnedSelectors,
  getLearnedForHost,
  saveLearnedForHost,
} from "./learn/learn.js";
import { extractItems } from "./extract/extract.js";
import { writePageOnce, writeItems, getStats } from "./storage/storage.js";
import {
  waitIdle,
  maybeScroll,
  dismissModals,
  runStep,
} from "./steps/steps.js";

/* ============ logging ============ */
const LOG_LEVEL = (process.env.FS_LOG_LEVEL || "info").toLowerCase();
const ORDER: Record<string, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};
function canLog(level: string) {
  return (ORDER[level] ?? 20) >= (ORDER[LOG_LEVEL] ?? 20);
}
const log = {
  debug: (...a: any[]) => canLog("debug") && console.log("[debug]", ...a),
  info: (...a: any[]) => canLog("info") && console.log("[info]", ...a),
  warn: (...a: any[]) => canLog("warn") && console.log("[warn]", ...a),
  error: (...a: any[]) => canLog("error") && console.log("[error]", ...a),
};

type RunOpts = {
  headless?: boolean;
  blockHeavy?: boolean;
};

export async function run(url: string, opts: RunOpts = {}) {
  // load disk cache first
  loadLearnedSelectors();

  const browser = await chromium.launch({ headless: opts.headless ?? true });
  const page = await browser.newPage();

  log.info("launching:", url);

  // 1) initial load (SAFE)
  const initialOk = await safeInitialGoto(page, url);
  if (initialOk) {
    await waitIdle(page, 200);
  } else {
    log.warn(
      "[FlowScrape] initial goto failed, continuing to try flow/extract anyway."
    );
  }

  // 1.1) safe content fetch
  const initialHtml = await safeGetContent(page);
  log.debug("initial HTML length:", initialHtml.length);

  // 2) classify
  const cls = await classifyPage(initialHtml, url);
  const kind = typeof cls === "string" ? cls : cls.kind;
  log.info("[FlowScrape] Classified as:", kind);

  // 3–6
  const flow = await loadFlow(kind);
  const baseSel = loadSelectorsForKind(kind);
  const host = new URL(url).host;

  // ↓↓↓ get learned and normalize so extract can use {list, fields: {...}}
  const learnedRaw = getLearnedForHost(host);
  const learnedForHost = normalizeLearned(learnedRaw);

  const auto = autodetectFromHtml(initialHtml, url);

  // 7) selectors
  const { listSelectors, fields } = buildSelectorConfig({
    base: baseSel,
    auto,
    learned: learnedForHost, // ← pass normalized here too
  });
  // noisy → debug only
  log.debug("listSelectors:", listSelectors);
  log.debug("ensuredFields:", JSON.stringify(fields, null, 2));

  // 8) flow
  log.debug("running flow...");
  await executeFlow(page, flow, { url });

  // 8.1) pause (allow lazy stuff to pop)
  await page.waitForTimeout(2000);

  // 8.2) wait for best list selector (SMART + SAFE)
  if (listSelectors.length) {
    log.debug("waiting for best product list selector...");

    const foundSel = await Promise.any(
      listSelectors.map((sel) =>
        page
          .waitForSelector(sel, { timeout: 6000 })
          .then(() => sel)
          .catch(() => null)
      )
    ).catch(() => null);

    if (foundSel) {
      log.info(`best list selector found: ${foundSel}`);
    } else {
      log.warn("no list selectors matched after timeout.");

      // fallback by density (still debug)
      let bestSel: string | null = null;
      let maxCount = 0;
      for (const sel of listSelectors) {
        const count = await page.$$eval(sel, (els) => els.length).catch(() => 0);
        if (count > maxCount) {
          bestSel = sel;
          maxCount = count;
        }
      }
      if (bestSel) {
        log.debug(
          `fallback selector chosen by density: ${bestSel} (${maxCount} nodes)`
        );
      }
    }

    // 8.3) wait for strong product signals (price / image / cart button)
    try {
      await page.waitForSelector(
        [
          ".price, .product-card__price, .product-card__price-wrapper, .product-price, .css-196r7ux, [data-testid*='price']",
          "img[src], picture img",
          "button[aria-label*='add' i], .add-to-cart",
        ].join(", "),
        { timeout: 3000 }
      );
      log.debug("product signals detected (price/image/cart).");
    } catch {
      log.debug("no clear product signals found (continuing anyway).");
    }
  }

  // 9) final HTML (SAFE)
  const finalHtml = await safeGetContent(page);
  log.debug("final HTML length:", finalHtml.length);

  // quick count check inside browser before extraction (SAFE)
  if (listSelectors.length) {
    const gridCount = await page
      .$$eval(listSelectors[0], (els) => els.length)
      .catch(() => 0);
    log.debug(
      `${gridCount} elements matched "${listSelectors[0]}" before extraction.`
    );
  }

  // 10) extract  ← HERE
  const items = extractItems(finalHtml, listSelectors, fields, learnedForHost);
  log.info("extracted items:", items.length);

  if (items.length) log.debug("first item sample:", items[0]);

  // 11) persist
  await writePageOnce(url, finalHtml);
  if (items.length) {
    await writeItems(items);

    const okToPersist =
      fields && typeof fields === "object" && !Array.isArray(fields);

    if (okToPersist) {
      // save the normalized version so next time resolvers can re-use signals
      saveLearnedForHost(host, {
        list: listSelectors,
        fields,
      });
      log.info("learned selectors saved for host:", host);
    } else {
      log.debug(
        "NOT saving learned selectors – fields structure looked invalid"
      );
    }
  }

  const stats = getStats();
  log.info(
    `[FlowScrape] Summary → pages:${stats.pages} html:${stats.pagesHtml} items:${stats.items}  (storage/pages.jsonl, storage/pages.html.jsonl, storage/items.jsonl)`
  );

  await browser.close();
}

// put this near the top of the file (outside run)
function normalizeLearned(raw: any) {
  if (!raw) return {};
  if (raw.fields) return raw; // already { list, fields: {...} }
  const { list, ...rest } = raw;
  return {
    list,
    fields: rest, // title, price, image...
  };
}


/* ============ helpers ============ */

async function safeGetContent(page: Page): Promise<string> {
  try {
    return await page.content();
  } catch {
    try {
      await page.waitForLoadState("domcontentloaded", { timeout: 2000 });
    } catch {
      // ignore
    }
    try {
      return await page.content();
    } catch {
      console.warn(
        "[FlowScrape] WARN: could not get page.content(), returning empty HTML."
      );
      return "";
    }
  }
}

function buildSelectorConfig({
  base,
  auto,
  learned,
}: {
  base: any;
  auto: any;
  learned: any;
}) {
  let learnedList: string[] = [];
  if (learned?.list) {
    if (Array.isArray(learned.list)) {
      learnedList = learned.list.map((s: string) => s.trim()).filter(Boolean);
    } else if (typeof learned.list === "string") {
      learnedList = learned.list
        .split(",")
        .map((s: string) => s.trim())
        .filter(Boolean);
    }
  }

  let autoList: string[] = [];
  if (auto?.listSelector) {
    autoList = auto.listSelector
      .split(",")
      .map((s: string) => s.trim())
      .filter(Boolean);
  }

  let baseList: string[] = [];
  if (base?.list) {
    baseList = base.list
      .split(",")
      .map((s: string) => s.trim())
      .filter(Boolean);
  }

  const listSelectors = [
    ...learnedList,
    ...autoList,
    ...baseList,
    ".productGrid .card-title a[href]",
    ".productGrid a.card-figure[href]",
    "[data-product-id] a[href]",
    "a[href*='/product']",
    "a[href*='/products/']",
  ].filter(Boolean);

  const seen = new Set<string>();
  const deduped = listSelectors.filter((sel) => {
    if (seen.has(sel)) return false;
    seen.add(sel);
    return true;
  });

  const fields = {
    ...(base?.fields || {}),
    ...(auto?.fields || {}),
    ...(learned?.fields || {}),
  };

  return { listSelectors: deduped, fields };
}

async function loadFlow(kind: string) {
  return {
    steps: [{ maybeScroll: true }, { dismissModals: true }],
  };
}

async function executeFlow(page: Page, flow: any, ctx: { url: string }) {
  for (const step of flow.steps ?? []) {
    if (step.goto) {
      const target = step.goto.replace("{{ url }}", ctx.url);
      const ok = await safeGotoStep(page, target);
      if (!ok) {
        console.warn("[FlowScrape] step.goto failed, skipping to next step");
      } else {
        await waitIdle(page, 200);
      }
      continue;
    }

    if (step.maybeScroll) {
      try {
        await maybeScroll(page);
      } catch (err: any) {
        console.warn("[FlowScrape] maybeScroll failed:", err.message);
      }
      continue;
    }

    if (step.dismissModals) {
      try {
        await dismissModals(page);
      } catch (err: any) {
        console.warn("[FlowScrape] dismissModals failed:", err.message);
      }
      continue;
    }

    if (typeof runStep === "function") {
      try {
        await runStep(page, step);
      } catch (err: any) {
        console.warn(
          "[FlowScrape] runStep failed for",
          JSON.stringify(step),
          err.message
        );
      }
    }
  }
}

async function safeGotoStep(page: Page, target: string): Promise<boolean> {
  try {
    await page.goto(target, {
      waitUntil: "domcontentloaded",
      timeout: 25000,
    });
    return true;
  } catch (err: any) {
    const msg = err?.message || "";
    if (/ERR_TOO_MANY_REDIRECTS/i.test(msg)) {
      console.warn("[FlowScrape] WARN: too many redirects for", target);
    } else if (err.name === "TimeoutError") {
      console.warn("[FlowScrape] WARN: timeout while loading", target);
    } else {
      console.warn("[FlowScrape] WARN: goto failed for", target, msg);
    }
    return false;
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
    const msg = err?.message || "";
    if (err.name === "TimeoutError") {
      console.warn("[FlowScrape] WARN: initial goto timeout:", url);
    } else if (/ERR_TOO_MANY_REDIRECTS/i.test(msg)) {
      console.warn("[FlowScrape] WARN: initial goto too many redirects:", url);
    } else {
      console.warn("[FlowScrape] WARN: initial goto failed:", url, msg);
    }
    return false;
  }
}
