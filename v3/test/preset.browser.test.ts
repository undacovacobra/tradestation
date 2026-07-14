import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { chromium, type Browser } from "playwright";
import { TradovateBrowser } from "../src/browser.js";

/**
 * selectAtmPreset against a mock ATM dropdown: opens the combobox next to the
 * "ATM" label and clicks the option with the exact preset name, then verifies
 * the panel shows it. Guards the dropdown-driving logic. Skips if no Chromium.
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
  b.lastPreset = null;
  b.shotDir = tmpdir();
  b.config = { orderConfirmWaitMs: 100, switchSettleMs: 50, captureShots: false };
  return b;
}

const shown = (page: import("playwright").Page) =>
  page.evaluate(() => document.getElementById("atmbox")!.textContent);

test("selectAtmPreset opens the ATM dropdown and picks the named preset", async (t) => {
  const browser = await launch();
  if (!browser) return t.skip("no Chromium available");
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 500 } });
    await page.goto(fixture);
    const b = fake(page);

    await b.selectAtmPreset("50");
    assert.equal(await shown(page), "50", "panel should show preset 50");
    assert.equal(b.lastPreset, "50");

    await b.selectAtmPreset("funded");
    assert.equal(await shown(page), "funded");

    // Cached: same preset again is a no-op (still shows funded).
    await b.selectAtmPreset("funded");
    assert.equal(await shown(page), "funded");
  } finally {
    await browser.close();
  }
});

test("selectAtmPreset throws for a name that isn't in the dropdown", async (t) => {
  const browser = await launch();
  if (!browser) return t.skip("no Chromium available");
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 500 } });
    await page.goto(fixture);
    const b = fake(page);
    await assert.rejects(() => b.selectAtmPreset("999"), /wasn't in the dropdown|Couldn't open/i);
  } finally {
    await browser.close();
  }
});
