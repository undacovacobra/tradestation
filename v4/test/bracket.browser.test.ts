import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { TradovateBrowser } from "../src/browser.js";

const fixture = "file://" + resolve(dirname(fileURLToPath(import.meta.url)), "fixtures", "mock-atm.html");

async function launch(): Promise<Browser | null> {
  for (const executablePath of [process.env.PW_CHROMIUM, "/opt/pw-browsers/chromium", undefined]) {
    try { return await chromium.launch(executablePath ? { executablePath } : {}); } catch { /* try next */ }
  }
  return null;
}

function fake(page: unknown): any {
  const browser: any = Object.create(TradovateBrowser.prototype);
  browser.page = page;
  browser.loggedIn = true;
  browser.currentAccount = "ACCOUNT-1";
  browser.lastQty = null;
  browser.lastBracket = null;
  browser.shotDir = tmpdir();
  browser.config = { orderConfirmWaitMs: 100, switchSettleMs: 50, captureShots: false };
  return browser;
}

test("setBracket writes Take Profit and Stop Loss in dollars and caches", async (t) => {
  const launched = await launch();
  if (!launched) return t.skip("no Chromium available");
  try {
    const page = await launched.newPage({ viewport: { width: 900, height: 500 } });
    await page.goto(fixture);
    const browser = fake(page);
    await browser.setBracket(1500, 1000);
    assert.equal(await page.locator("#tp").inputValue(), "1500");
    assert.equal(await page.locator("#sl").inputValue(), "1000");
    assert.equal(await page.evaluate(() => (window as unknown as { dayGearClicks?: number }).dayGearClicks ?? 0), 0);
    assert.equal(browser.lastBracket, "1500/1000");
    await browser.setBracket(1500, 1000);
    assert.equal(browser.lastBracket, "1500/1000");
  } finally { await launched.close(); }
});

test("setBracket rejects one-sided or non-positive amounts", async (t) => {
  const launched = await launch();
  if (!launched) return t.skip("no Chromium available");
  try {
    const page = await launched.newPage();
    await page.goto(fixture);
    const browser = fake(page);
    await assert.rejects(() => browser.setBracket(0, 20), /positive/i);
    await assert.rejects(() => browser.setBracket(30, 0), /positive/i);
  } finally { await launched.close(); }
});
