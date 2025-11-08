// src/cli.ts (entry)
import { run } from "./engine.js";
import { runRaw } from "./engine.raw.js";
import { runTeach } from "./engine.teach.js";

async function main() {
  const args = process.argv.slice(2);
  const url = args.find((a) => a.startsWith("http"));

  if (!url) {
    console.error(
      "usage: npm run dev -- <url> [--raw] [--no-headless] [--assist] [--teach]"
    );
    process.exit(1);
  }

  const useRaw  = args.includes("--raw") || args.includes("--no-class");
  const assist  = args.includes("--assist") || args.includes("--assist-learn");
  const teach   = args.includes("--teach");
  const noHead  = args.includes("--no-headless");

  // If --teach: run headful by default so overlay is visible
  const headless = teach ? false : !noHead;

  if (teach) {
    // ✅ PURE TEACH MODE
    // Uses engine.teach.ts → extractTeachItems → writeItems(items)
    await runTeach(url, { headless });
  } else if (useRaw) {
    // ✅ RAW / AUTODETECT MODE
    // teach flag is false here; we don’t block on overlay
    await runRaw(url, {
      headless,
      assist,
      teach: false,
    });
  } else {
    // ✅ NORMAL ENGINE (router + autodetect + learned)
    await run(url, { headless });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
