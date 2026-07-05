import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import type { Config } from "./config.js";
import { extractEquity } from "./balanceParse.js";
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
  accountIdPattern: /LF[EF]\d{6,}/, // e.g. LFF05079261220001 / LFE05079261220005
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

  constructor(private readonly config: Config) {
    this.shotDir = config.screenshotDir;
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
      await this.p.getByText(TXT.accountIdPattern).first().click({ timeout: 10_000 });
      await this.p.waitForTimeout(600);
      const texts = await this.p.getByText(TXT.accountIdPattern).allTextContents();
      const labels = new Set<string>();
      for (const t of texts) for (const m of t.match(/LF[EF]\d{6,}/g) ?? []) labels.add(m);
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
      .getByText(TXT.accountIdPattern)
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
      await this.p.getByText(TXT.accountIdPattern).first().click({ timeout: 10_000 });
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
    await this.switchAccount(label);
    log.info(`Armed: ${label} selected and ready.`);
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

    // Pass 1: locate the qty input and set it via the native value setter,
    // dispatching input/change so React registers it. All inline (no nested
    // functions — esbuild's __name helper would throw inside the page).
    let value = await this.p
      .evaluate((target) => {
        const stack: (Document | ShadowRoot)[] = [document];
        let numeric: HTMLInputElement | null = null;
        let labelled: HTMLInputElement | null = null;
        while (stack.length) {
          const root = stack.pop()!;
          const all = root.querySelectorAll("*");
          for (let i = 0; i < all.length; i++) {
            const el = all[i] as HTMLElement;
            if (el.shadowRoot) stack.push(el.shadowRoot);
            if (el instanceof HTMLInputElement) {
              const role = (el.getAttribute("role") || "").toLowerCase();
              const isNum = el.type === "number" || role === "spinbutton";
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
              if (looksQty && !labelled) labelled = el;
              if (isNum && !numeric) numeric = el;
            }
          }
        }
        const box = labelled || numeric;
        if (!box) return null;
        box.setAttribute("data-bot-qty", "1");
        const proto = Object.getPrototypeOf(box);
        const desc = Object.getOwnPropertyDescriptor(proto, "value");
        if (desc && desc.set) desc.set.call(box, String(target));
        else box.value = String(target);
        box.dispatchEvent(new Event("input", { bubbles: true }));
        box.dispatchEvent(new Event("change", { bubbles: true }));
        return Number(box.value);
      }, want)
      .catch(() => null);

    // Pass 2 (only if pass 1 didn't stick): type it like a person would.
    if (value !== want) {
      const box = this.p.locator("[data-bot-qty]").first();
      if (await box.count().catch(() => 0)) {
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

  /** Click Buy Mkt / Sell Mkt. Symbol comes from the Tradovate UI; size is set
   *  by setQuantity when the alert carries one. */
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
