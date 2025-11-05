import { run } from "./engine.js";
import { runRaw } from "./engine.raw.js";

async function main() {
  const args = process.argv.slice(2);
  const url = args.find((a) => a.startsWith("http"));
  if (!url) {
    console.error("usage: npm run dev -- <url> [--raw] [--no-headless] [--assist] [--teach]");
    process.exit(1);
  }

  const useRaw = args.includes("--raw") || args.includes("--no-class");
  const assist = args.includes("--assist") || args.includes("--assist-learn");
  const teach  = args.includes("--teach");

  // If --teach is on, force headful so the overlay can show
  const headless = teach ? false : !args.includes("--no-headless");

  if (useRaw) {
    await runRaw(url, { headless, assist, teach });
  } else {
    await run(url, { headless });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
