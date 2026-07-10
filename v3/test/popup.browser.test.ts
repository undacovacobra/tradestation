import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { chromium, type Browser } from "playwright";
import { TradovateBrowser } from "../src/browser.js";

/**
 * The popup-killer, tested against the real failure mode: a dialog + backdrop
 * covering the trader so the Exit click times out. V3 must clear the popup and
 * complete the click. Skips if no Chromium is available.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = "file://" + resolve(__dirname, "fixtures", "mock-popup.html");

async function launch(): Promise<Browser | null> {
  for (const executablePath of [process.env.PW_CHROMIUM, "/opt/pw-browsers/chromium", undefined]) {
    try {
      return await chromium.launch(executablePath ? { executablePath } : {});
    } catch {
      /* next */
    }
  }
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fake(page: unknown): any {
  const b: any = Object.create(TradovateBrowser.prototype);
  b.page = page;
  b.loggedIn = true;
  b.currentAccount = "LFE05079261220006";
  b.lastQty = null;
  b.shotDir = tmpdir();
  b.config = { orderConfirmWaitMs: 100, switchSettleMs: 50, captureShots: false };
  return b;
}

test("dismissPopups clears a blocking dialog (and reports none when clean)", async (t) => {
  const browser = await launch();
  if (!browser) return t.skip("no Chromium available");
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 400 } });
    await page.goto(fixture);
    const b = fake(page);

    const cleared = await b.dismissPopups();
    assert.equal(cleared, true, "should find and clear the popup");
    const backdropGone = await page.evaluate(() => document.getElementById("backdrop") === null);
    assert.equal(backdropGone, true, "backdrop should be removed");

    const again = await b.dismissPopups();
    assert.equal(again, false, "nothing left to clear on a clean screen");
  } finally {
    await browser.close();
  }
});

test("clickExit succeeds even when a popup is blocking the screen", async (t) => {
  const browser = await launch();
  if (!browser) return t.skip("no Chromium available");
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 400 } });
    await page.goto(fixture);
    const b = fake(page);

    // The backdrop intercepts the first click attempt; the bot must clear the
    // popup and retry — this is exactly the stuck-trade failure from live.
    await b.clickExit("LFE05079261220006");
    const clicked = await page.evaluate(() => (window as unknown as { __lastClick: string | null }).__lastClick);
    assert.equal(clicked, "exit", "Exit must be clicked after the popup is cleared");
  } finally {
    await browser.close();
  }
});
