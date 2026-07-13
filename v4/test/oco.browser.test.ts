import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { TradovateBrowser } from "../src/browser.js";

const fixture = "file://" + resolve(dirname(fileURLToPath(import.meta.url)), "fixtures", "mock-oco.html");

async function launch(): Promise<Browser | null> {
  for (const executablePath of [process.env.PW_CHROMIUM, "/opt/pw-browsers/chromium", undefined]) {
    try { return await chromium.launch(executablePath ? { executablePath } : {}); } catch { /* next */ }
  }
  return null;
}

function fake(page: unknown): any {
  const browser: any = Object.create(TradovateBrowser.prototype);
  browser.page = page;
  browser.loggedIn = true;
  browser.currentAccount = "ACCOUNT-1";
  browser.lastQty = 2;
  browser.lastBracket = null;
  browser.shotDir = tmpdir();
  browser.accountIdPattern = /ACCOUNT-\d+/;
  browser.config = { orderConfirmWaitMs: 0, switchSettleMs: 0, captureShots: false };
  return browser;
}

test("fast preparation disables ATM and post-fill protection creates verified long OCO exits", async (t) => {
  const launched = await launch();
  if (!launched) return t.skip("no Chromium available");
  try {
    const page = await launched.newPage({ viewport: { width: 900, height: 600 } });
    await page.goto(fixture);
    const browser = fake(page);
    await browser.prepareFastAccount("ACCOUNT-1");
    assert.equal(await page.evaluate(() => (window as any).atmOff), true);
    const receipt = await browser.protectOpenPosition({
      id: "a1", name: "Eval", firm: "Firm", stage: "eval", connectionId: "c1", platformLabel: "ACCOUNT-1",
      enabled: true, status: "active", tags: [], targetPerContract: 1520, stopPerContract: 1000,
    }, { action: "buy", symbol: "MNQ1!", quantity: 2, test: false });
    assert.deepEqual({ tp: receipt.takeProfitPrice, sl: receipt.stopLossPrice, qty: receipt.quantity }, { tp: 20760, sl: 19500, qty: 2 });
    assert.equal(await page.locator("[data-working-order]").count(), 2);
  } finally { await launched.close(); }
});
