import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { TradovateBrowser } from "../src/browser.js";

const fixture = "file://" + resolve(dirname(fileURLToPath(import.meta.url)), "fixtures", "mock-login.html");

async function launch(): Promise<Browser | null> {
  for (const executablePath of [process.env.PW_CHROMIUM, "/opt/pw-browsers/chromium", undefined]) {
    try { return await chromium.launch(executablePath ? { executablePath } : {}); } catch { /* try next */ }
  }
  return null;
}

test("automatic login selects the Simulator environment", { timeout: 25_000 }, async (t) => {
  const launched = await launch();
  if (!launched) return t.skip("no Chromium available");
  try {
    const page = await launched.newPage();
    await page.goto(fixture);
    const browser: any = Object.create(TradovateBrowser.prototype);
    browser.page = page;
    browser.loggedIn = false;
    browser.shotDir = tmpdir();
    browser.config = { captureShots: false };
    await browser.tryAutoLogin();
    assert.equal(await page.getByText("Buy Mkt", { exact: true }).isVisible(), true);
  } finally { await launched.close(); }
});
