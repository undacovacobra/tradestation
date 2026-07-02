import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import type { Config } from "./config.js";
import type { AccountBalance } from "./types.js";
import { extractAccountBalances } from "./balanceParse.js";
import { log } from "./logger.js";

/**
 * Visible text labels from the live Tradovate web trader, confirmed by
 * inspecting the real UI (carried over from V1, where they were verified on
 * the user's demo accounts). We use text locators (not CSS classes) because
 * Tradovate's React class names are auto-generated and unstable.
 *
 * Design choice (kept from V1): the bot does NOT set the symbol or quantity.
 * You pick your contract and size once on the Tradovate screen, and the bot
 * only switches account and clicks Buy / Sell / Exit.
 */
const TXT = {
  loggedInMarker: "Buy Mkt", // only renders once logged in + trader loaded
  // Tradovate account ids look like LFF05079261220001 / LFE05079261220005.
  // Clicking the one shown in the top bar opens the account menu.
  accountIdPattern: /LF[EF]\d{6,}/,
  buy: "Buy Mkt",
  sell: "Sell Mkt",
  exit: "Exit at Mkt", // "Exit at Mkt & Cxl" — flatten position + cancel orders
  confirm: /Place Order|Confirm|OK/i, // confirmation modal button, if one appears
  // Auto-login flow (exact button labels from the live pages).
  loginButton: "Login",
  simButton: /Start Simulated Trading/i,
};

export interface BrowserStatus {
  connected: boolean;
  loggedIn: boolean;
}

/**
 * Owns the single persistent Tradovate browser session. Trades (live mode) and
 * account scanning both go through here. You log in once (incl. 2FA); the
 * session is stored in SESSION_DIR and reused on every restart.
 */
export class TradovateBrowser {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private loggedIn = false;
  private readonly shotDir: string;

  constructor(private readonly config: Config) {
    this.shotDir = config.screenshotDir;
  }

  status(): BrowserStatus {
    return { connected: this.page !== null, loggedIn: this.loggedIn };
  }

  private get p(): Page {
    if (!this.page) {
      throw new Error("The Tradovate browser is not connected. Click “Connect browser” on the dashboard first.");
    }
    return this.page;
  }

  /** Launch (or reuse) the browser and try to get logged in. */
  async connect(): Promise<BrowserStatus> {
    if (!this.page) {
      mkdirSync(this.config.sessionDir, { recursive: true });
      mkdirSync(this.shotDir, { recursive: true });
      log.info(`Launching Chromium (headed=${this.config.headed}) with session ${this.config.sessionDir}`);
      this.context = await chromium.launchPersistentContext(this.config.sessionDir, {
        headless: !this.config.headed,
        viewport: { width: 1440, height: 900 },
      });
      this.context.on("close", () => {
        // User closed the window by hand — reflect that on the dashboard.
        this.context = null;
        this.page = null;
        this.loggedIn = false;
      });
      this.page = this.context.pages()[0] ?? (await this.context.newPage());
      await this.page.goto(this.config.tradovateUrl, { waitUntil: "domcontentloaded" });
    }
    await this.refreshLoginState(5_000);
    if (!this.loggedIn) {
      log.info("Not logged in — attempting automatic login (Login → Simulated)…");
      await this.tryAutoLogin();
      await this.refreshLoginState(6_000);
    }
    return this.status();
  }

  /** Re-check whether the trader screen is actually loaded and logged in. */
  async refreshLoginState(timeout = 3_000): Promise<boolean> {
    if (!this.page) return false;
    const marker = this.page.getByText(TXT.loggedInMarker, { exact: true }).first();
    this.loggedIn = await marker.isVisible({ timeout }).catch(() => false);
    return this.loggedIn;
  }

  /** Best-effort automatic login: click Login, then the Simulated button. */
  private async tryAutoLogin(): Promise<void> {
    await this.snapshot("autologin-1-loginpage");
    const loginCandidates = [
      this.p.getByText(TXT.loginButton, { exact: true }),
      this.p.getByRole("button", { name: TXT.loginButton }),
      this.p.locator('button:has-text("Login"), [role="button"]:has-text("Login")'),
    ];
    for (const cand of loginCandidates) {
      const el = cand.first();
      if (await el.isVisible({ timeout: 4_000 }).catch(() => false)) {
        await el.click({ timeout: 5_000 }).catch((e) => log.warn(`Login click error: ${e.message}`));
        break;
      }
    }
    await this.p.waitForTimeout(2_500).catch(() => {});
    await this.snapshot("autologin-2-after-login");

    const simBtn = this.p.getByText(TXT.simButton).first();
    if (await simBtn.isVisible({ timeout: 15_000 }).catch(() => false)) {
      await simBtn.click({ timeout: 5_000 }).catch((e) => log.warn(`Sim click error: ${e.message}`));
    }
    await this.p.waitForTimeout(2_000).catch(() => {});
    await this.snapshot("autologin-3-after-sim");
  }

