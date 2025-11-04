// src/storage/storage.ts
import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

if (!existsSync("storage")) mkdirSync("storage");

const seenPages = new Set<string>();

type Stats = {
  pages: number;
  pagesHtml: number;
  items: number;
  products: number;
};

const stats: Stats = {
  pages: 0,
  pagesHtml: 0,
  items: 0,
  products: 0,
};

export async function writePageOnce(url: string, html: string) {
  const key = hash(url);
  if (seenPages.has(key)) return;
  seenPages.add(key);

  appendFileSync("storage/pages.jsonl", JSON.stringify({ url, ts: Date.now() }) + "\n");
  appendFileSync("storage/pages.html.jsonl", JSON.stringify({ url, html, ts: Date.now() }) + "\n");

  stats.pages += 1;
  stats.pagesHtml += 1;
}

export async function writeItems(items: any[]) {
  for (const item of items) {
    appendFileSync("storage/items.jsonl", JSON.stringify(item) + "\n");
    stats.items += 1;
  }
  // products == items for now
  stats.products = stats.items;
}

export function getStats() {
  return stats;
}

function hash(s: string) {
  return createHash("sha1").update(s).digest("hex");
}
