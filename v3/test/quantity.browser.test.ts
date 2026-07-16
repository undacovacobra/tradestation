import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { chromium, type Browser } from "playwright";
import { TradovateBrowser } from "../src/browser.js";

/**
 * setQuantity against a REAL browser + a shadow-DOM order ticket. Guards two
 * things at once: (1) it pierces shadow DOM and prefers the qty-labelled box
 * over a decoy numeric field, and (2) the whole thing runs inside page.evaluate
 * without tripping esbuild's `__name` helper (the old nested-function gotcha).
 * Skips if no Chromium is available.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = "file://" + resolve(__dirname, "fixtures", "mock-ticket.html");

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

const qtyValue = (page: import("playwright").Page) =>
  page.evaluate(
    () =>
      (document.querySelector("order-ticket")!.shadowRoot!.querySelector('input[aria-label="Order Qty"]') as HTMLInputElement)
        .value,
  );

test("setQuantity sets the shadow-DOM qty box and verifies it", async (t) => {
  const browser = await launch();
  if (!browser) return t.skip("no Chromium available");
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 400 } });
    await page.goto(fixture);
    const b = fake(page);

    await b.setQuantity(5);
    assert.equal(await qtyValue(page), "5", "qty box should read 5");
    assert.equal(b.lastQty, 5);
    // Decoy price field must be untouched.
    const price = await page.evaluate(
      () =>
        (document.querySelector("order-ticket")!.shadowRoot!.querySelector('input[aria-label="Limit Price"]') as HTMLInputElement)
          .value,
    );
    assert.equal(price, "0", "price field must not be changed");

    await b.setQuantity(12);
    assert.equal(await qtyValue(page), "12", "qty box should update to 12");
    b.verifyActiveAccount = async () => true;
    assert.equal(await b.verifySequentialPreparedOrderState("LFE05079261220006", "", 12), true);
    assert.equal(await b.verifySequentialPreparedOrderState("LFE05079261220006", ""), true, "omitted alert size still verifies a positive visible ticket size");

    // Same size again = cached no-op; the box stays put.
    await b.setQuantity(12);
    assert.equal(await qtyValue(page), "12");
  } finally {
    await browser.close();
  }
});

test("setQuantity finds Tradovate's 'Select value' form-control box, not the search box", async (t) => {
  const browser = await launch();
  if (!browser) return t.skip("no Chromium available");
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 400 } });
    await page.goto("file://" + resolve(__dirname, "fixtures", "mock-ticket-tradovate.html"));
    const b = fake(page);

    await b.setQuantity(4);
    const qty = await page.evaluate(() => (document.querySelector(".form-control") as HTMLInputElement).value);
    const search = await page.evaluate(() => (document.querySelector(".search-box--input") as HTMLInputElement).value);
    assert.equal(qty, "4", "the form-control size box should read 4");
    assert.equal(search, "", "the symbol search box must be left alone");

    // REPLACE, don't append/add: box already holds 4, set it to 2 -> exactly 2
    // (not "42" from appending, and not 6 from adding).
    await b.setQuantity(2);
    const replaced = await page.evaluate(() => (document.querySelector(".form-control") as HTMLInputElement).value);
    assert.equal(replaced, "2", "setting over an existing value must replace it, not append/add");
  } finally {
    await browser.close();
  }
});

test("setQuantity rejects a bad size before touching the page", async (t) => {
  const browser = await launch();
  if (!browser) return t.skip("no Chromium available");
  try {
    const page = await browser.newPage();
    await page.goto(fixture);
    const b = fake(page);
    await assert.rejects(() => b.setQuantity(0), /1 or more/i);
    await assert.rejects(() => b.setQuantity(-3), /1 or more/i);
  } finally {
    await browser.close();
  }
});
