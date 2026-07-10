import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import type { Config } from "./config.js";
import { extractEquity } from "./balanceParse.js";
import { notifyActionNeeded } from "./notify.js";
import { log } from "./logger.js";

/**
 * Visible text labels from the live Tradovate web trader, confirmed on the
 * user's demo accounts. We use text locators (not CSS classes) because
 * Tradovate's React class names are auto-generated and unstable.
 *
 * Design choice: the bot does NOT set the symbol or quantity. You pick your
 * contract and size on the Tradovate screen; the bot only switches account and
 * clicks Buy / Sell / Exit. Fewer moving parts = far faster and more reliable.
 */
const TXT = {
  loggedInMarker: "Buy Mkt", // only renders once logged in + trader loaded
  buy: "Buy Mkt",
  sell: "Sell Mkt",
  exit: "Exit at Mkt", // "Exit at Mkt & Cxl" — flatten position + cancel orders
  confirm: /Place Order|Confirm|OK/i, // confirmation modal button, if one appears
  loginButton: "Login",
  simButton: /Start Simulated Trading/i,
  equity: /EQUITY/i, // top bar: "EQUITY  50,320.00 USD" for the SELECTED account
};

export interface BrowserStatus {
  connected: boolean;
  loggedIn: boolean;
}

/**
 * Owns the single persistent Tradovate browser session. You log in once (incl.
 * 2FA); the session is stored in SESSION_DIR and reused on every restart.
 */
export class TradovateBrowser {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private loggedIn = false;
  /** The account the bot last selected. The bot is the only thing that switches
   *  accounts, so this is authoritative — used to skip the switch instantly when
   *  we're already on the right account (armed). Reset on (re)connect. */
  private currentAccount: string | null = null;
  /** The order size we last set on the ticket. Lets us skip re-setting the same
   *  size (a pure no-op) and forces a re-set after an account switch. */
  private lastQty: number | null = null;
  private readonly shotDir: string;
  private readonly accountIdPattern: RegExp;

  constructor(private readonly config: Config) {
    this.shotDir = config.screenshotDir;
    this.accountIdPattern = config.accountIdPattern;
  }

  status(): BrowserStatus {
    return { connected: this.page !== null, loggedIn: this.loggedIn };
  }

