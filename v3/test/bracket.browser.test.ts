import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { chromium, type Browser } from "playwright";
import { TradovateBrowser } from "../src/browser.js";

/**
 * setBracket against a mock ATM Settings dialog: opens the (labelled) gear,
 * sets Take Profit + Stop Loss in $ Value, and saves — verifying the numbers
 * stuck. Guards the dialog-driving logic and the esbuild __name gotcha. Skips
 * if no Chromium.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = "file://" + resolve(__dirname, "fixtures", "mock-atm.html");

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
  b.lastBracket = null;
  b.shotDir = tmpdir();
  b.config = { orderConfirmWaitMs: 100, switchSettleMs: 50, captureShots: false };
  return b;
}

test("setBracket writes Take Profit + Stop Loss and caches", async (t) => {
  const browser = await launch();
  if (!browser) return t.skip("no Chromium available");
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 500 } });
    await page.goto(fixture);
    const b = fake(page);

    await b.setBracket(30, 20);
    assert.equal(await page.evaluate(() => (document.getElementById("tp") as HTMLInputElement).value), "30");
    assert.equal(await page.evaluate(() => (document.getElementById("sl") as HTMLInputElement).value), "20");
    assert.equal(b.lastBracket, "30/20");

    // Same amounts again = cached no-op (and the dialog is closed, so if it
    // tried to re-open+set it would still succeed; the point is it returns fast).
    await b.setBracket(30, 20);
    assert.equal(b.lastBracket, "30/20");
  } finally {
    await browser.close();
  }
});

test("setBracket rejects non-positive amounts before touching the page", async (t) => {
  const browser = await launch();
  if (!browser) return t.skip("no Chromium available");
  try {
    const page = await browser.newPage();
    await page.goto(fixture);
    const b = fake(page);
    await assert.rejects(() => b.setBracket(0, 20), /positive/i);
    await assert.rejects(() => b.setBracket(30, 0), /positive/i);
  } finally {
    await browser.close();
  }
});
