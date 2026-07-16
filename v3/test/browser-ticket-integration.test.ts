import assert from "node:assert/strict";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { chromium, type Browser } from "playwright";
import { TradovateBrowser } from "../src/browser.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = `file://${resolve(here, "fixtures", "two-independent-tickets.html")}`;

async function launch(): Promise<Browser | null> {
  for (const executablePath of [process.env.PW_CHROMIUM, undefined]) {
    try { return await chromium.launch(executablePath ? { executablePath } : {}); } catch { /* next */ }
  }
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fake(page: unknown): any {
  const browser: any = Object.create(TradovateBrowser.prototype);
  browser.page = page;
  browser.loggedIn = true;
  browser.currentAccount = null;
  browser.lastQty = null;
  browser.lastPreset = null;
  browser.shotDir = tmpdir();
  browser.config = { orderConfirmWaitMs: 0, switchSettleMs: 0, captureShots: false };
  return browser;
}

test("Tradovate browser implements the lane-scoped adapter surface", () => {
  const prototype = TradovateBrowser.prototype as unknown as Record<string, unknown>;
  for (const method of [
    "inspectCapabilities",
    "armForLane",
    "readLaneEquity",
    "selectLaneAtmPreset",
    "setLaneQuantity",
    "clickLaneOrder",
    "clickLaneExit",
    "verifyLaneAccount",
  ]) assert.equal(typeof prototype[method], "function", `${method} must exist`);
});

test("Tradovate browser exposes proven lane-scoped ticket operations", async (t) => {
  const chromiumBrowser = await launch();
  if (!chromiumBrowser) return t.skip("no Chromium available");
  try {
    const page = await chromiumBrowser.newPage();
    await page.goto(fixture);
    const browser = fake(page);

    const capability = await browser.inspectCapabilities();
    assert.equal(capability.mode, "dual-ticket");
    assert.equal(await page.locator("body").getAttribute("data-order-clicks"), null);

    await browser.armForLane("funded", "F2");
    await browser.selectLaneAtmPreset("funded", "funded-2");
    await browser.setLaneQuantity("funded", 8);
    assert.equal(await browser.verifyLaneAccount("funded", "F2"), true);
    assert.equal(await browser.verifyPreparedOrderState("funded", "F2", "funded-2", 8), true);
    await page.locator('[data-atlas-ticket="funded"] [data-atlas-atm]').selectOption("funded");
    assert.equal(await browser.verifyPreparedOrderState("funded", "F2", "funded-2", 8), false);
    await browser.selectLaneAtmPreset("funded", "funded-2");
    await browser.clickLaneOrder("funded", "buy", "F2");
    assert.equal(await page.locator("body").getAttribute("data-last-click"), "funded:data-atlas-buy");
    await browser.clickLaneExit("evals", "E1");
    assert.equal(await page.locator("body").getAttribute("data-last-click"), "evals:data-atlas-exit");
  } finally {
    await chromiumBrowser.close();
  }
});
