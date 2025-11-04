// src/steps/steps.ts
import type { Page } from "playwright";

export async function waitIdle(page: Page, ms = 200) {
  await page.waitForTimeout(ms);
}

export async function maybeScroll(page: Page) {
  await page.evaluate(() => {
    window.scrollBy(0, window.innerHeight * 0.8);
  });
  await page.waitForTimeout(200);
}

export async function dismissModals(page: Page) {
  // basic common selectors; extend as needed
  const selectors = [
    "[data-popup-close]",
    ".modal__close",
    ".popup-close",
    "[aria-label='Close']",
    "[aria-label='Close dialog']",
  ];
  for (const sel of selectors) {
    const el = await page.$(sel);
    if (el) {
      await el.click().catch(() => {});
      await page.waitForTimeout(100);
    }
  }
}

export async function runStep(page: Page, step: any) {
  // generic executor if you need it
  if (step.click) {
    const el = await page.$(step.click);
    if (el) await el.click();
  }
  if (step.waitFor) {
    await page.waitForSelector(step.waitFor, { timeout: 3000 }).catch(() => {});
  }
}
