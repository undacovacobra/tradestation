import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { chromium, type Browser } from "playwright";
import { TradovateBrowser } from "../src/browser.js";

/**
 * The speed fix: when the bot already knows it's on the right account (armed),
 * switchAccount must NOT open the account menu — an entry is then just a click.
 * Runs the REAL browser methods against a mock trader. Skips if no Chromium.
 */

declare global {
  interface Window {
    __menuOpened: boolean;
    __lastClick: string | null;
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = "file://" + resolve(__dirname, "fixtures", "mock-trader.html");

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
  b.currentAccount = null;
  b.shotDir = tmpdir();
  b.config = { orderConfirmWaitMs: 100, switchSettleMs: 50, captureShots: false };
  return b;
}

test("armed switchAccount does NOT open the menu; entry is just the click", async (t) => {
  const browser = await launch();
  if (!browser) return t.skip("no Chromium available");
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 400 } });

    // Armed on 006: switch to 006 must be a no-op (no menu, no screen read).
    await page.goto(fixture);
    const b1 = fake(page);
    b1.currentAccount = "LFE05079261220006";
    await b1.switchAccount("LFE05079261220006");
    assert.equal(await page.evaluate(() => window.__menuOpened), false, "armed switch must not open the menu");
    await b1.clickOrder("buy", "LFE05079261220006");
    assert.equal(await page.evaluate(() => window.__lastClick), "buy", "should have clicked Buy Mkt");

    // Unknown but already on 006 (top bar matches): adopt without opening menu.
    await page.goto(fixture);
    const b2 = fake(page);
    await b2.switchAccount("LFE05079261220006");
    assert.equal(await page.evaluate(() => window.__menuOpened), false, "already-on account adopted without menu");
    assert.equal(b2.currentAccount, "LFE05079261220006");
    assert.equal(await b2.verifyActiveAccount("LFE0507926122000"), false, "account matching must not accept a prefix");

    // Need a different account: the menu DOES open and the row is picked.
    await page.goto(fixture);
    const b3 = fake(page);
    await b3.switchAccount("LFE05079261220007");
    assert.equal(await page.evaluate(() => window.__menuOpened), true, "switching accounts opens the menu");
    assert.equal(await page.evaluate(() => document.querySelector(".acctid")?.textContent), "LFE05079261220007");
    assert.equal(b3.currentAccount, "LFE05079261220007");

    // A hidden menu row must never prove the wrong account. This reproduces the
    // live SPA layout after the Funded account was selected manually.
    await page.setContent(`
      <div style="display:none">LFE05079261220006</div>
      <div class="acctid">LFF05079261220003</div>
      <button>Buy Mkt</button><button>Sell Mkt</button>
    `);
    const b4 = fake(page);
    assert.equal(await b4.verifyActiveAccount("LFE05079261220006"), false);
    assert.equal(await b4.verifyActiveAccount("LFF05079261220003"), true);

    // Additional prop firms can use a different Tradovate account prefix.
    await page.setContent(`
      <div class="acctid">PAAPEX91234567</div>
      <button>Buy Mkt</button><button>Sell Mkt</button>
    `);
    const b5 = fake(page);
    assert.equal(await b5.verifyActiveAccount("PAAPEX91234567"), true);

    await page.setContent(`
      <button class="acctid" onclick="document.querySelector('#accounts').style.display='block'">PAAPEX91234567</button>
      <div id="accounts" style="display:none"><div>PAAPEX91234567</div><div>TRADEIFY76543210</div></div>
      <button>Buy Mkt</button><button>Sell Mkt</button>
    `);
    const b6 = fake(page);
    assert.deepEqual(await b6.listAccounts(), ["PAAPEX91234567", "TRADEIFY76543210"]);
  } finally {
    await browser.close();
  }
});
