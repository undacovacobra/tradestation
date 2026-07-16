import assert from "node:assert/strict";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { inspectTicketCapabilities } from "../src/ticketCapabilities.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => `file://${resolve(here, "fixtures", name)}`;

async function launch(): Promise<Browser | null> {
  for (const executablePath of [process.env.PW_CHROMIUM, undefined]) {
    try { return await chromium.launch(executablePath ? { executablePath } : {}); } catch { /* try bundled */ }
  }
  return null;
}

test("no-order probe proves two independent ticket roots and restores their values", async (t) => {
  const browser = await launch();
  if (!browser) return t.skip("no Chromium available");
  try {
    const page = await browser.newPage();
    await page.goto(fixture("two-independent-tickets.html"));
    const result = await inspectTicketCapabilities(page);

    assert.equal(result.mode, "dual-ticket");
    assert.ok(result.controller);
    assert.equal(await page.locator("body").getAttribute("data-order-clicks"), null, "probe must never click an order control");
    assert.deepEqual(await result.controller.read("evals"), { account: "E1", atmPreset: "25", quantity: 1 });
    assert.deepEqual(await result.controller.read("funded"), { account: "F1", atmPreset: "funded", quantity: 2 });
  } finally {
    await browser.close();
  }
});

test("linked account controls fail closed to sequential mode", async (t) => {
  const browser = await launch();
  if (!browser) return t.skip("no Chromium available");
  try {
    const page = await browser.newPage();
    await page.goto(fixture("two-linked-tickets.html"));
    const result = await inspectTicketCapabilities(page);
    assert.equal(result.mode, "sequential");
    assert.match(result.reason, /independent|changed/i);
    assert.equal(result.controller, undefined);
    assert.equal(await page.locator("body").getAttribute("data-order-clicks"), null);
  } finally {
    await browser.close();
  }
});

test("scoped prepare, order, and exit touch only the requested ticket", async (t) => {
  const browser = await launch();
  if (!browser) return t.skip("no Chromium available");
  try {
    const page = await browser.newPage();
    await page.goto(fixture("two-independent-tickets.html"));
    const result = await inspectTicketCapabilities(page);
    assert.equal(result.mode, "dual-ticket");
    const controller = result.controller!;

    await controller.prepare("funded", { account: "F2", atmPreset: "funded-2", quantity: 7 });
    assert.deepEqual(await controller.read("funded"), { account: "F2", atmPreset: "funded-2", quantity: 7 });
    assert.deepEqual(await controller.read("evals"), { account: "E1", atmPreset: "25", quantity: 1 });

    await controller.clickOrder("funded", "buy");
    assert.equal(await page.locator("body").getAttribute("data-last-click"), "funded:data-atlas-buy");
    await controller.clickExit("evals");
    assert.equal(await page.locator("body").getAttribute("data-last-click"), "evals:data-atlas-exit");
  } finally {
    await browser.close();
  }
});

test("a page without two complete tickets reports sequential mode", async (t) => {
  const browser = await launch();
  if (!browser) return t.skip("no Chromium available");
  try {
    const page = await browser.newPage();
    await page.setContent("<button>Buy Mkt</button>");
    const result = await inspectTicketCapabilities(page);
    assert.equal(result.mode, "sequential");
    assert.match(result.reason, /two complete/i);
  } finally {
    await browser.close();
  }
});
