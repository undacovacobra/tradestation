import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import type { Config } from "./config.js";
import { extractEquity } from "./balanceParse.js";
import { extractPosition } from "./positionParse.js";
import { notifyActionNeeded } from "./notify.js";
import { log } from "./logger.js";
import { planOcoPrices } from "./ocoPlan.js";
import type { AccountDefinition, ProtectionReceipt, V4Alert } from "./models.js";

/**
 * Visible text labels from the live Tradovate web trader, confirmed on the
 * user's demo accounts. We use text locators (not CSS classes) because
 * Tradovate's React class names are auto-generated and unstable.
 *
 * Design choice: the bot does not change the chart symbol. It receives the
 * strategy quantity from each webhook, verifies that size, then clicks the
 * requested Buy/Sell button for the already prepared account and ATM.
 */
const TXT = {
  loggedInMarker: "Buy Mkt", // only renders once logged in + trader loaded
  buy: "Buy Mkt",
  sell: "Sell Mkt",
  exit: "Exit at Mkt", // "Exit at Mkt & Cxl" — flatten position + cancel orders
  confirm: /Place Order|Confirm|OK/i, // confirmation modal button, if one appears
  loginButton: "Login",
  simButton: /Start Simulated Trading|Simulator|Simulation/i,
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
  /** The ATM bracket ("$target/$stop") we last wrote, to skip re-setting it. */
  private lastBracket: string | null = null;
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
        this.lastBracket = null;
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
    this.lastBracket = null;
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
      this.p.getByRole("button", { name: TXT.loginButton }),
      this.p.getByText(TXT.loginButton, { exact: true }),
      this.p.locator('button:has-text("Login"), [role="button"]:has-text("Login")'),
    ];
    for (const cand of loginCandidates) {
      const el = cand.first();
      if (await el.isVisible({ timeout: 4_000 }).catch(() => false)) {
        await el.click({ timeout: 5_000 }).catch((e) => log.warn(`Login click error: ${e.message}`));
        await this.p.waitForTimeout(750).catch(() => {});
        // Tradovate occasionally ignores a synthetic mouse click while its
        // saved credentials are settling. Invoke the same visible button once
        // through the DOM if the login screen is still present.
        if (await el.isVisible({ timeout: 500 }).catch(() => false)) {
          await el.evaluate((node) => (node as HTMLElement).click()).catch(() => {});
        }
        break;
      }
    }
    await this.p.waitForTimeout(2_500).catch(() => {});
    await this.snapshot("autologin-2-after-login");

    const simBtn = this.p.getByRole("button", { name: TXT.simButton }).or(this.p.getByText(TXT.simButton)).filter({ visible: true }).first();
    if (await simBtn.isVisible({ timeout: 15_000 }).catch(() => false)) {
      await simBtn.click({ timeout: 5_000 }).catch((e) => log.warn(`Sim click error: ${e.message}`));
      await this.p.waitForTimeout(750).catch(() => {});
      if (await simBtn.isVisible({ timeout: 500 }).catch(() => false)) {
        await simBtn.evaluate((node) => (node as HTMLElement).click()).catch(() => {});
      }
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
      await this.p.getByText(label, { exact: true }).filter({ visible: true }).last().click({ timeout: 10_000 });
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

  /** Force-read the visible account label immediately before an order click. */
  async verifySelectedAccount(label: string): Promise<void> {
    await this.requireLoggedIn();
    const visible = await this.p.getByText(this.accountIdPattern).first().textContent({ timeout: 2_000 }).catch(() => null);
    if (!visible?.includes(label)) {
      this.currentAccount = null;
      throw new Error(`Tradovate shows account "${visible?.trim() || "unknown"}", not the required account "${label}". The order was blocked.`);
    }
    this.currentAccount = label;
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

  /** Fast Entry readiness: exact account selected, chart ATM disabled, DOM OCO mode available. */
  async prepareFastAccount(label: string): Promise<void> {
    await this.dismissPopups().catch(() => false);
    await this.switchAccount(label);
    await this.disableChartAtm();
    await this.selectOcoOneTime();
    log.info(`Fast Entry ready: ${label} selected, chart ATM off, DOM OCO-one time available.`);
  }

  private async disableChartAtm(): Promise<void> {
    const clicked = await this.p.evaluate(() => {
      const explicit = document.querySelector<HTMLElement>("[data-atm-off]");
      if (explicit) {
        const rect = explicit.getBoundingClientRect();
        const style = getComputedStyle(explicit);
        if (rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden") { explicit.click(); return true; }
      }
      const labels = [...document.querySelectorAll("*")].filter((el) => {
        const rect = (el as HTMLElement).getBoundingClientRect();
        const style = getComputedStyle(el);
        return (el.textContent || "").trim() === "ATM" && rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      });
      for (const label of labels) {
        let root: Element | null = label.parentElement;
        for (let depth = 0; depth < 5 && root; depth++, root = root.parentElement) {
          const off = [...root.querySelectorAll<HTMLElement>('button,[role="button"]')]
            .find((el) => {
              const rect = el.getBoundingClientRect();
              const style = getComputedStyle(el);
              return (el.textContent || "").trim().toLowerCase() === "off" && rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
            });
          if (off) { off.click(); return true; }
        }
      }
      return false;
    }).catch(() => false);
    if (!clicked) throw new Error("Fast Entry could not turn the chart ATM off. No order was enabled.");
    this.lastBracket = null;
  }

  /** Select Tradovate DOM's one-time OCO mode without placing either order. */
  private async selectOcoOneTime(): Promise<void> {
    const selected = await this.p.evaluate(() => {
      const options = [...document.querySelectorAll("select")].map((select) => ({
        select: select as HTMLSelectElement,
        option: [...(select as HTMLSelectElement).options].find((option) => /oco\s*[- ]?one\s*time/i.test(option.textContent || "")),
      })).find((item) => item.option);
      if (!options?.option) return false;
      options.select.value = options.option.value;
      options.select.dispatchEvent(new Event("input", { bubbles: true }));
      options.select.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }).catch(() => false);
    if (selected) return;

    const already = this.p.getByText(/OCO\s*[- ]?one\s*time/i).filter({ visible: true }).first();
    if (await already.isVisible({ timeout: 500 }).catch(() => false)) return;
    const trigger = this.p.locator('button,[role="button"]').filter({ hasText: /^(Market|MKT|Limit|Stop|Order Type)$/i }).filter({ visible: true }).first();
    if (await trigger.isVisible({ timeout: 700 }).catch(() => false)) await trigger.click({ timeout: 1_500 }).catch(() => {});
    const option = this.p.getByText(/OCO\s*[- ]?one\s*time/i).filter({ visible: true }).last();
    if (await option.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await option.click({ timeout: 1_500 });
      return;
    }
    throw new Error('Fast Entry needs a visible Tradovate DOM with order type "OCO-one time". No order was enabled.');
  }

  private async readPositionDetails(): Promise<{ quantity: number; entryPrice: number } | null> {
    return this.p.evaluate(() => {
      const explicit = document.querySelector<HTMLElement>("[data-position]");
      const explicitPrice = document.querySelector<HTMLElement>("[data-entry-price]");
      if (explicit && explicitPrice) {
        const quantity = Number(explicit.dataset.position);
        const entryPrice = Number(explicitPrice.dataset.entryPrice);
        if (Number.isFinite(quantity) && Number.isFinite(entryPrice)) return { quantity, entryPrice };
      }
      const compact = (document.body.innerText || "").replace(/,/g, "").replace(/\s+/g, " ");
      const position = compact.match(/\bPOSITION\s+(-?\d+)\b/i);
      const average = compact.match(/\b(?:AVG|AVERAGE)(?:\s+FILL)?\s+PRICE\s+([0-9]+(?:\.[0-9]+)?)/i);
      if (!position || !average) return null;
      const quantity = Number(position[1]);
      const entryPrice = Number(average[1]);
      return Number.isFinite(quantity) && Number.isFinite(entryPrice) ? { quantity, entryPrice } : null;
    }).catch(() => null);
  }

  private async dispatchDomOrder(side: "bid" | "ask", price: number, button: "left" | "right", tickSize: number): Promise<void> {
    const error = await this.p.evaluate(({ side, price, button, tickSize }) => {
      let target = [...document.querySelectorAll<HTMLElement>(`[data-dom-side="${side}"][data-dom-price]`)]
        .find((el) => {
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return Math.abs(Number(el.dataset.domPrice) - price) < tickSize / 2 && rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
        });
      if (!target) {
        const priceNode = [...document.querySelectorAll<HTMLElement>("*")]
          .filter((el) => {
            const rect = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && Math.abs(Number((el.textContent || "").trim().replace(/,/g, "")) - price) < tickSize / 2;
          })
          .sort((a, b) => a.getBoundingClientRect().width * a.getBoundingClientRect().height - b.getBoundingClientRect().width * b.getBoundingClientRect().height)[0];
        if (priceNode) {
          const rowY = priceNode.getBoundingClientRect().top + priceNode.getBoundingClientRect().height / 2;
          const headers = [...document.querySelectorAll<HTMLElement>("*")]
            .filter((el) => {
              const rect = el.getBoundingClientRect();
              const style = getComputedStyle(el);
              return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && (el.textContent || "").trim().toLowerCase() === side;
            })
            .sort((a, b) => Math.abs(a.getBoundingClientRect().bottom - rowY) - Math.abs(b.getBoundingClientRect().bottom - rowY));
          const header = headers[0];
          if (header) {
            const x = header.getBoundingClientRect().left + header.getBoundingClientRect().width / 2;
            target = document.elementFromPoint(x, rowY) as HTMLElement | null ?? undefined;
          }
        }
      }
      if (!target) return `Could not find the DOM ${side.toUpperCase()} cell at ${price}.`;
      const opts = { bubbles: true, cancelable: true, view: window, button: button === "right" ? 2 : 0 };
      target.dispatchEvent(new MouseEvent("mousedown", opts));
      target.dispatchEvent(new MouseEvent("mouseup", opts));
      target.dispatchEvent(new MouseEvent(button === "right" ? "contextmenu" : "click", opts));
      return "";
    }, { side, price, button, tickSize }).catch((error) => (error as Error).message);
    if (error) throw new Error(error);
  }

  private async verifyOcoOrders(takeProfitPrice: number, stopLossPrice: number, quantity: number, tickSize: number): Promise<{ count: number; ocoId?: string }> {
    await this.p.waitForTimeout(250).catch(() => {});
    return this.p.evaluate(({ takeProfitPrice, stopLossPrice, quantity, tickSize }) => {
      const explicit = [...document.querySelectorAll<HTMLElement>("[data-working-order]")].map((el) => ({
        price: Number(el.dataset.orderPrice), quantity: Number(el.dataset.orderQuantity), ocoId: el.dataset.ocoId,
      })).filter((order) => Number.isFinite(order.price) && order.quantity === quantity);
      if (explicit.length) {
        const matching = explicit.filter((order) => Math.abs(order.price - takeProfitPrice) < tickSize / 2 || Math.abs(order.price - stopLossPrice) < tickSize / 2);
        const ids = [...new Set(matching.map((order) => order.ocoId).filter(Boolean))];
        return { count: matching.length, ...(ids.length === 1 ? { ocoId: ids[0] } : {}) };
      }
      const candidates = [...document.querySelectorAll<HTMLElement>('[data-order-id],[class*="working-order" i],[class*="order-marker" i],[class*="order-line" i]')];
      const matching = candidates.filter((el) => {
        const text = (el.innerText || el.textContent || "").replace(/,/g, " ");
        const hasQuantity = new RegExp(`(^|\\D)${quantity}(\\D|$)`).test(text);
        const hasPrice = text.includes(String(takeProfitPrice)) || text.includes(String(stopLossPrice));
        return hasQuantity && hasPrice;
      });
      return { count: matching.length };
    }, { takeProfitPrice, stopLossPrice, quantity, tickSize });
  }

  /** After a market fill, add the target and stop as one uninterrupted DOM OCO-one-time pair. */
  async protectOpenPosition(account: AccountDefinition, alert: V4Alert): Promise<ProtectionReceipt> {
    if (!alert.quantity) throw new Error("Fast Entry protection requires the webhook quantity.");
    if (alert.action !== "buy" && alert.action !== "sell") throw new Error("Fast Entry protection only applies to an entry signal.");
    await this.verifySelectedAccount(account.platformLabel);
    let details: { quantity: number; entryPrice: number } | null = null;
    const deadline = Date.now() + 5_000;
    do {
      details = await this.readPositionDetails();
      if (details && Math.abs(details.quantity) === alert.quantity && details.quantity !== 0) break;
      await this.p.waitForTimeout(100);
    } while (Date.now() < deadline);
    if (!details || details.quantity === 0) throw new Error(`Tradovate did not report an open position for ${account.name}; OCO protection was not guessed.`);
    if (Math.abs(details.quantity) !== alert.quantity) throw new Error(`Tradovate reports position ${details.quantity}, but the webhook requested ${alert.quantity}; protection was stopped for review.`);
    if ((alert.action === "buy" && details.quantity < 0) || (alert.action === "sell" && details.quantity > 0)) throw new Error(`Tradovate position direction does not match the ${alert.action} signal.`);

    const plan = planOcoPrices(alert.symbol, alert.action, details.entryPrice, account.targetPerContract, account.stopPerContract);
    const exitSide = plan.side === "long" ? "ask" : "bid";
    const placePair = async () => {
      await this.selectOcoOneTime();
      await this.dispatchDomOrder(exitSide, plan.takeProfitPrice, "left", plan.tickSize);
      await this.dispatchDomOrder(exitSide, plan.stopLossPrice, "right", plan.tickSize);
      return this.verifyOcoOrders(plan.takeProfitPrice, plan.stopLossPrice, alert.quantity!, plan.tickSize);
    };
    let verification = await placePair();
    if (verification.count === 0) verification = await placePair();
    if (verification.count !== 2) {
      await this.snapshot("fast-entry-oco-incomplete", true);
      throw new Error(`Fast Entry created ${verification.count} of 2 required exit orders. Rotation is locked for immediate review.`);
    }
    if (!verification.ocoId) log.warn("OCO linkage inferred from the uninterrupted OCO-one-time sequence; Tradovate did not expose an OCO id in the page.");
    return {
      quantity: alert.quantity,
      entryPrice: details.entryPrice,
      takeProfitPrice: plan.takeProfitPrice,
      stopLossPrice: plan.stopLossPrice,
      protectedAt: new Date().toISOString(),
      ocoId: verification.ocoId ?? "OCO-one-time:UI",
    };
  }

  /** Reads the signed POSITION shown in Tradovate's selected-account header. */
  async readSelectedPosition(): Promise<number | null> {
    if (!this.page || !this.loggedIn) return null;
    const raw = await this.page.getByText(/^POSITION$/i).first().evaluate((node: Element) => {
      let el: Element | null = node;
      for (let i = 0; i < 6 && el; i++) {
        const text = (el.textContent ?? "").replace(/\s+/g, " ");
        if (/\bPOSITION\s+-?\d+\b/i.test(text)) return text;
        el = el.parentElement;
      }
      return node.parentElement?.textContent ?? node.textContent ?? "";
    }).catch(() => "");
    return extractPosition(raw.replace(/\s+/g, " "));
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

  /** Set and verify Tradovate's exchange-held ATM exits in dollars per contract. */
  async setBracket(targetPerContract: number, stopPerContract: number, force = false): Promise<void> {
    if (!(targetPerContract > 0) || !(stopPerContract > 0)) {
      throw new Error(`Bracket needs a positive $ target and stop (got target ${targetPerContract}, stop ${stopPerContract}).`);
    }
    const tp = Math.round(targetPerContract * 100) / 100;
    const sl = Math.round(stopPerContract * 100) / 100;
    const key = `${tp}/${sl}`;
    if (!force && this.lastBracket === key) return;
    await this.requireLoggedIn();

    if (!(await this.atmDialogVisible())) await this.openAtmSettings();
    if (!(await this.atmDialogVisible())) {
      await this.snapshot("atm-dialog-not-open", true);
      throw new Error("Couldn't open the ATM Settings dialog to set the bracket.");
    }
    try {
      if (!(await this.ensureShowInDollars())) throw new Error('Couldn\'t switch the ATM "Show in" to "$ Value".');
      const tpOk = await this.setDialogNumber(/take\s*profit/i, tp);
      const slOk = await this.setDialogNumber(/stop\s*loss/i, sl);
      if (!tpOk || !slOk) throw new Error(`Couldn't set the bracket to $${tp}/$${sl} per contract.`);
      await this.clickDialogButton(/^\s*save\s*$/i);
      await this.p.waitForTimeout(200).catch(() => {});
      await this.openAtmSettings();
      if (!(await this.atmDialogVisible())) throw new Error("Couldn't reopen ATM Settings to verify the saved bracket.");
      const savedTp = await this.readDialogNumber(/take\s*profit/i);
      const savedSl = await this.readDialogNumber(/stop\s*loss/i);
      await this.clickDialogButton(/cancel|close/i);
      if (savedTp !== tp || savedSl !== sl) {
        throw new Error(`Tradovate persisted $${savedTp ?? "?"}/$${savedSl ?? "?"}, not the requested $${tp}/$${sl} bracket.`);
      }
      this.lastBracket = key;
      log.info(`ATM bracket set: +$${tp} / -$${sl} per contract.`);
    } catch (err) {
      await this.snapshot("set-bracket-failed", true);
      await this.clickDialogButton(/cancel|close/i).catch(() => {});
      this.lastBracket = null;
      throw new Error(`${(err as Error).message} — bracket left unchanged so a wrong stop/target can't fire.`);
    }
  }

  /** Reopen ATM Settings and prove the persisted dollar bracket still matches. */
  async verifyBracket(targetPerContract: number, stopPerContract: number): Promise<void> {
    const tp = Math.round(targetPerContract * 100) / 100;
    const sl = Math.round(stopPerContract * 100) / 100;
    await this.requireLoggedIn();
    if (!(await this.atmDialogVisible())) await this.openAtmSettings();
    if (!(await this.atmDialogVisible())) throw new Error("Couldn't open ATM Settings to verify the bracket before the order.");
    try {
      if (!(await this.ensureShowInDollars())) throw new Error('Couldn\'t verify ATM values in "$ Value" mode.');
      const savedTp = await this.readDialogNumber(/take\s*profit/i);
      const savedSl = await this.readDialogNumber(/stop\s*loss/i);
      await this.clickDialogButton(/cancel|close/i);
      if (savedTp !== tp || savedSl !== sl) {
        this.lastBracket = null;
        throw new Error(`ATM verification mismatch: Tradovate shows $${savedTp ?? "?"}/$${savedSl ?? "?"}, but this account requires $${tp}/$${sl}. The order was blocked.`);
      }
      this.lastBracket = `${tp}/${sl}`;
    } catch (error) {
      await this.snapshot("verify-bracket-failed", true);
      await this.clickDialogButton(/cancel|close/i).catch(() => {});
      throw error;
    }
  }

  private async atmDialogVisible(): Promise<boolean> {
    if (!this.page) return false;
    return await this.page.getByText(/ATM Settings/i).first().isVisible({ timeout: 1_000 }).catch(() => false);
  }

  private async openAtmSettings(): Promise<void> {
    const candidates = [
      this.p.locator('[data-testid="atm-settings-button"]'),
      this.p.locator('[aria-label*="atm" i][aria-label*="setting" i]'),
      this.p.locator('[title*="atm" i][title*="setting" i]'),
      this.p.locator('[aria-label*="setting" i]'),
    ];
    for (const candidate of candidates) {
      const el = candidate.first();
      if (await el.isVisible({ timeout: 1_500 }).catch(() => false)) {
        await el.click({ timeout: 3_000 }).catch(() => {});
        if (await this.atmDialogVisible()) return;
        await this.p.keyboard.press("Escape").catch(() => {});
        await this.p.waitForTimeout(150).catch(() => {});
      }
    }

    // Tradovate's current ATM gear is an unlabeled icon. Anchor the fallback
    // to the exact visible ATM row so the separate DAY/GTC gear is never used.
    const marked = await this.p.evaluate(() => {
      const labels = [...document.querySelectorAll("*")]
        .filter((el) => {
          const rect = (el as HTMLElement).getBoundingClientRect();
          const style = getComputedStyle(el);
          return (el.textContent || "").trim() === "ATM" && rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
        })
        .sort((a, b) => (a as HTMLElement).getBoundingClientRect().width - (b as HTMLElement).getBoundingClientRect().width);
      const label = labels[0] as HTMLElement | undefined;
      if (!label) return false;
      const labelRect = label.getBoundingClientRect();
      const labelY = labelRect.top + labelRect.height / 2;
      let container: Element | null = label.parentElement;
      for (let up = 0; up < 6 && container; up++, container = container.parentElement) {
        const choices = [...container.querySelectorAll('button,[role="button"]')]
          .filter((el) => {
            const rect = (el as HTMLElement).getBoundingClientRect();
            const style = getComputedStyle(el);
            return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
          })
          .map((el) => ({ el: el as HTMLElement, rect: (el as HTMLElement).getBoundingClientRect(), text: (el.textContent || "").trim() }))
          .filter(({ rect, text }) => {
            const centerY = rect.top + rect.height / 2;
            return rect.left >= labelRect.right && Math.abs(centerY - labelY) <= 24 && rect.width <= 52 && text === "";
          })
          .sort((a, b) => a.rect.left - b.rect.left);
        if (choices.length) {
          choices[0]!.el.setAttribute("data-bot-atm-settings", "1");
          return true;
        }
      }
      return false;
    }).catch(() => false);
    if (!marked) return;
    const fallback = this.p.locator("[data-bot-atm-settings]").first();
    await fallback.click({ timeout: 3_000 }).catch(() => {});
    await fallback.evaluate((el) => el.removeAttribute("data-bot-atm-settings")).catch(() => {});
  }

  private async ensureShowInDollars(): Promise<boolean> {
    const dollarShown = () => this.p.getByText(/\$\s*value/i).filter({ visible: true }).first().isVisible({ timeout: 1_000 }).catch(() => false);
    if (await dollarShown()) return true;
    // "SHOW IN" and "ATM NAME" share the same form container in Tradovate.
    // Anchor to the visible current value so we open SHOW IN, not ATM NAME.
    await this.p.getByText(/^\s*Ticks\s*$/i).filter({ visible: true }).first().click({ timeout: 2_000 }).catch(() => {});
    const option = this.p.getByText(/\$\s*value/i).filter({ visible: true }).last();
    if (await option.isVisible({ timeout: 1_500 }).catch(() => false)) await option.click({ timeout: 2_000 }).catch(() => {});
    return await dollarShown();
  }

  private async setDialogNumber(labelRe: RegExp, value: number): Promise<boolean> {
    const marked = await this.p.evaluate((args) => {
      const re = new RegExp(args.src, args.flags);
      const all = document.querySelectorAll("*");
      let labelEl: Element | null = null;
      for (const el of all) {
        const t = (el.textContent || "").trim();
        if (t && t.length < 30 && re.test(t) && (!labelEl || t.length < (labelEl.textContent || "").length)) labelEl = el;
      }
      if (!labelEl) return false;
      const labelRect = (labelEl as HTMLElement).getBoundingClientRect();
      const labelY = labelRect.top + labelRect.height / 2;
      const input = [...document.querySelectorAll("input")]
        .map((el) => ({ el: el as HTMLInputElement, rect: (el as HTMLElement).getBoundingClientRect() }))
        .filter(({ rect }) => rect.width > 0 && rect.height > 0)
        .map(({ el, rect }) => ({ el, distance: Math.abs((rect.top + rect.height / 2) - labelY), x: rect.left }))
        .filter(({ distance }) => distance <= 28)
        .sort((a, b) => a.distance - b.distance || a.x - b.x)[0]?.el ?? null;
      if (!input) return false;
      input.setAttribute("data-bot-atm", "1");
      return true;
    }, { src: labelRe.source, flags: labelRe.flags }).catch(() => false);
    if (!marked) return false;
    const box = this.p.locator("[data-bot-atm]").first();
    await box.click({ timeout: 3_000 }).catch(() => {});
    await box.press("ControlOrMeta+a").catch(() => {});
    await box.pressSequentially(String(value), { delay: 15 }).catch(() => {});
    await box.press("Tab").catch(() => {});
    const read = await box.evaluate((el) => Number((el as HTMLInputElement).value)).catch(() => null);
    await box.evaluate((el) => el.removeAttribute("data-bot-atm")).catch(() => {});
    return read === value;
  }

  private async readDialogNumber(labelRe: RegExp): Promise<number | null> {
    return await this.p.evaluate((args) => {
      const re = new RegExp(args.src, args.flags);
      const labels = [...document.querySelectorAll("*")]
        .filter((el) => {
          const text = (el.textContent || "").trim();
          const rect = (el as HTMLElement).getBoundingClientRect();
          return text.length > 0 && text.length < 30 && re.test(text) && rect.width > 0 && rect.height > 0;
        })
        .sort((a, b) => (a.textContent || "").length - (b.textContent || "").length);
      const label = labels[0] as HTMLElement | undefined;
      if (!label) return null;
      const labelRect = label.getBoundingClientRect();
      const labelY = labelRect.top + labelRect.height / 2;
      const input = [...document.querySelectorAll("input")]
        .map((el) => ({ el: el as HTMLInputElement, rect: (el as HTMLElement).getBoundingClientRect() }))
        .filter(({ rect }) => rect.width > 0 && rect.height > 0)
        .map(({ el, rect }) => ({ el, distance: Math.abs((rect.top + rect.height / 2) - labelY), x: rect.left }))
        .filter(({ distance }) => distance <= 28)
        .sort((a, b) => a.distance - b.distance || a.x - b.x)[0]?.el;
      if (!input) return null;
      const value = Number(input.value);
      return Number.isFinite(value) ? value : null;
    }, { src: labelRe.source, flags: labelRe.flags }).catch(() => null);
  }

  private async clickDialogButton(nameRe: RegExp): Promise<void> {
    await this.p.getByRole("button", { name: nameRe }).first().click({ timeout: 3_000 });
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

  /** Read-only metadata for the small strip of controls beside the visible ATM label. */
  async inspectAtmControls(): Promise<Array<Record<string, string | number | boolean>>> {
    if (!this.page) return [];
    const direct = await this.page.evaluate(() => {
      const roots: (Document | ShadowRoot)[] = [document];
      const elements: HTMLElement[] = [];
      while (roots.length) {
        const root = roots.pop()!;
        for (const node of root.querySelectorAll("*")) {
          const el = node as HTMLElement;
          elements.push(el);
          if (el.shadowRoot) roots.push(el.shadowRoot);
        }
      }
      const visible = (el: HTMLElement) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };
      const label = elements
        .filter((el) => (el.textContent || "").trim() === "ATM" && visible(el))
        .sort((a, b) => a.getBoundingClientRect().width - b.getBoundingClientRect().width)[0];
      if (!label) return [];
      const lr = label.getBoundingClientRect();
      const cy = lr.top + lr.height / 2;
      const nearby = elements.filter((el) => {
        if (!visible(el)) return false;
        const r = el.getBoundingClientRect();
        const ey = r.top + r.height / 2;
        return r.left >= lr.left - 12 && r.left <= lr.right + 210 && Math.abs(ey - cy) <= 36 && r.width <= 240 && r.height <= 80;
      });
      const chain = new Set<HTMLElement>();
      for (const el of nearby) {
        chain.add(el);
        let parent = el.parentElement;
        for (let up = 0; up < 3 && parent; up++, parent = parent.parentElement) chain.add(parent);
      }
      return [...chain]
        .filter(visible)
        .map((el) => {
          const r = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return {
            tag: el.tagName.toLowerCase(),
            text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80),
            cls: (el.getAttribute("class") || "").slice(0, 160),
            role: el.getAttribute("role") || "",
            ariaLabel: el.getAttribute("aria-label") || "",
            title: el.getAttribute("title") || "",
            tabIndex: el.tabIndex,
            cursor: style.cursor,
            hasClickHandler: typeof (el as HTMLElement & { onclick?: unknown }).onclick === "function",
            x: Math.round(r.left),
            y: Math.round(r.top),
            width: Math.round(r.width),
            height: Math.round(r.height),
            html: el.outerHTML.replace(/\s+/g, " ").slice(0, 300),
          };
        })
        .sort((a, b) => a.x - b.x || a.width - b.width)
        .slice(0, 80);
    }).catch(() => []);
    if (direct.length) return direct;

    const frameResults: Array<Record<string, string | number | boolean>> = [];
    for (const frame of this.page.frames()) {
      const records = await frame.evaluate(() => {
        const bodyText = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
        const toolbar = document.querySelector('[data-testid="bracket-toolbar"]');
        const matches = [...document.querySelectorAll("*")]
          .filter((node) => toolbar?.contains(node) || /\bATM\b/i.test((node.textContent || "").trim()) || /atm|setting|gear/i.test(`${node.getAttribute("class") || ""} ${node.getAttribute("aria-label") || ""} ${node.getAttribute("title") || ""}`))
          .slice(0, 30)
          .map((node) => {
            const el = node as HTMLElement;
            const r = el.getBoundingClientRect();
            return {
              kind: "element",
              tag: el.tagName.toLowerCase(),
              text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 100),
              cls: (el.getAttribute("class") || "").slice(0, 180),
              role: el.getAttribute("role") || "",
              ariaLabel: el.getAttribute("aria-label") || "",
              title: el.getAttribute("title") || "",
              x: Math.round(r.left),
              y: Math.round(r.top),
              width: Math.round(r.width),
              height: Math.round(r.height),
              html: el.outerHTML.replace(/\s+/g, " ").slice(0, 360),
            };
          });
        return [{
          kind: "frame",
          title: document.title,
          bodyText: bodyText.slice(0, 240),
          elementCount: document.querySelectorAll("*").length,
          matchCount: matches.length,
        }, ...matches];
      }).catch(() => [] as Array<Record<string, string | number | boolean>>);
      for (const record of records) frameResults.push({ frameUrl: frame.url().slice(0, 240), ...record });
    }
    return frameResults.slice(0, 100);
  }

  /** Click Buy Mkt / Sell Mkt. Symbol comes from the Tradovate UI; size is set
   *  by setQuantity when the alert carries one. If a popup blocks the click,
   *  it's cleared and the click retried once. */
  async clickOrder(action: "buy" | "sell", label: string): Promise<void> {
    const btn = action === "buy" ? TXT.buy : TXT.sell;
    await this.clickMarketControl(btn, action.toUpperCase());
    await this.confirmIfPrompted();
  }

  /** Flatten the open position (the "Exit at Mkt & Cxl" button). If a popup
   *  blocks the click, it's cleared and the click retried once. */
  async clickExit(label: string): Promise<void> {
    await this.clickMarketControl(TXT.exit, "EXIT", false);
    await this.confirmIfPrompted();
  }

  /** Page-side dispatch avoids Playwright's compositor wait when the browser is minimized. */
  private async clickMarketControl(text: string, what: string, exact = true): Promise<void> {
    const dispatch = async () => this.p.evaluate(({ text: wanted, exact: exactText }) => {
      const matches = [...document.querySelectorAll<HTMLElement>('button,[role="button"]')].filter((el) => {
        const label = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && !el.hasAttribute("disabled") && el.getAttribute("aria-disabled") !== "true" && (exactText ? label === wanted : label.includes(wanted));
      });
      if (matches.length !== 1) return `Expected exactly one enabled visible control named ${wanted}; found ${matches.length}.`;
      matches[0]!.click();
      return "";
    }, { text, exact });
    try {
      const error = await dispatch();
      if (error) throw new Error(error);
    } catch (error) {
      const cleared = await this.dismissPopups();
      if (!cleared) throw error;
      const retry = await dispatch();
      if (retry) throw new Error(retry);
    }
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
