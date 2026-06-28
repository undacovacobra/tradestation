import { mkdirSync } from "node:fs";
import { chromium } from "playwright";
import { config } from "../config.js";
import { log } from "../logger.js";

/**
 * Opens the Tradovate web trader in a visible, persistent browser so you can:
 *   1. Log in once (incl. 2FA) — the session is saved to SESSION_DIR.
 *   2. Right-click → Inspect the account dropdown, symbol box, qty box, and
 *      Buy/Sell/Close buttons to confirm the selectors in tradovate.ts.
 *
 * Run with: npm run calibrate
 * Leave the window open as long as you need; press Ctrl+C here when done.
 */
async function main() {
  mkdirSync(config.sessionDir, { recursive: true });
  log.info(`Opening ${config.tradovateUrl} with persistent session ${config.sessionDir}`);
  const context = await chromium.launchPersistentContext(config.sessionDir, {
    headless: false,
    viewport: { width: 1440, height: 900 },
  });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(config.tradovateUrl, { waitUntil: "domcontentloaded" });

  log.info("Browser is open. Log in, then inspect the controls. Press Ctrl+C to finish.");
  // Keep the process alive until the user closes the window or hits Ctrl+C.
  await new Promise<void>((resolve) => {
    context.on("close", () => resolve());
    process.on("SIGINT", () => resolve());
  });
  await context.close().catch(() => {});
}

main().catch((err) => {
  log.error("Calibration failed:", err);
  process.exit(1);
});
