import { config } from "./config.js";
import { TradovateExecutor } from "./executor/tradovate.js";
import { log } from "./logger.js";

/**
 * SAFE account-switching test. Cycles through every account in
 * data/accounts.json and selects each one — placing NO orders. Safe to run any
 * time, market open or closed. Confirms login + account switching work before
 * we ever touch a Buy/Sell button.
 *
 * Run with:  npm run switchtest
 * Watch the browser: the ACCOUNT name at the top should change to each account.
 * A screenshot of each switch is saved to screenshots/.
 */
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  log.info("SAFE switch test — no orders are placed. Just switching accounts.");
  const ex = new TradovateExecutor(config);
  await ex.init();

  for (const account of config.accounts) {
    log.info(`Selecting ${account.name} [${account.tradovateLabel}]…`);
    await ex.selectAccount(account);
    await wait(2_500);
  }

  log.info("Switch test finished. Check that the account name changed each time.");
  await ex.shutdown();
}

main().catch((err) => {
  log.error("Switch test failed:", err);
  process.exit(1);
});
