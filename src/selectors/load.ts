import { readFileSync } from "node:fs";

export function loadSelectorsForKind(kind: string) {
  try {
    const path = `./selectors/${kind}.json`;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}
