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
  } finally {
    await browser.close();
  }
});

test("switchAccount scrolls a long account menu to reach a row below the fold", async (t) => {
  const browser = await launch();
  if (!browser) return t.skip("no Chromium available");
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 500 } });
    const ids = [
      "LFE05079261220021", "LFF05079261220004", "LFF05079261220003", "LFE05079261220022",
      "LFF05079261220001", "LFE05079261220006", "LFF05079261220002", "LFF05079261220005",
    ];
    await page.setContent(`
      <div><span class="acctid" onclick="document.getElementById('m').style.display='block'">${ids[0]}</span></div>
      <div id="m" style="display:none;height:120px;overflow-y:auto;width:260px">
        ${ids.map((id) => `<div style="padding:10px" onclick="document.querySelector('.acctid').textContent='${id}';document.getElementById('m').style.display='none'">${id} Demo &amp; Active</div>`).join("")}
      </div>`);
    const b = fake(page);
    b.currentAccount = ids[0];
    b.requireLoggedIn = async () => {}; // this unit only exercises menu scrolling

    // The target is the last row, well below the 120px fold — the old reader gave
    // up here; now it scrolls the menu until the row renders and clicks it.
    await b.switchAccount("LFF05079261220005");
    assert.equal(await page.evaluate(() => document.querySelector(".acctid")?.textContent), "LFF05079261220005");
    assert.equal(b.currentAccount, "LFF05079261220005");
  } finally {
    await browser.close();
  }
});
