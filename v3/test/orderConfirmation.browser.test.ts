import test from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser } from "playwright";
import { tmpdir } from "node:os";

import { TradovateBrowser } from "../src/browser.js";

async function launch(): Promise<Browser | null> {
  for (const executablePath of [process.env.PW_CHROMIUM, "/opt/pw-browsers/chromium", undefined]) {
    try { return await chromium.launch(executablePath ? { executablePath } : {}); } catch { /* next */ }
  }
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fake(page: unknown, wait = 500): any {
  const b: any = Object.create(TradovateBrowser.prototype);
  b.page = page;
  b.loggedIn = true;
  b.currentAccount = "A";
  b.lastQty = null;
  b.lastPreset = null;
  b.shotDir = tmpdir();
  b.config = { orderConfirmWaitMs: wait, switchSettleMs: 0, captureShots: false };
  return b;
}

test("a delayed Tradovate confirmation is awaited and clicked", async (t) => {
  const browser = await launch();
  if (!browser) return t.skip("no Chromium available");
  try {
    const page = await browser.newPage();
    await page.setContent(`<button id="buy">Buy Mkt</button><button>Sell Mkt</button><script>
      document.querySelector('#buy').onclick = () => setTimeout(() => {
        const confirm = document.createElement('button');
        confirm.id = 'confirm'; confirm.textContent = 'Confirm';
        confirm.onclick = () => confirm.dataset.clicked = 'yes';
        document.body.appendChild(confirm);
      }, 100);
    </script>`);

    await fake(page).clickOrder("buy", "A");

    assert.equal(await page.locator("#confirm").getAttribute("data-clicked"), "yes");
  } finally {
    await browser.close();
  }
});

test("a visible confirmation that cannot be clicked fails the order path", async (t) => {
  const browser = await launch();
  if (!browser) return t.skip("no Chromium available");
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(350);
    await page.setContent(`<button id="buy">Buy Mkt</button><button>Sell Mkt</button><button disabled>Confirm</button>`);
    await assert.rejects(() => fake(page, 300).clickOrder("buy", "A"), /confirm/i);
  } finally {
    await browser.close();
  }
});
