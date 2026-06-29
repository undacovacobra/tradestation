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

    // Try to log in automatically: click Login (creds are saved on the page),
    // then the "Simulated" environment button.
    log.info("Not logged in — attempting automatic login (Login → Simulated)…");
    await this.tryAutoLogin();
    if (await marker.isVisible({ timeout: 15_000 }).catch(() => false)) {
      log.info("Automatic login succeeded.");
      return;
    }

    // Fallback: let the human finish it in the visible window.
    if (!this.config.headed) {
      throw new Error(
        "Automatic login did not complete and running headless. Start once with HEADED=true and log in manually.",
      );
    }
    log.warn("Could not finish login automatically — please click through it in the browser window…");
    await marker.waitFor({ state: "visible", timeout: 300_000 });
    log.info("Login detected — continuing.");
  }

  /**
   * Best-effort automatic login. The browser profile (SESSION_DIR) remembers the
   * Tradovate username/password and pre-fills them, but silent autofill doesn't
   * fire the events Tradovate's React form needs, so a plain Login click does
   * nothing. So we click into the fields (a trusted gesture that lets us read
   * the autofilled values), RE-TYPE those values ourselves (real keystrokes the
   * form definitely registers), click the exact blue "Login" button (never the
   * Google/Apple sign-in buttons), then click "Start Simulated Trading".
   */
  private async tryAutoLogin(): Promise<void> {
    log.info(`Auto-login v2: current page = ${this.p.url()}`);
    await this.snapshot("autologin-1-loginpage");

    const pwd = this.p.locator('input[type="password"]').first();
    const hasForm = await pwd.isVisible({ timeout: 5_000 }).catch(() => false);
    if (hasForm) {
      log.info("Auto-login: login form detected.");
      const user = this.p
        .locator('input:not([type="password"]):not([type="hidden"]):not([type="checkbox"])')
        .first();

      // Click both fields first: a trusted gesture so we can read autofilled values.
      if (await user.isVisible({ timeout: 1_000 }).catch(() => false)) {
        await user.click({ timeout: 3_000 }).catch(() => {});
      }
      await pwd.click({ timeout: 3_000 }).catch(() => {});

      const vals = await this.p
        .evaluate(() => {
          const inputs = Array.from(document.querySelectorAll("input")) as HTMLInputElement[];
          const p = inputs.find((i) => i.type === "password");
          const u = inputs.find(
            (i) => i !== p && !["hidden", "checkbox", "radio", "submit", "button"].includes(i.type),
          );
          return { u: u?.value ?? "", p: p?.value ?? "" };
        })
        .catch(() => ({ u: "", p: "" }));

      if (vals.u && vals.p) {
        log.info("Auto-login: re-typing pre-filled credentials to commit them.");
        await user.fill(vals.u).catch(() => {});
        await pwd.fill(vals.p).catch(() => {});
      } else {
        log.info("Auto-login: could not read pre-filled values; firing input events instead.");
        await this.p
          .evaluate(() => {
            const desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
            document.querySelectorAll("input").forEach((node) => {
              const el = node as HTMLInputElement;
              if (!el.value) return;
              desc?.set?.call(el, el.value);
              el.dispatchEvent(new Event("input", { bubbles: true }));
              el.dispatchEvent(new Event("change", { bubbles: true }));
            });
          })
          .catch(() => {});
      }
      await this.p.waitForTimeout(400).catch(() => {});

      // Click the EXACT blue "Login" button (not the Google/Apple sign-in buttons).
      const loginBtn = this.p.getByRole("button", { name: "Login", exact: true }).first();
      let clicked = false;
      if (await loginBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await loginBtn.click({ timeout: 5_000 }).catch((e) => log.warn(`Login click error: ${e.message}`));
        clicked = true;
      } else {
        await pwd.press("Enter").catch(() => {});
      }
      log.info(`Auto-login: submitted login (clicked Login button = ${clicked}).`);
    } else {
      log.info("Auto-login: no login form visible — may already be past it.");
    }

    await this.p.waitForTimeout(2_500).catch(() => {});
    await this.snapshot("autologin-2-after-login");

    // Select a Trading Mode -> Start Simulated Trading.
    const simBtn = this.p
      .getByRole("button", { name: /Start Simulated Trading/i })
      .or(this.p.getByText(/Start Simulated Trading/i))
      .first();
    const simVisible = await simBtn.isVisible({ timeout: 20_000 }).catch(() => false);
    log.info(`Auto-login: 'Start Simulated Trading' visible = ${simVisible}`);
    if (simVisible) {
      await simBtn.click({ timeout: 5_000 }).catch((e) => log.warn(`Sim click error: ${e.message}`));
    }
    await this.p.waitForTimeout(2_000).catch(() => {});
    await this.snapshot("autologin-3-after-sim");
  }

  /**
   * Make `account` the active account.
   * 1. Click the top "ACCOUNT" widget to open the account menu.
   * 2. Click the row whose text is the account's id (e.g. LFE05079261220005).
   */
  private async switchAccount(account: AccountSpec): Promise<void> {
    log.info(`Switching active account to ${account.name} [${account.tradovateLabel}]`);
    try {
      // Open the account menu by clicking the account id shown in the top bar.
      // Before the menu opens, an account id (LFE…/LFF…) only appears there, so
      // .first() reliably hits the dropdown toggle.
      await this.p.getByText(TXT.accountIdPattern).first().click({ timeout: 10_000 });
      // Now click the target account's row. The id appears in both the top bar
      // and the menu row; .last() targets the menu list item.
      await this.p
        .getByText(account.tradovateLabel, { exact: false })
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

  /**
   * Switch to an account WITHOUT placing any order. Safe to run any time
   * (market open or closed) — used by the switch-only test. Saves a screenshot
   * so we can confirm the right account became active.
   */
  async selectAccount(account: AccountSpec): Promise<void> {
    await this.switchAccount(account);
    await this.snapshot(`switched-${account.tradovateLabel}`);
  }

  /**
   * Open a position. The symbol comes from whatever contract you've set on the
   * Tradovate chart (one fixed ticker), but the QUANTITY is set from the alert:
   * we type order.quantity into the size box before clicking Buy/Sell.
   */
  async placeOrder(account: AccountSpec, order: OrderRequest): Promise<void> {
    await this.switchAccount(account);
    try {
      await this.setQuantity(order.quantity);
      const label = order.action === "buy" ? TXT.buy : TXT.sell;
      await this.p.getByText(label, { exact: true }).first().click({ timeout: 10_000 });
      await this.confirmIfPrompted();
      await this.snapshot(`order-${order.action}-${order.quantity}-${account.tradovateLabel}`);
      log.trade(`Clicked ${label} x${order.quantity} on ${account.name} [${account.tradovateLabel}]`);
    } catch (err) {
      await this.snapshot(`order-failed-${account.tradovateLabel}`);
      throw new Error(`Order placement failed on ${account.name}: ${(err as Error).message}`);
    }
  }

  /**
   * Type the order size into the quantity box next to Buy/Sell. The box is an
   * editable combobox (shows e.g. "1" with a dropdown of presets), so we find
   * the small numeric <input> in the top order toolbar, clear it, and type the
   * requested size. We then read the value back to confirm it took.
   *
   * Throws if it can't set/confirm the size — better to skip the trade than to
   * fire an order with the wrong number of contracts.
   */
  private async setQuantity(quantity: number): Promise<void> {
    const target = String(quantity);
    log.info(`Setting order size to ${target}…`);

    // Locate the quantity input: a visible <input> in the top toolbar whose
    // current value is all digits (the size box shows e.g. "1"). Tradovate's
    // React class names are auto-generated, so we match by shape/position, not class.
    const handle = await this.p.evaluateHandle(() => {
      const inputs = Array.from(document.querySelectorAll("input")) as HTMLInputElement[];
      const candidates = inputs.filter((el) => {
        const r = el.getBoundingClientRect();
        const onScreen = r.width > 0 && r.height > 0 && r.top >= 0 && r.top < 320;
        return onScreen && /^\d+$/.test((el.value || "").trim());
      });
      return candidates[0] ?? null;
    });

    const el = handle.asElement();
    if (!el) {
      await handle.dispose();
      await this.snapshot(`qty-input-not-found-${target}`);
      throw new Error(
        "Could not find the order size box (the small number box next to Buy/Sell). Check screenshots/.",
      );
    }

    try {
      await el.fill(target);
      await el.press("Enter").catch(() => {});
      await this.p.waitForTimeout(300);
      const now = (await el.inputValue().catch(() => "")).trim();
      if (now !== target) {
        await this.snapshot(`qty-mismatch-${target}`);
        throw new Error(`Order size box shows "${now}" but expected "${target}".`);
      }
      log.info(`Order size confirmed at ${now}.`);
    } finally {
      await handle.dispose();
    }
  }

  /**
   * SAFE test helper: set the order size box only, place no order. Used by the
   * size test so we can confirm size-setting works even with the market closed.
   */
  async setOrderSize(quantity: number): Promise<void> {
    await this.setQuantity(quantity);
    await this.snapshot(`size-test-${quantity}`);
  }

  /** Diagnostic: log every <input> in the page so we can locate the size box. */
  async debugToolbarInputs(): Promise<void> {
    const info = await this.p.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll("input")) as HTMLInputElement[];
      return inputs.map((el, i) => {
        const r = el.getBoundingClientRect();
        return {
          i,
          type: el.type,
          value: el.value,
          placeholder: el.placeholder,
          top: Math.round(r.top),
          left: Math.round(r.left),
          w: Math.round(r.width),
          h: Math.round(r.height),
        };
      });
    });
    log.info(`Page inputs found:\n${JSON.stringify(info, null, 2)}`);
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
