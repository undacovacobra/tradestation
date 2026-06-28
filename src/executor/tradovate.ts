import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import type { Executor } from "./index.js";
import type { AccountSpec, OrderRequest } from "../types.js";
import type { Config } from "../config.js";
import { log } from "../logger.js";

/**
 * Visible text labels from the live Tradovate web trader, confirmed by
 * inspecting the real UI. We use text locators (not CSS classes) because
 * Tradovate's React class names are auto-generated and unstable.
 *
 * Design choice: the bot does NOT set the symbol or quantity. You pick your
 * contract and size once on the Tradovate screen, and the bot only switches
 * account and clicks Buy / Sell / Exit. Fewer moving parts = far fewer breakages.
 */
const TXT = {
  loggedInMarker: "Buy Mkt", // only renders once logged in + trader loaded
  accountLabel: "ACCOUNT", // the top-bar widget that opens the account menu
  buy: "Buy Mkt",
  sell: "Sell Mkt",
  exit: "Exit at Mkt", // "Exit at Mkt & Cxl" — flatten position + cancel orders
  confirm: /Place Order|Confirm|OK/i, // confirmation modal button, if one appears
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
    const marker = this.p.getByText(TXT.loggedInMarker, { exact: true }).first();
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
    await marker.waitFor({ state: "visible", timeout: 300_000 });
    log.info("Login detected — session saved for next time.");
  }

  /**
   * Make `account` the active account.
   * 1. Click the top "ACCOUNT" widget to open the account menu.
   * 2. Click the row whose text is the account's id (e.g. LFE05079261220005).
   */
  private async switchAccount(account: AccountSpec): Promise<void> {
    log.info(`Switching active account to ${account.name} [${account.tradovateLabel}]`);
    try {
      await this.p.getByText(TXT.accountLabel, { exact: true }).first().click({ timeout: 10_000 });
      // The id shows both in the top widget and in the menu row; the menu row
      // renders last, so .last() targets the clickable list item.
      await this.p
        .getByText(account.tradovateLabel, { exact: true })
        .last()
        .click({ timeout: 10_000 });
      // Give the trader a moment to repoint at the newly selected account.
      await this.p.waitForTimeout(750);
    } catch (err) {
      await this.snapshot(`switch-account-failed-${account.tradovateLabel}`);
      throw new Error(
        `Could not select account "${account.tradovateLabel}". Make sure the label matches exactly what's in the account menu. Cause: ${(err as Error).message}`,
      );
    }
  }

  /** Open a position. Symbol + quantity come from what you've set on the UI. */
  async placeOrder(account: AccountSpec, order: OrderRequest): Promise<void> {
    await this.switchAccount(account);
    try {
      const label = order.action === "buy" ? TXT.buy : TXT.sell;
      await this.p.getByText(label, { exact: true }).first().click({ timeout: 10_000 });
      await this.confirmIfPrompted();
      await this.snapshot(`order-${order.action}-${account.tradovateLabel}`);
      log.trade(`Clicked ${label} on ${account.name} [${account.tradovateLabel}]`);
    } catch (err) {
      await this.snapshot(`order-failed-${account.tradovateLabel}`);
      throw new Error(`Order placement failed on ${account.name}: ${(err as Error).message}`);
    }
  }

  /** Flatten the open position (the "Exit at Mkt & Cxl" button). */
  async closePosition(account: AccountSpec, symbol: string): Promise<void> {
    await this.switchAccount(account);
    try {
      await this.p.getByText(TXT.exit, { exact: false }).first().click({ timeout: 10_000 });
      await this.confirmIfPrompted();
      await this.snapshot(`close-${account.tradovateLabel}`);
      log.trade(`Closed position on ${account.name} [${account.tradovateLabel}]`);
    } catch (err) {
      await this.snapshot(`close-failed-${account.tradovateLabel}`);
      throw new Error(`Closing position failed on ${account.name}: ${(err as Error).message}`);
    }
  }

  /** Click a confirmation modal button if Tradovate shows one. */
  private async confirmIfPrompted(): Promise<void> {
    const confirm = this.p.getByRole("button", { name: TXT.confirm }).first();
    if (await confirm.isVisible({ timeout: 1_500 }).catch(() => false)) {
      await confirm.click().catch(() => {});
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
