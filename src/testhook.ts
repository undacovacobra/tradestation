import { config } from "./config.js";
import { log } from "./logger.js";

/**
 * Fires sample TradingView-style alerts at your locally running bot so you can
 * confirm the webhook works — without TradingView, without the market being
 * open, and (in dryrun mode) without touching any broker.
 *
 * Usage:
 *   1. In one window:  npm start           (leave it running)
 *   2. In another:     npm run testhook
 *
 * You should see the first window log that it received a buy, then a close.
 */
const url = `http://localhost:${config.port}/webhook`;

async function send(label: string, body: Record<string, unknown>): Promise<void> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: config.webhookSecret, ...body }),
    });
    const text = await res.text();
    log.info(`${label}: HTTP ${res.status} → ${text}`);
  } catch (err) {
    log.error(
      `${label}: could not reach ${url}. Is the bot running? Open another window and run "npm start" first.`,
    );
    throw err;
  }
}

async function main() {
  log.info(`Sending test alerts to ${url}`);
  await send("ENTRY (buy)", { action: "buy", symbol: "MNQ", quantity: 1 });
  await new Promise((r) => setTimeout(r, 1_500));
  await send("EXIT (close)", { action: "close", symbol: "MNQ" });
  log.info("Done. Check the bot window — it should show the buy then the close (and rotate to the next account).");
}

main().catch(() => process.exit(1));
