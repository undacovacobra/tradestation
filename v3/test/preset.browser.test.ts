import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { chromium, type Browser } from "playwright";
import { TradovateBrowser } from "../src/browser.js";

/**
 * selectAtmPreset against the live Tradovate dropdown shape: the opener is a
 * combobox, while the floating menu items have no listbox/option roles and no
 * menu/dropdown class names. The bot must still click the exact visible preset
 * and verify the panel shows it. Skips if no Chromium.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = "file://" + resolve(__dirname, "fixtures", "mock-atm.html");
const rolelessFixture = "file://" + resolve(__dirname, "fixtures", "mock-atm-roleless.html");

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

test("selectAtmPreset picks a visible preset from Tradovate's role-less popup", async (t) => {
  const browser = await launch();
  if (!browser) return t.skip("no Chromium available");
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 500 } });
    await page.goto(rolelessFixture);
    const b = fake(page);

    await b.selectAtmPreset("50");
    assert.equal(await shown(page), "50", "panel should show preset 50");
    assert.equal(b.lastPreset, "50");
    assert.equal(await page.locator("body").getAttribute("data-gear-clicked"), null, "ATM gear must not be clicked");

    await b.selectAtmPreset("funded");
    assert.equal(await shown(page), "funded");

    // Cached: same preset again is a no-op (still shows funded).
    await b.selectAtmPreset("funded");
    assert.equal(await shown(page), "funded");
  } finally {
    await browser.close();
  }
});

test("an open dropdown item is not mistaken for the selected ATM preset", async (t) => {
  const browser = await launch();
  if (!browser) return t.skip("no Chromium available");
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 500 } });
    await page.goto(fixture);
    const b = fake(page);

    await page.locator("#atmbox").click();
    await b.selectAtmPreset("25", true);

    assert.equal(await shown(page), "25", "the preset must actually be applied, not merely visible in the open menu");
    assert.equal(
      await page.locator("body").getAttribute("data-unrelated-clicked"),
      null,
      "an unrelated visible numeric match must never be clicked",
    );
  } finally {
    await browser.close();
  }
});

test("a closed ATM popup ignores unrelated visible numeric text", async (t) => {
  const browser = await launch();
  if (!browser) return t.skip("no Chromium available");
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 500 } });
    await page.goto(fixture);
    const b = fake(page);

    await b.selectAtmPreset("25", true);

    assert.equal(await shown(page), "25");
    assert.equal(
      await page.locator("body").getAttribute("data-unrelated-clicked"),
      null,
      "the always-visible 25 outside the popup must not be clicked",
    );
    assert.equal(
      await page.locator("body").getAttribute("data-changing-clicked"),
      null,
      "unrelated text that changes to 25 while the popup opens must not be clicked",
    );
    assert.equal(await page.locator("body").getAttribute("data-gear-clicked"), null, "ATM gear must not be clicked");
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
    assert.equal(await shown(page), "jj eval", "a missing preset must leave the current ATM unchanged");
  } finally {
    await browser.close();
  }
});

test("selectAtmPreset works when the dropdown is ALREADY open (doesn't toggle it shut)", async (t) => {
  const browser = await launch();
  if (!browser) return t.skip("no Chromium available");
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 500 } });
    await page.goto(fixture);
    const b = fake(page);
    // Leave the ATM list open, as if a prior action left it that way. The
    // control is a toggle, so a naive click would close it — the old bug.
    await page.evaluate(() => { (document.getElementById("atmlist") as HTMLElement).style.display = "block"; });
    await b.selectAtmPreset("25", true);
    assert.equal(await shown(page), "25", "should select 25 even though the dropdown started open");
  } finally {
    await browser.close();
  }
});
