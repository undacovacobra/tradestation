import { config } from "./config.js";
import { TradovateExecutor } from "./executor/tradovate.js";
import { log } from "./logger.js";

/**
 * LIVE smoke test against the real Tradovate web trader.
 *
 * For each account in data/accounts.json it will: switch to the account,
 * click Buy, wait a few seconds, then click Exit (close). It uses whatever
 * symbol + quantity you have set on the Tradovate screen.
 *
 * ⚠️ This places REAL clicks. Only run it while logged into DEMO accounts, and
 * set your order size small (e.g. 1) on the Tradovate screen first.
 *
 * Run with:  npm run smoketest        (uses size 1)
 *            npm run smoketest 3      (uses size 3 — proves size-from-alert works)
 * A screenshot of every step is saved to screenshots/ so we can see what happened.
 */
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const size = Number(process.argv[2] ?? 1);
  if (!Number.isInteger(size) || size < 1) {
    throw new Error(`Bad size "${process.argv[2]}". Use a whole number, e.g. npm run smoketest 3`);
  }

  log.warn(`LIVE smoke test (size ${size}) — this will place demo trades. Ctrl+C now if that's not what you want.`);
  const ex = new TradovateExecutor(config);
  await ex.init();

  for (const account of config.accounts) {
    log.info(`──── Testing ${account.name} [${account.tradovateLabel}] @ size ${size} ────`);
    await ex.placeOrder(account, {
      action: "buy",
      symbol: "(uses chart symbol)",
      quantity: size,
      orderType: "market",
    });
    await wait(4_000);
    await ex.closePosition(account, "(uses chart symbol)");
    await wait(2_000);
  }

  log.info("Smoke test finished. Check the screenshots/ folder and your demo trade history.");
  await ex.shutdown();
}

main().catch((err) => {
  log.error("Smoke test failed:", err);
  process.exit(1);
});
