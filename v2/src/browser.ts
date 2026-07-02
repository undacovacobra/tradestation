import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import type { Config } from "./config.js";
import type { AccountBalance } from "./types.js";
import { extractEquity } from "./balanceParse.js";
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
  // Top bar shows the selected account's balance as "EQUITY  50,320.00 USD".
  equity: /EQUITY/i,
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
      await this.snapshot("scan-accounts-failed", true);
      await this.p.keyboard.press("Escape").catch(() => {});
      throw new Error(`Could not read the account menu: ${(err as Error).message}`);
    }
  }

  /**
   * Read the SELECTED account's id + balance straight from the top bar
   * ("ACCOUNT  LFE…" and "EQUITY  50,320.00 USD"). No menu, no switching — so
   * it's cheap and safe to call every few seconds while a trade is open (the
   * account in the trade is the selected one). Returns null if nothing parses.
   */
  async readSelectedAccount(): Promise<AccountBalance | null> {
    await this.requireLoggedIn();
    const idText = await this.p.getByText(TXT.accountIdPattern).first().textContent().catch(() => null);
    const label = idText?.match(/LF[EF]\d{6,}/)?.[0] ?? null;
    if (!label) return null;

    // Grab the smallest top-bar container that holds the word EQUITY and a
    // dollar figure, then pull the number right after "EQUITY".
    const raw = await this.p
      .getByText(TXT.equity)
      .first()
      .evaluate((node: Element) => {
        let el: Element | null = node;
        for (let i = 0; i < 6 && el; i++) {
          const t = el.textContent ?? "";
          if (/EQUITY/i.test(t) && /\d[\d,]*\.\d{2}/.test(t)) return t;
          el = el.parentElement;
        }
        return node.parentElement?.textContent ?? node.textContent ?? "";
      })
      .catch(() => "");

    const balance = extractEquity(raw);
    if (balance === null) await this.snapshot("equity-not-parsed", true);
    return { label, balance };
  }

  /**
   * Read the selected account's balance after a short settle delay, so a
   * just-closed position's realized profit/loss is reflected in EQUITY.
   */
  async readSettledBalance(): Promise<AccountBalance | null> {
    await this.p.waitForTimeout(1_500).catch(() => {});
    return this.readSelectedAccount();
  }

  /**
   * Switch to `label`, then read its balance from the top bar. Used to read an
   * account that isn't currently selected.
   */
  async readAccount(label: string): Promise<AccountBalance> {
    await this.switchAccount(label);
    const r = await this.readSelectedAccount();
    // switchAccount guarantees `label` is selected; trust it over a mis-read id.
    return { label, balance: r?.balance ?? null };
  }

  /**
   * Read every account's balance by cycling through them: list the ids from the
   * menu, then switch to each and read its EQUITY. Also surfaces brand-new
   * accounts (the ids), so the monitor can auto-add them. Heavier than a single
   * read — used on the relaxed idle cadence and by "Scan Tradovate accounts".
   */
  async readAllBalances(): Promise<AccountBalance[]> {
    await this.requireLoggedIn();
    const ids = await this.listAccounts();
    const out: AccountBalance[] = [];
    for (const id of ids) {
      try {
        out.push(await this.readAccount(id));
      } catch {
        out.push({ label: id, balance: null });
      }
    }
    if (out.length > 0 && out.every((b) => b.balance === null)) {
      await this.snapshot("balances-not-visible", true);
    }
    return out;
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
      await this.p.waitForTimeout(Math.max(0, this.config.switchSettleMs));
    } catch (err) {
      await this.snapshot(`switch-account-failed-${label}`, true);
      throw new Error(
        `Could not select account "${label}". Check it still exists in the Tradovate account menu. Cause: ${(err as Error).message}`,
      );
    }
  }

  /** Bounding box of the first VISIBLE "Sell Mkt" (skips hidden duplicates). */
  private async visibleSellBox(): Promise<{ x: number; y: number; width: number; height: number } | null> {
    const sells = this.p.getByText(TXT.sell, { exact: true });
    const n = await sells.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const el = sells.nth(i);
      if (!(await el.isVisible().catch(() => false))) continue;
      const b = await el.boundingBox().catch(() => null);
      if (b && b.width > 0) return b;
    }
    return null;
  }

  /**
   * Locate the order-ticket quantity control (the small size box to the right of
   * "Sell Mkt"). Runs the ENTIRE scan inside one page.evaluate that walks the
   * DOM *including shadow roots* — so it's both shadow-DOM aware (raw
   * querySelectorAll isn't) AND fast (one round-trip instead of hundreds of
   * per-element boundingBox calls, which is what made the order path slow).
   * Considers inputs (by value) and leaf elements (by text).
   */
  private async findQtyControl(): Promise<{ x: number; y: number; value: number; isInput: boolean } | null> {
    const sb = await this.visibleSellBox();
    if (!sb) return null;
    // NOTE: no nested named functions inside evaluate — the TS compiler injects
    // a __name helper for them that doesn't exist in the page, which throws.
    return await this.p
      .evaluate((s) => {
        const bandTop = s.y - 8;
        const bandBottom = s.y + s.height + 8;
        const xMin = s.x + s.width - 2;
        const xMax = s.x + s.width + 320;
        let best: { x: number; y: number; value: number; isInput: boolean; left: number } | null = null;
        const stack: (Document | ShadowRoot)[] = [document];
        while (stack.length) {
          const root = stack.pop()!;
          for (const el of Array.from(root.querySelectorAll("*"))) {
            if ((el as HTMLElement).shadowRoot) stack.push((el as HTMLElement).shadowRoot!);
            let value: number | null = null;
            let isInput = false;
            if (el.tagName === "INPUT") {
              const v = ((el as HTMLInputElement).value || "").trim();
              if (/^\d{1,4}$/.test(v)) {
                value = Number(v);
                isInput = true;
              }
            } else if (el.children.length === 0) {
              const t = (el.textContent || "").trim();
              if (/^\d{1,4}$/.test(t)) value = Number(t);
            }
            if (value === null) continue;
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0 || r.width > 160) continue;
            const cy = r.top + r.height / 2;
            if (cy < bandTop || cy > bandBottom || r.left < xMin || r.left > xMax) continue;
            if (!best || r.left < best.left) {
              best = { x: r.left + r.width / 2, y: cy, value, isInput, left: r.left };
            }
          }
        }
        const f = best as { x: number; y: number; value: number; isInput: boolean } | null;
        return f ? { x: f.x, y: f.y, value: f.value, isInput: f.isInput } : null;
      }, { x: sb.x, y: sb.y, width: sb.width, height: sb.height })
      .catch(() => null);
  }

  /** Find a dropdown option with exact text `target` sitting below the box. */
  private async findQtyOption(target: number, sx: number, sy: number): Promise<{ x: number; y: number } | null> {
    return await this.p
      .evaluate((a) => {
        let best: { x: number; y: number; top: number } | null = null;
        const stack: (Document | ShadowRoot)[] = [document];
        while (stack.length) {
          const root = stack.pop()!;
          for (const el of Array.from(root.querySelectorAll("*"))) {
            if ((el as HTMLElement).shadowRoot) stack.push((el as HTMLElement).shadowRoot!);
            if (el.children.length !== 0) continue;
            if ((el.textContent || "").trim() !== String(a.t)) continue;
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            const cx = r.left + r.width / 2;
            if (Math.abs(cx - a.sx) > 180 || r.top <= a.sy + 4 || r.top > a.sy + 540) continue;
            if (!best || r.top < best.top) best = { x: cx, y: r.top + r.height / 2, top: r.top };
          }
        }
        return best ? { x: best.x, y: best.y } : null;
      }, { t: target, sx, sy })
      .catch(() => null);
  }

  /**
   * Set the contract quantity on the Tradovate order ticket, then read it back
   * to CONFIRM. Tries typing into the box first (it's usually an editable
   * input), then falls back to opening its preset dropdown and clicking the
   * matching option. Throws — placing NO order — if the final read-back doesn't
   * match, so a wrong-sized order can never fire.
   */
  async setQuantity(qty: number): Promise<number> {
    await this.requireLoggedIn();
    const target = Math.max(1, Math.floor(qty));

    let ctrl = await this.findQtyControl();
    if (!ctrl) {
      await this.snapshot("set-quantity-no-box", true);
      const sellVisible = (await this.visibleSellBox()) !== null;
      throw new Error(
        sellVisible
          ? `Found the Sell Mkt button but no number box next to it, so NO order was placed. ` +
            `Make sure the order ticket (Buy Mkt / Sell Mkt row) is fully visible in the bot's browser window, then try again.`
          : `Couldn't see the Buy/Sell buttons at all — is the trading screen open in the bot's browser? NO order was placed.`,
      );
    }
    if (ctrl.value === target) return target; // already correct

    // Attempt 1: type the number straight into the box.
    if (ctrl.isInput) {
      await this.p.mouse.click(ctrl.x, ctrl.y);
      await this.p.keyboard.press("Control+A").catch(() => {});
      await this.p.keyboard.type(String(target)).catch(() => {});
      await this.p.keyboard.press("Enter").catch(() => {});
      await this.p.waitForTimeout(120);
      ctrl = await this.findQtyControl();
      if (ctrl?.value === target) {
        await this.p.keyboard.press("Escape").catch(() => {}); // close any menu left open
        return target;
      }
    }

    // Attempt 2: open the dropdown and click the preset option below the box.
    await this.p.keyboard.press("Escape").catch(() => {});
    const spot = (await this.findQtyControl()) ?? ctrl;
    if (spot) {
      await this.p.mouse.click(spot.x, spot.y);
      await this.p.waitForTimeout(200);
      const opt = await this.findQtyOption(target, spot.x, spot.y);
      if (opt) {
        await this.p.mouse.click(opt.x, opt.y);
        await this.p.waitForTimeout(150);
      }
      const after = await this.findQtyControl();
      if (after?.value === target) return target;
    }

    // Fail safe: close any open menu and refuse to trade the wrong size.
    await this.p.keyboard.press("Escape").catch(() => {});
    await this.snapshot("set-quantity-failed", true);
    throw new Error(
      `Couldn't set the size to ${target} on Tradovate, so NO order was placed. ` +
        `A screenshot named set-quantity-failed was saved — send it to me and I'll fix the aim.`,
    );
  }

  /** Click Buy Mkt / Sell Mkt. The quantity must already be set via setQuantity. */
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

  /**
   * Click a confirmation modal button if Tradovate shows one. Most fast-trading
   * setups have order confirmation OFF, so this waits only a short, configurable
   * window (ORDER_CONFIRM_WAIT_MS) instead of a fixed 1.5s on every order.
   */
  private async confirmIfPrompted(): Promise<void> {
    const wait = Math.max(0, this.config.orderConfirmWaitMs);
    if (wait === 0) return;
    const confirm = this.p.getByRole("button", { name: TXT.confirm }).first();
    if (await confirm.isVisible({ timeout: wait }).catch(() => false)) {
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

  /**
   * Save a screenshot. Success snapshots are skipped unless SCREENSHOTS=true
   * (they add latency to the order path); pass force=true for failure captures,
   * which are always saved so we can debug.
   */
  private async snapshot(name: string, force = false): Promise<void> {
    if (!this.page) return;
    if (!force && !this.config.captureShots) return;
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
