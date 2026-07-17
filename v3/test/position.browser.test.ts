import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { chromium, type Browser } from "playwright";
import { TradovateBrowser } from "../src/browser.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = "file://" + resolve(__dirname, "fixtures", "mock-position.html");

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
function fake(page: unknown): any {
  const browser: any = Object.create(TradovateBrowser.prototype);
  browser.page = page;
  browser.loggedIn = true;
  browser.currentAccount = "LFE05079261220009";
  browser.shotDir = tmpdir();
  browser.config = { captureShots: false };
  return browser;
}

test("readSelectedPosition classifies Tradovate POSITION 0 as flat", async (t) => {
  const chrome = await launch();
  if (!chrome) return t.skip("no Chromium available");
  try {
    const page = await chrome.newPage();
    await page.goto(`${fixture}?state=flat`);
    const result = await fake(page).readSelectedPosition();
    assert.equal(result.status, "flat");
  } finally {
    await chrome.close();
  }
});

test("readSelectedPosition matches the live title-case Position DOM label", async (t) => {
  const chrome = await launch();
  if (!chrome) return t.skip("no Chromium available");
  try {
    const page = await chrome.newPage();
    await page.goto(`${fixture}?state=live-case`);
    const result = await fake(page).readSelectedPosition();
    assert.equal(result.status, "flat");
  } finally {
    await chrome.close();
  }
});

test("readSelectedPosition reads the live combined POSITION 0 container", async (t) => {
  const chrome = await launch();
  if (!chrome) return t.skip("no Chromium available");
  try {
    const page = await chrome.newPage();
    await page.goto(`${fixture}?state=live-stacked`);
    const result = await fake(page).readSelectedPosition();
    assert.equal(result.status, "flat");
  } finally {
    await chrome.close();
  }
});

test("readSelectedPosition preserves long and short quantities", async (t) => {
  const chrome = await launch();
  if (!chrome) return t.skip("no Chromium available");
  try {
    const page = await chrome.newPage();
    const browser = fake(page);
    await page.goto(`${fixture}?state=open-long`);
    const long = await browser.readSelectedPosition();
    assert.equal(long.status, "open");
    if (long.status === "open") assert.equal(long.netPosition, 2);
    await page.goto(`${fixture}?state=open-short`);
    const short = await browser.readSelectedPosition();
    assert.equal(short.status, "open");
    if (short.status === "open") assert.equal(short.netPosition, -3);
  } finally {
    await chrome.close();
  }
});

test("readSelectedPosition ignores unrelated position text outside the order ticket", async (t) => {
  const chrome = await launch();
  if (!chrome) return t.skip("no Chromium available");
  try {
    const page = await chrome.newPage();
    await page.goto(`${fixture}?state=flat`);
    assert.equal((await fake(page).readSelectedPosition()).status, "flat");
  } finally {
    await chrome.close();
  }
});

test("readSelectedPosition never treats P/L, missing, hidden, malformed, or duplicate evidence as flat", async (t) => {
  const chrome = await launch();
  if (!chrome) return t.skip("no Chromium available");
  try {
    const page = await chrome.newPage();
    const browser = fake(page);
    for (const state of ["missing", "hidden", "malformed", "duplicate"]) {
      await page.goto(`${fixture}?state=${state}`);
      const result = await browser.readSelectedPosition();
      assert.equal(result.status, "unknown", `${state} must fail safe`);
    }
  } finally {
    await chrome.close();
  }
});

test("readSelectedPosition falls back to the visible top Positions counter", async (t) => {
  const chrome = await launch();
  if (!chrome) return t.skip("no Chromium available");
  try {
    const page = await chrome.newPage();
    const browser = fake(page);

    await page.goto(`${fixture}?state=summary-flat`);
    assert.equal((await browser.readSelectedPosition()).status, "flat");

    await page.goto(`${fixture}?state=summary-long`);
    const long = await browser.readSelectedPosition();
    assert.equal(long.status, "open");
    if (long.status === "open") assert.equal(long.netPosition, 2);

    await page.goto(`${fixture}?state=summary-short`);
    const short = await browser.readSelectedPosition();
    assert.equal(short.status, "open");
    if (short.status === "open") assert.equal(short.netPosition, -3);
  } finally {
    await chrome.close();
  }
});

test("readSelectedPosition reads the live nested <div.number> cell (value beside a child span)", async (t) => {
  const chrome = await launch();
  if (!chrome) return t.skip("no Chromium available");
  try {
    const page = await chrome.newPage();
    const browser = fake(page);

    // This is the exact real Tradovate shape that used to read as UNKNOWN: the
    // count sits in the div's own text while a smaller price span is nested in.
    await page.goto(`${fixture}?state=nested`);
    assert.equal((await browser.readSelectedPosition()).status, "flat", "nested 0 must read flat, not unknown");

    await page.goto(`${fixture}?state=nested-long`);
    const long = await browser.readSelectedPosition();
    assert.equal(long.status, "open");
    if (long.status === "open") assert.equal(long.netPosition, 2, "must read the count, not the nested price");

    await page.goto(`${fixture}?state=nested-short`);
    const short = await browser.readSelectedPosition();
    assert.equal(short.status, "open");
    if (short.status === "open") assert.equal(short.netPosition, -3);
  } finally {
    await chrome.close();
  }
});

test("diagnosePosition reports the live markup near POSITION when the read is UNKNOWN", async (t) => {
  const chrome = await launch();
  if (!chrome) return t.skip("no Chromium available");
  try {
    const page = await chrome.newPage();
    await page.goto(`${fixture}?state=missing`);
    const out = await fake(page).diagnosePosition();
    // The reader still fails safe...
    assert.equal(out.position.status, "unknown");
    // ...but the calibration probe surfaces what the screen actually shows, so
    // the selector can be tuned to the real Tradovate DOM.
    assert.ok(Array.isArray(out.nearby));
    assert.ok(out.nearby.length >= 1, "should surface at least one position-labelled element");
    assert.ok(out.nearby.every((r: Record<string, string>) => typeof r.label === "string" && "numbersNearby" in r));
  } finally {
    await chrome.close();
  }
});

test("readSelectedPosition fails safely for conflicting or unsafe top counter evidence", async (t) => {
  const chrome = await launch();
  if (!chrome) return t.skip("no Chromium available");
  try {
    const page = await chrome.newPage();
    const browser = fake(page);
    for (const state of ["summary-conflict", "summary-hidden", "summary-malformed", "summary-duplicate"]) {
      await page.goto(`${fixture}?state=${state}`);
      assert.equal((await browser.readSelectedPosition()).status, "unknown", `${state} must fail safe`);
    }
  } finally {
    await chrome.close();
  }
});