  /** The account the bot currently believes is selected (null if unknown). */
  get selectedAccount(): string | null {
    return this.currentAccount;
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
        // Keep Tradovate running at FULL speed even when this window is
        // minimized or hidden behind others. By default Chromium throttles
        // background/occluded windows to save CPU, which slows the page's
        // rendering and makes the Buy/Sell/Exit click take longer to land —
        // the exact reason the speed test is fast only while the window is
        // visible. These flags disable that throttling.
        args: [
          "--disable-background-timer-throttling",
          "--disable-backgrounding-occluded-windows",
          "--disable-renderer-backgrounding",
          "--disable-features=CalculateNativeWinOcclusion",
        ],
      });
      this.context.on("close", () => {
        this.context = null;
        this.page = null;
        this.loggedIn = false;
        this.currentAccount = null;
        this.lastQty = null;
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
    // A popup (notice/agreement) often greets a fresh session — clear it now.
    if (this.loggedIn) await this.dismissPopups().catch(() => false);
    return this.status();
  }

  /**
   * Recover a session that has drifted — logged out, timed out, or the page
   * wandered off the trader. Reloads the Tradovate page and re-runs the
   * automatic login. Used by the health check when the trading screen vanishes.
   * Only safe to call while FLAT (it reloads the page). Forgets the armed
   * account/size since a reload loses them.
   */
  async recover(): Promise<BrowserStatus> {
    if (!this.page) return this.connect();
    log.warn("Recovering Tradovate session (reload + re-login)…");
    this.currentAccount = null;
    this.lastQty = null;
    await this.page.goto(this.config.tradovateUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
    await this.refreshLoginState(6_000);
    if (!this.loggedIn) {
      await this.tryAutoLogin();
      await this.refreshLoginState(6_000);
    }
    if (this.loggedIn) await this.dismissPopups().catch(() => false);
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
   * dashboard's “Scan” feature). Opens the menu, collects LFE…/LFF… labels,
   * then closes the menu. Places no orders.
   */
  async listAccounts(): Promise<string[]> {
    await this.requireLoggedIn();
    try {
      await this.p.getByText(this.accountIdPattern).first().click({ timeout: 10_000 });
      await this.p.waitForTimeout(600);
      const texts = await this.p.getByText(this.accountIdPattern).allTextContents();
      const labels = new Set<string>();
      for (const t of texts) {
        const pattern = new RegExp(this.accountIdPattern.source, this.accountIdPattern.flags.includes("g") ? this.accountIdPattern.flags : `${this.accountIdPattern.flags}g`);
        for (const m of t.match(pattern) ?? []) labels.add(m);
      }
      await this.p.keyboard.press("Escape").catch(() => {});
      await this.p.waitForTimeout(200);
      return [...labels].sort();
    } catch (err) {
      await this.snapshot("scan-accounts-failed", true);
      await this.p.keyboard.press("Escape").catch(() => {});
      throw new Error(`Could not read the account menu: ${(err as Error).message}`);
    }
  }

  /**
   * Make the given account the active one.
   *  - INSTANT path: we already know we're on it (the bot put it there) → do
   *    nothing, not even a screen read. This is the armed common case, so a live
   *    entry becomes just the Buy/Sell click.
   *  - Otherwise (first trade, or just reconnected): read the top bar once; if it
   *    already shows the account, adopt it; else open the menu and switch.
   */
  async switchAccount(label: string): Promise<void> {
    if (this.currentAccount === label) return;
    await this.requireLoggedIn();
    const current = await this.p
      .getByText(this.accountIdPattern)
      .first()
      .textContent({ timeout: 2_000 })
      .catch(() => null);
    if (current?.includes(label)) {
      this.currentAccount = label;
      this.lastQty = null; // new account — ticket size unknown, re-set on next order
      return;
    }
    log.info(`Switching active account to ${label}`);
    try {
      await this.p.getByText(this.accountIdPattern).first().click({ timeout: 10_000 });
      await this.p.getByText(label, { exact: false }).last().click({ timeout: 10_000 });
      await this.p.waitForTimeout(Math.max(0, this.config.switchSettleMs));
      this.currentAccount = label;
      this.lastQty = null; // new account — ticket size unknown, re-set on next order
    } catch (err) {
      this.currentAccount = null; // we no longer know where we are
      await this.snapshot(`switch-account-failed-${label}`, true);
      throw new Error(
        `Could not select account "${label}". Check it still exists in the Tradovate account menu. Cause: ${(err as Error).message}`,
      );
    }
  }

  /** Pre-select the next account so the entry webhook only has to click. */
  async armFor(label: string): Promise<void> {
    // Arm time is an idle moment — clear any popup sitting on the screen now,
    // so it can't be in the way when the next entry click comes.
    await this.dismissPopups().catch(() => false);
    await this.switchAccount(label);
    log.info(`Armed: ${label} selected and ready.`);
  }

  /**
   * The popup-killer. Tradovate sometimes shows a dialog (notice, agreement,
   * reconnect message) whose backdrop covers the screen and silently blocks
   * every click — the classic "trade stuck open after a restart" failure.
   * This looks for a visible dialog/backdrop and dismisses it SAFELY:
   *  - it only clicks dismiss-style buttons (OK / Close / Got it / ×, etc.);
   *    it will never click a button it doesn't recognize, and never anything
   *    that could place an order;
   *  - if no safe button exists it presses Escape;
   *  - if the popup still won't go away it screenshots + reports false so the
   *    caller can raise the alarm instead of clicking blind.
   * Returns true if a popup was found and cleared.
   */
  async dismissPopups(): Promise<boolean> {
    if (!this.page) return false;
    // One inline pass (no nested named functions — esbuild __name gotcha):
    // find a visible backdrop/dialog; click its first SAFE dismiss button.
    const state = await this.page
      .evaluate(() => {
        const roots = document.querySelectorAll(
          '.modal-backdrop, .modal.in, .modal.show, [role="dialog"], [role="alertdialog"]',
        );
        let visible: Element | null = null;
        for (let i = 0; i < roots.length; i++) {
          const el = roots[i] as HTMLElement;
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            visible = el;
            break;
          }
        }
        if (!visible) return "none";
        // Search the whole document for the dialog's buttons (the backdrop
        // itself has none) but only ever click dismiss-style labels.
        const btns = document.querySelectorAll('button, [role="button"], a.btn');
        for (let i = 0; i < btns.length; i++) {
          const b = btns[i] as HTMLElement;
          const r = b.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          const label = ((b.getAttribute("aria-label") || "") + " " + (b.textContent || "")).trim().toLowerCase();
          const safe =
            label === "ok" ||
            label === "okay" ||
            label === "close" ||
            label === "×" ||
            label === "x" ||
            label === "got it" ||
            label === "dismiss" ||
            label === "continue" ||
            label === "i understand" ||
            label === "i agree" ||
            label === "accept" ||
            (b.getAttribute("aria-label") || "").toLowerCase() === "close" ||
            (b.className || "").toString().indexOf("close") >= 0;
          if (safe) {
            b.click();
            return "clicked";
          }
        }
        return "no-safe-button";
      })
      .catch(() => "none");

    if (state === "none") return false;
    if (state === "no-safe-button") {
      // No button we trust — try Escape, the universal "go away" key.
      await this.page.keyboard.press("Escape").catch(() => {});
    }
    await this.page.waitForTimeout(400).catch(() => {});
    // Verify it's actually gone.
    const still = await this.page
      .evaluate(() => {
        const roots = document.querySelectorAll(
          '.modal-backdrop, .modal.in, .modal.show, [role="dialog"], [role="alertdialog"]',
        );
        for (let i = 0; i < roots.length; i++) {
          const el = roots[i] as HTMLElement;
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) return true;
        }
        return false;
      })
      .catch(() => false);
    if (still) {
      await this.snapshot("popup-could-not-dismiss", true);
      log.warn("A popup is covering the Tradovate screen and I couldn't safely dismiss it.");
      notifyActionNeeded(
        "A popup is stuck on the Tradovate screen and I can't clear it myself — it may block trades. Please check the bot computer and close it.",
      );
      return false;
    }
    log.warn("Cleared a popup that was covering the Tradovate screen.");
    return true;
  }

  /** Click a locator; if something (a popup) blocks it, clear + retry once. */
  private async clickThroughPopups(click: () => Promise<void>, what: string): Promise<void> {
    try {
      await click();
    } catch (err) {
      const cleared = await this.dismissPopups();
      if (!cleared) throw err;
      log.warn(`A popup was blocking the ${what} click — cleared it and retrying.`);
      await click();
    }
  }

  /**
   * Read the SELECTED account's balance from the top bar ("EQUITY  50,320.00").
   * No menu, no account switching — cheap and safe to call while a trade is open
   * (the trade account is the selected one) and never on the entry click path.
   */
  async readSelectedEquity(): Promise<number | null> {
    if (!this.page || !this.loggedIn) return null;
    const raw = await this.page
      .getByText(TXT.equity)
      .first()
      .evaluate((node: Element) => {
        // Climb to the smallest container holding EQUITY + a dollar figure.
        let el: Element | null = node;
        for (let i = 0; i < 6 && el; i++) {
          const t = el.textContent ?? "";
          if (/EQUITY/i.test(t) && /\d[\d,]*\.\d{2}/.test(t)) return t;
          el = el.parentElement;
        }
        return node.parentElement?.textContent ?? node.textContent ?? "";
      })
      .catch(() => "");
    return extractEquity(raw);
  }

  /** Read the balance after a short settle delay (for a just-closed trade). */
  async readSettledEquity(): Promise<number | null> {
    await this.p.waitForTimeout(1_200).catch(() => {});
    return this.readSelectedEquity();
  }

  /**
   * Set the order-ticket quantity, FAST. Two rules keep this off the slow path:
   *  - Cached: if we already set this exact size, do nothing (a pure no-op) —
   *    so back-to-back same-size trades cost zero.
   *  - One pass: it finds the size box in a SINGLE in-page search (no
   *    per-element round-trips — that whole-DOM scan was the old lag) and sets
   *    the value, then READS IT BACK. If it can't confirm the exact number it
   *    THROWS, so the caller places no order and a wrong size can never fire.
   *  `force` re-sets even if the size looks unchanged (used by the test button).
   */
  async setQuantity(qty: number, force = false): Promise<void> {
    if (!Number.isFinite(qty) || qty < 1) throw new Error(`Order size must be a whole number of 1 or more (got ${qty}).`);
    const want = Math.floor(qty);
    if (!force && this.lastQty === want) return; // already set — nothing to do
    await this.requireLoggedIn();

    // Step 1: FIND and mark the size box (one in-page pass; no per-element
    // round-trips). We do NOT set the value here — poking the value property
    // made Tradovate's widget ADD to the existing size (2 on screen + 1 from
    // the alert = 3) instead of replacing it. All inline (no nested functions —
    // esbuild's __name helper would throw inside the page).
    const found = await this.p
      .evaluate(() => {
        const stack: (Document | ShadowRoot)[] = [document];
        let numeric: HTMLInputElement | null = null;
        let labelled: HTMLInputElement | null = null;
        let formCtrl: HTMLInputElement | null = null;
        while (stack.length) {
          const root = stack.pop()!;
          const all = root.querySelectorAll("*");
          for (let i = 0; i < all.length; i++) {
            const el = all[i] as HTMLElement;
            if (el.shadowRoot) stack.push(el.shadowRoot);
            if (el instanceof HTMLInputElement) {
              const role = (el.getAttribute("role") || "").toLowerCase();
              const isNum = el.type === "number" || role === "spinbutton";
              const cls = (el.getAttribute("class") || "").toLowerCase();
              const isSearch = el.type === "search" || cls.indexOf("search") >= 0;
              const hint = (
                (el.getAttribute("aria-label") || "") +
                " " +
                (el.getAttribute("name") || "") +
                " " +
                (el.getAttribute("placeholder") || "")
              ).toLowerCase();
              const looksQty =
                hint.indexOf("qty") >= 0 ||
                hint.indexOf("quantity") >= 0 ||
                hint.indexOf("size") >= 0 ||
                hint.indexOf("contract") >= 0;
              // Tradovate's order-ticket size box: a plain form-control input
              // that currently holds a whole number (its label is "Select value",
              // not "Qty"), sitting by the Buy/Sell/Exit buttons. Never the
              // symbol search box.
              const holdsInteger = /^\s*\d+\s*$/.test(el.value || "");
              if (looksQty && !labelled) labelled = el;
              if (isNum && !numeric) numeric = el;
              if (!isSearch && !formCtrl && cls.indexOf("form-control") >= 0 && holdsInteger) formCtrl = el;
            }
          }
        }
        const box = labelled || numeric || formCtrl;
        if (!box) return false;
        box.setAttribute("data-bot-qty", "1");
        return true;
      })
      .catch(() => false);

    let value: number | null = null;
    if (found) {
      // Step 2: REPLACE the value the way a person does — click into the box,
      // select ALL of it, then type the new number OVER the selection. Typing
      // over a full selection overwrites it, so it can never append or add.
      // Commit with Tab (never Enter — Enter could place an order).
      const box = this.p.locator("[data-bot-qty]").first();
      try {
        await box.click({ timeout: 3_000 });
        await box.press("ControlOrMeta+a");
        await box.pressSequentially(String(want), { delay: 15 });
        await box.press("Tab");
      } catch {
        /* verified below */
      }
      value = await box.evaluate((el) => Number((el as HTMLInputElement).value)).catch(() => null);
      // Fallback: fill() also clears the field before setting it.
      if (value !== want) {
        await box.fill(String(want), { timeout: 3_000 }).catch(() => {});
        value = await box.evaluate((el) => Number((el as HTMLInputElement).value)).catch(() => null);
      }
    }

    if (value !== want) {
      await this.snapshot("set-quantity-failed", true);
      throw new Error(`Couldn't set the order size to ${want} on the Tradovate ticket — the trade was skipped so a wrong size can't fire.`);
    }
    this.lastQty = want;
  }

  /**
   * Diagnostic for calibrating the size box: list every editable/number-ish
   * field on the page (inputs, textareas, spinbuttons, contenteditable) with
   * its tag, type, labels, class and current value. Used by the Test-size
   * button when it can't find the box, so we can see what the real ticket has.
   */
  async inspectFields(): Promise<Array<Record<string, string>>> {
    if (!this.page) return [];
    return await this.page
      .evaluate(() => {
        const out: Array<Record<string, string>> = [];
        const stack: (Document | ShadowRoot)[] = [document];
        while (stack.length) {
          const root = stack.pop()!;
          const all = root.querySelectorAll("*");
          for (let i = 0; i < all.length; i++) {
            const el = all[i] as HTMLElement;
            if (el.shadowRoot) stack.push(el.shadowRoot);
            const tag = el.tagName.toLowerCase();
            const role = (el.getAttribute("role") || "").toLowerCase();
            const editable = el.getAttribute("contenteditable") === "true";
            const isField =
              tag === "input" || tag === "textarea" || tag === "select" || role === "spinbutton" || editable;
            if (!isField) continue;
            const val = (el as HTMLInputElement).value;
            // "near": the nearest ancestor text (e.g. a "Qty" / "Price" label),
            // and "ctx": ancestor class names — both help identify the box.
            let near = "";
            let ctx = "";
            let p: HTMLElement | null = el.parentElement;
            for (let up = 0; up < 5 && p; up++) {
              if (!near) {
                const t = (p.textContent || "").replace(/\s+/g, " ").trim();
                if (t && t.length <= 40) near = t;
              }
              const c = p.getAttribute("class") || "";
              if (c) ctx += (ctx ? " ‹ " : "") + c.slice(0, 30);
              p = p.parentElement;
            }
            out.push({
              tag,
              type: el.getAttribute("type") || "",
              role,
              ariaLabel: el.getAttribute("aria-label") || "",
              name: el.getAttribute("name") || "",
              placeholder: el.getAttribute("placeholder") || "",
              cls: (el.getAttribute("class") || "").slice(0, 40),
              value: (val != null ? String(val) : el.textContent || "").slice(0, 24),
              near: near.slice(0, 40),
              ctx: ctx.slice(0, 80),
            });
            if (out.length >= 40) return out;
          }
        }
        return out;
      })
      .catch(() => []);
  }

  /** Click Buy Mkt / Sell Mkt. Symbol comes from the Tradovate UI; size is set
   *  by setQuantity when the alert carries one. If a popup blocks the click,
   *  it's cleared and the click retried once. */
  async clickOrder(action: "buy" | "sell", label: string): Promise<void> {
    const btn = action === "buy" ? TXT.buy : TXT.sell;
    await this.clickThroughPopups(
      () => this.p.getByText(btn, { exact: true }).first().click({ timeout: 10_000 }),
      action.toUpperCase(),
    );
    await this.confirmIfPrompted();
    await this.snapshot(`order-${action}-${label}`);
  }

  /** Flatten the open position (the "Exit at Mkt & Cxl" button). If a popup
   *  blocks the click, it's cleared and the click retried once. */
  async clickExit(label: string): Promise<void> {
    await this.clickThroughPopups(
      () => this.p.getByText(TXT.exit, { exact: false }).first().click({ timeout: 10_000 }),
      "EXIT",
    );
    await this.confirmIfPrompted();
    await this.snapshot(`close-${label}`);
  }

  /** Click a confirmation modal button if Tradovate shows one (short wait). */
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
    this.currentAccount = null;
  }
}
