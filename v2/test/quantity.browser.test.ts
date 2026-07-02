import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { chromium, type Browser } from "playwright";
import { TradovateBrowser } from "../src/browser.js";

/**
 * Exercises the REAL TradovateBrowser.setQuantity against a shadow-DOM order
 * ticket (see fixtures/mock-ticket.html). This is what catches page-context
 * bugs like the esbuild `__name` regression that a type-check can't see.
 *
 * Skips gracefully if no Chromium can be launched in this environment.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = "file://" + resolve(__dirname, "fixtures", "mock-ticket.html");

async function launch(): Promise<Browser | null> {
  const candidates = [process.env.PW_CHROMIUM, "/opt/pw-browsers/chromium", undefined];
  for (const executablePath of candidates) {
    try {
      return await chromium.launch(executablePath ? { executablePath } : {});
    } catch {
      /* try the next */
    }
  }
  return null;
}

function fakeBrowser(page: unknown): { setQuantity(n: number): Promise<number> } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const b: any = Object.create(TradovateBrowser.prototype);
  b.page = page;
  b.shotDir = tmpdir();
  b.config = { captureShots: false, orderConfirmWaitMs: 300, switchSettleMs: 200 };
  return b;
}

test("setQuantity drives a shadow-DOM order ticket", async (t) => {
  const browser = await launch();
  if (!browser) return t.skip("no Chromium available in this environment");
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 500 } });

    // Editable input -> typing path.
    await page.goto(fixture);
    const b1 = fakeBrowser(page);
    assert.equal(await b1.setQuantity(3), 3, "should type 3 into the box");
    assert.equal(await b1.setQuantity(3), 3, "already-correct path returns fast");
    assert.equal(await b1.setQuantity(10), 10, "should retype to 10");

    // Read-only input -> must use the preset dropdown.
    await page.goto(fixture + "?readonly=1");
    const b2 = fakeBrowser(page);
    assert.equal(await b2.setQuantity(15), 15, "should pick 15 from the dropdown");

    // A size the dropdown doesn't offer must fail safe (no silent wrong size).
    await assert.rejects(() => b2.setQuantity(7), /Couldn't set the size/);
  } finally {
    await browser.close();
  }
});
