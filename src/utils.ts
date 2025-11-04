// src/utils.ts
import { readFileSync } from "node:fs";

export function loadSelectors(kind: string): Record<string, string[]> {
  const raw = readFileSync(`selectors/${kind}.json`, "utf8");
  return JSON.parse(raw);
}