  /**
   * Read every account id visible in the Tradovate account menu (for the
   * dashboard's “Scan Tradovate” feature). Opens the menu, collects LFE…/LFF…
   * labels, then closes the menu again. Places no orders.
   */
  async listAccounts(): Promise<string[]> {
    await this.requireLoggedIn();
    try {
      await this.p.getByText(TXT.accountIdPattern).first().click({ timeout: 10_000 });
      await this.p.waitForTimeout(750);
      const texts = await this.p.getByText(TXT.accountIdPattern).allTextContents();
      const labels = new Set<string>();
      for (const t of texts) {
        for (const m of t.match(/LF[EF]\d{6,}/g) ?? []) labels.add(m);
      }
      await this.p.keyboard.press("Escape").catch(() => {});
      await this.p.waitForTimeout(300);
      return [...labels].sort();
    } catch (err) {
      await this.snapshot("scan-accounts-failed");
      await this.p.keyboard.press("Escape").catch(() => {});
      throw new Error(`Could not read the account menu: ${(err as Error).message}`);
    }
  }

  /**
   * Read every account id AND the balance shown next to it in the Tradovate
   * account menu. Opens the menu, captures each row's text, closes the menu.
   * Places no orders. Balances come back null when the menu doesn't show a
   * recognizable dollar amount next to that account.
   */
  async listAccountBalances(): Promise<AccountBalance[]> {
    await this.requireLoggedIn();
    try {
      await this.p.getByText(TXT.accountIdPattern).first().click({ timeout: 10_000 });
      await this.p.waitForTimeout(750);
      const els = await this.p.getByText(TXT.accountIdPattern).all();
      const rowTexts: string[] = [];
      for (const el of els) {
        const txt = await el
          .evaluate((node: Element) => {
            // Walk up to the menu row so the text includes the balance cell.
            const row =
              node.closest('tr, li, [role="row"], [role="option"], [role="menuitem"]') ??
              node.parentElement?.parentElement ??
              node.parentElement ??
              node;
            return row.textContent ?? "";
          })
          .catch(() => "");
        if (txt) rowTexts.push(txt);
      }
      await this.p.keyboard.press("Escape").catch(() => {});
      await this.p.waitForTimeout(300);
      const balances = extractAccountBalances(rowTexts);
      if (balances.length > 0 && balances.every((b) => b.balance === null)) {
        // Menu opened but no dollars found — keep a screenshot to calibrate from.
        await this.snapshot("balances-not-visible");
      }
      return balances;
    } catch (err) {
      await this.snapshot("balance-read-failed");
      await this.p.keyboard.press("Escape").catch(() => {});
      throw new Error(`Could not read balances from the account menu: ${(err as Error).message}`);
    }
  }

  /**
   * Make the given account the active one.
   * 1. Click the top "ACCOUNT" widget to open the account menu.
   * 2. Click the row whose text is the account's id (e.g. LFE05079261220005).
   */
  async switchAccount(label: string): Promise<void> {
    await this.requireLoggedIn();
    log.info(`Switching active account to ${label}`);
    try {
      // Before the menu opens, an account id (LFE…/LFF…) only appears in the
      // top bar, so .first() reliably hits the dropdown toggle.
      await this.p.getByText(TXT.accountIdPattern).first().click({ timeout: 10_000 });
      // The id appears in both the top bar and the menu row; .last() targets
      // the menu list item.
      await this.p.getByText(label, { exact: false }).last().click({ timeout: 10_000 });
      // Give the trader a moment to repoint at the newly selected account.
      await this.p.waitForTimeout(750);
    } catch (err) {
      await this.snapshot(`switch-account-failed-${label}`);
      throw new Error(
        `Could not select account "${label}". Check it still exists in the Tradovate account menu. Cause: ${(err as Error).message}`,
      );
    }
  }

  /** Click Buy Mkt / Sell Mkt. Symbol + quantity come from what's set on the UI. */
  async clickOrder(action: "buy" | "sell", label: string): Promise<void> {
    const btn = action === "buy" ? TXT.buy : TXT.sell;
    await this.p.getByText(btn, { exact: true }).first().click({ timeout: 10_000 });
    await this.confirmIfPrompted();
    await this.snapshot(`order-${action}-${label}`);
  }

  /** Flatten the open position (the "Exit at Mkt & Cxl" button). */
  async clickExit(label: string): Promise<void> {
    await this.p.getByText(TXT.exit, { exact: false }).first().click({ timeout: 10_000 });
    await this.confirmIfPrompted();
    await this.snapshot(`close-${label}`);
  }

  /** Click a confirmation modal button if Tradovate shows one. */
  private async confirmIfPrompted(): Promise<void> {
    const confirm = this.p.getByRole("button", { name: TXT.confirm }).first();
    if (await confirm.isVisible({ timeout: 1_500 }).catch(() => false)) {
      await confirm.click().catch(() => {});
    }
  }

  private async requireLoggedIn(): Promise<void> {
    if (!(await this.refreshLoginState())) {
      throw new Error(
        "Tradovate is not logged in. Click “Connect browser” on the dashboard and finish the login in the browser window if needed.",
      );
    }
  }

  private async snapshot(name: string): Promise<void> {
    if (!this.page) return;
    const path = resolve(this.shotDir, `${Date.now()}-${name}.png`);
    await this.page.screenshot({ path }).catch(() => {});
  }

  async disconnect(): Promise<void> {
    await this.context?.close().catch(() => {});
    this.context = null;
    this.page = null;
    this.loggedIn = false;
  }
}
