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
 * Run with:  npm run smoketest
 * A screenshot of every step is saved to screenshots/ so we can see what happened.
 */
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  log.warn("LIVE smoke test — this will place demo trades. Ctrl+C now if that's not what you want.");
  const ex = new TradovateExecutor(config);
  await ex.init();

  for (const account of config.accounts) {
    log.info(`──── Testing ${account.name} [${account.tradovateLabel}] ────`);
    await ex.placeOrder(account, {
      action: "buy",
      symbol: "(uses chart symbol)",
      quantity: 1,
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
