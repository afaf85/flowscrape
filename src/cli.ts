// src/cli.ts
import { run } from "./engine.js";
import { runRaw } from "./engine.raw.js";

async function main() {
  const args = process.argv.slice(2);
  const url = args.find((a) => a.startsWith("http"));
  if (!url) {
    console.error("usage: npm run dev -- <url> [--raw] [--no-headless]");
    process.exit(1);
  }

  const headless = !args.includes("--no-headless");
  const useRaw = args.includes("--raw") || args.includes("--no-class");

  if (useRaw) {
    await runRaw(url, { headless });
  } else {
    await run(url, { headless });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
