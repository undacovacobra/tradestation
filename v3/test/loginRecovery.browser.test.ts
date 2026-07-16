import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { chromium, type Browser, type Page } from "playwright";
import { TradovateBrowser } from "../src/browser.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = "file://" + resolve(__dirname, "fixtures", "mock-login-recovery.html");

async function launch(): Promise<Browser | null> {
  for (const executablePath of [process.env.PW_CHROMIUM, undefined]) {
    try {
      return await chromium.launch(executablePath ? { executablePath } : {});
    } catch {
      // Try the next configured browser.
    }
  }
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fake(page: Page): any {
  const browser: any = Object.create(TradovateBrowser.prototype);
  browser.page = page;
  browser.loggedIn = false;
  browser.currentAccount = null;
  browser.lastQty = null;
  browser.lastPreset = null;
  browser.shotDir = tmpdir();
  browser.config = { captureShots: false };
  return browser;
}

async function clicks(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __recoveryClicks: string[] }).__recoveryClicks);
}

test("automatic recovery follows Login, clock warning, and Access Simulation", async (t) => {
  const chrome = await launch();
  if (!chrome) return t.skip("no Chromium available");
  try {
    const page = await chrome.newPage();
    await page.goto(`${fixture}?state=full`);
    const browser = fake(page);
    await browser.tryAutoLogin();
    assert.deepEqual(await clicks(page), ["Login", "Continue", "Access Simulation"]);
    assert.equal(await browser.refreshLoginState(500), true);
  } finally {
    await chrome.close();
  }
});

test("automatic recovery supports clock warning as the first visible state", async (t) => {
  const chrome = await launch();
  if (!chrome) return t.skip("no Chromium available");
  try {
    const page = await chrome.newPage();
    await page.goto(`${fixture}?state=clock`);
    const browser = fake(page);
    await browser.tryAutoLogin();
    assert.deepEqual(await clicks(page), ["Continue", "Access Simulation"]);
    assert.equal(await browser.refreshLoginState(500), true);
  } finally {
    await chrome.close();
  }
});

test("open-trade recovery clicks through the existing login flow without navigating away", async (t) => {
  const chrome = await launch();
  if (!chrome) return t.skip("no Chromium available");
  try {
    const page = await chrome.newPage();
    await page.goto(`${fixture}?state=full`);
    const originalUrl = page.url();
    const browser = fake(page);

    const status = await browser.resumeExistingLogin();

    assert.deepEqual(await clicks(page), ["Login", "Continue", "Access Simulation"]);
    assert.equal(status.loggedIn, true);
    assert.equal(page.url(), originalUrl, "open-trade recovery must not reload or navigate the page");
  } finally {
    await chrome.close();
  }
});

test("automatic recovery keeps Start Simulated Trading compatibility", async (t) => {
  const chrome = await launch();
  if (!chrome) return t.skip("no Chromium available");
  try {
    const page = await chrome.newPage();
    await page.goto(`${fixture}?state=legacy`);
    const browser = fake(page);
    await browser.tryAutoLogin();
    assert.deepEqual(await clicks(page), ["Start Simulated Trading"]);
    assert.equal(await browser.refreshLoginState(500), true);
  } finally {
    await chrome.close();
  }
});

test("automatic recovery does not click an unknown page", async (t) => {
  const chrome = await launch();
  if (!chrome) return t.skip("no Chromium available");
  try {
    const page = await chrome.newPage();
    await page.goto(`${fixture}?state=unknown`);
    const browser = fake(page);
    await browser.tryAutoLogin();
    assert.deepEqual(await clicks(page), []);
    assert.equal(await browser.refreshLoginState(100), false);
  } finally {
    await chrome.close();
  }
});
