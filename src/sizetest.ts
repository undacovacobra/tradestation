import { config } from "./config.js";
import { TradovateExecutor } from "./executor/tradovate.js";
import { log } from "./logger.js";

/**
 * SAFE size test — sets the order size box only, places NO order.
 *
 * The bot reads the contract size from each TradingView alert and types it into
 * the size box next to Buy/Sell. This test proves that typing works without
 * placing any trade, so it's fine to run any time (market open or closed).
 *
 * Usage:  npm run sizetest 3     (try size 3; defaults to 3 if omitted)
 * A screenshot is saved to screenshots/ so we can confirm the box changed.
 */
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const size = Number(process.argv[2] ?? 3);
  if (!Number.isInteger(size) || size < 1) {
    throw new Error(`Bad size "${process.argv[2]}". Use a whole number, e.g. npm run sizetest 3`);
  }

  log.info(`SAFE size test — will set the size box to ${size}. No orders are placed.`);
  const ex = new TradovateExecutor(config);
  await ex.init();

  // Print all inputs first so we can see the screen layout if anything fails.
  await ex.debugToolbarInputs();
  await ex.setOrderSize(size);

  log.info(`Done. The size box should now read ${size}. Check the screenshots/ folder.`);
  await wait(3_000);
  await ex.shutdown();
}

main().catch((err) => {
  log.error("Size test failed:", err);
  process.exit(1);
});
