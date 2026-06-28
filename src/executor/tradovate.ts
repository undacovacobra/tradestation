import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import type { Executor } from "./index.js";
import type { AccountSpec, OrderRequest } from "../types.js";
import type { Config } from "../config.js";
import { log } from "../logger.js";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * CALIBRATION REQUIRED
 * ─────────────────────────────────────────────────────────────────────────────
 * Tradovate's web trader is a dynamic React app whose CSS class names change, so
 * we lean on text/role-based locators. The exact labels below are best-guesses —
 * run `npm run calibrate` to open the trader, inspect the real controls, and
 * adjust these strings to match what you actually see. Treat every selector here
 * as a knob to turn, not gospel.
 */
const SELECTORS = {
  /** An element that only exists once you're logged in and the trader has loaded. */
  loggedInMarker: "text=/Buy/i",
  /** The account selector / dropdown that shows the active account. */
  accountSelector: '[data-testid="account-selector"], .account-selector, button:has-text("Account")',
  /** The symbol search/input box. */
  symbolInput: 'input[placeholder*="Symbol" i], input[name="symbol"]',
  qtyInput: 'input[name="orderQty"], input[placeholder*="Qty" i]',
  buyButton: 'button:has-text("Buy")',
  sellButton: 'button:has-text("Sell")',
  /** Confirmation button if Tradovate shows an order confirmation modal. */
  confirmOrder: 'button:has-text("Place Order"), button:has-text("Confirm")',
  /** Close/flatten controls for the open position. */
  closePosition: 'button:has-text("Close"), button:has-text("Flatten")',
};

/**
 * Drives the live Tradovate web trader through a single persistent browser
 * session. You log in once (incl. 2FA); the session is stored in SESSION_DIR
 * and reused on every restart.
 */
export class TradovateExecutor implements Executor {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private readonly shotDir: string;

  constructor(private readonly config: Config) {
    this.shotDir = resolve(config.statePath, "..", "..", "screenshots");
  }

  async init(): Promise<void> {
    mkdirSync(this.config.sessionDir, { recursive: true });
    mkdirSync(this.shotDir, { recursive: true });

    log.info(`Launching Chromium (headed=${this.config.headed}) with session ${this.config.sessionDir}`);
    this.context = await chromium.launchPersistentContext(this.config.sessionDir, {
      headless: !this.config.headed,
      viewport: { width: 1440, height: 900 },
    });
    this.page = this.context.pages()[0] ?? (await this.context.newPage());
    await this.page.goto(this.config.tradovateUrl, { waitUntil: "domcontentloaded" });
    await this.ensureLoggedIn();
  }

  private get p(): Page {
    if (!this.page) throw new Error("TradovateExecutor not initialized");
    return this.page;
  }

  private async ensureLoggedIn(): Promise<void> {
    const marker = this.p.locator(SELECTORS.loggedInMarker).first();
    if (await marker.isVisible({ timeout: 5_000 }).catch(() => false)) {
      log.info("Tradovate session is logged in.");
      return;
    }
    if (!this.config.headed) {
      throw new Error(
        "Not logged into Tradovate and running headless. Start once with HEADED=true and log in manually.",
      );
    }
    log.warn("Not logged in. Complete login + 2FA in the opened browser window…");
    // Wait (up to 5 min) for the user to finish logging in manually.
    await marker.waitFor({ state: "visible", timeout: 300_000 });
    log.info("Login detected — session saved for next time.");
  }

  /** Make `account` the active account in the dropdown before any order. */
  private async switchAccount(account: AccountSpec): Promise<void> {
    log.info(`Switching active account to ${account.name} [${account.tradovateLabel}]`);
    try {
      await this.p.locator(SELECTORS.accountSelector).first().click({ timeout: 10_000 });
      await this.p.getByText(account.tradovateLabel, { exact: false }).first().click({ timeout: 10_000 });
    } catch (err) {
      await this.snapshot(`switch-account-failed-${account.tradovateLabel}`);
      throw new Error(
        `Could not select account "${account.tradovateLabel}". Check the label matches the dropdown and recalibrate SELECTORS.accountSelector. Cause: ${(err as Error).message}`,
      );
    }
  }

  async placeOrder(account: AccountSpec, order: OrderRequest): Promise<void> {
    await this.switchAccount(account);
    try {
      await this.p.locator(SELECTORS.symbolInput).first().fill(order.symbol);
      await this.p.keyboard.press("Enter");
      await this.p.locator(SELECTORS.qtyInput).first().fill(String(order.quantity));

      const btn = order.action === "buy" ? SELECTORS.buyButton : SELECTORS.sellButton;
      await this.p.locator(btn).first().click({ timeout: 10_000 });

      const confirm = this.p.locator(SELECTORS.confirmOrder).first();
      if (await confirm.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await confirm.click();
      }
      await this.snapshot(`order-${order.action}-${account.tradovateLabel}`);
      log.trade(`Placed ${order.action} ${order.quantity}x ${order.symbol} on ${account.name}`);
    } catch (err) {
      await this.snapshot(`order-failed-${account.tradovateLabel}`);
      throw new Error(`Order placement failed on ${account.name}: ${(err as Error).message}`);
    }
  }

  async closePosition(account: AccountSpec, symbol: string): Promise<void> {
    await this.switchAccount(account);
    try {
      await this.p.locator(SELECTORS.closePosition).first().click({ timeout: 10_000 });
      const confirm = this.p.locator(SELECTORS.confirmOrder).first();
      if (await confirm.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await confirm.click();
      }
      await this.snapshot(`close-${account.tradovateLabel}`);
      log.trade(`Closed ${symbol} on ${account.name}`);
    } catch (err) {
      await this.snapshot(`close-failed-${account.tradovateLabel}`);
      throw new Error(`Closing position failed on ${account.name}: ${(err as Error).message}`);
    }
  }

  private async snapshot(name: string): Promise<void> {
    if (!this.page) return;
    const path = resolve(this.shotDir, `${Date.now()}-${name}.png`);
    await this.page.screenshot({ path }).catch(() => {});
  }

  async shutdown(): Promise<void> {
    await this.context?.close().catch(() => {});
  }
}
