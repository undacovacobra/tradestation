import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type BrowserContext, type Locator, type Page } from "playwright";
import type { Config } from "./config.js";
import { extractEquity } from "./balanceParse.js";
import {
  classifyBrokerPosition,
  classifyTopPositionSummary,
  combineBrokerPositionSources,
  type BrokerPosition,
} from "./brokerPosition.js";
import { notifyActionNeeded } from "./notify.js";
import { log } from "./logger.js";
import type { Group } from "./types.js";
import {
  inspectTicketCapabilities as probeTicketCapabilities,
  type DualTicketController,
  type TicketCapabilities,
} from "./ticketCapabilities.js";

/** Dual-ticket isolation covers only the eval + funded pair; a third rotation
 *  lane (e.g. winning) always runs in sequential mode and never reaches here. */
function dualStage(group: Group): "evals" | "funded" {
  if (group === "winning") throw new Error("Dual-ticket operations support only the evaluation and funded lanes.");
  return group;
}

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
  clockWarning: /Your clock is out of sync!/i,
  clockContinue: "Continue",
  simulationButton: /^(?:Access Simulation|Start Simulated Trading)$/i,
  equity: /EQUITY/i, // top bar: "EQUITY  50,320.00 USD" for the SELECTED account
};

export interface BrowserStatus {
  connected: boolean;
  loggedIn: boolean;
  /** True once a session was established this run — i.e. being logged out now
   *  is unexpected and the self-heal path may log back in. */
  expectsLogin: boolean;
}

/**
 * Owns the single persistent Tradovate browser session. You log in once (incl.
 * 2FA); the session is stored in SESSION_DIR and reused on every restart.
 */
export class TradovateBrowser {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private loggedIn = false;
  /** True once a logged-in session has been confirmed at least once this run.
   *  Gates auto-login so it only self-heals a session that WAS established and
   *  then dropped — never on a fresh Connect or while you sign in by hand. */
  private shouldBeLoggedIn = false;
  /** The account the bot last selected. The bot is the only thing that switches
   *  accounts, so this is authoritative — used to skip the switch instantly when
   *  we're already on the right account (armed). Reset on (re)connect. */
  private currentAccount: string | null = null;
  /** The order size we last set on the ticket. Lets us skip re-setting the same
   *  size (a pure no-op) and forces a re-set after an account switch. */
  private lastQty: number | null = null;
  /** The ATM preset we last selected, to skip re-selecting the same one. */
  private lastPreset: string | null = null;
  private ticketCapabilities: TicketCapabilities | undefined;
  private readonly shotDir: string;

  constructor(private readonly config: Config) {
    this.shotDir = config.screenshotDir;
  }

  status(): BrowserStatus {
    return { connected: this.page !== null, loggedIn: this.loggedIn, expectsLogin: this.shouldBeLoggedIn };
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
        this.lastPreset = null;
        this.ticketCapabilities = undefined;
      });
      this.page = this.context.pages()[0] ?? (await this.context.newPage());
      await this.page.goto(this.config.tradovateUrl, { waitUntil: "domcontentloaded" });
    }
    await this.refreshLoginState(5_000);
    // Connect NEVER auto-clicks the login flow. If you're not logged in, the
    // screen is left alone so you can sign in yourself (or switch accounts)
    // without the bot spamming the Login button. Auto-login only ever happens
    // from the self-heal path (recover), and only after a session was actually
    // established and then unexpectedly lost.
    if (!this.loggedIn) {
      log.info("Connected but not logged in — leaving the login screen for you (no auto-login on Connect).");
    } else {
      // A popup (notice/agreement) often greets a fresh session — clear it now.
      await this.dismissPopups().catch(() => false);
    }
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
    // Only auto-login when a session was actually established this run and then
    // lost — "logged out when it shouldn't be." If we were never logged in
    // (fresh connect, or you're signing in by hand), leave the screen alone so
    // the bot never fights your manual login / account switch.
    if (!this.shouldBeLoggedIn) {
      await this.refreshLoginState(1_000).catch(() => false);
      return this.status();
    }
    if (!this.page) return this.connect();
    log.warn("Recovering Tradovate session (reload + re-login)…");
    this.currentAccount = null;
    this.lastQty = null;
    this.lastPreset = null;
    this.ticketCapabilities = undefined;
    await this.page.goto(this.config.tradovateUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
    await this.refreshLoginState(6_000);
    if (!this.loggedIn) {
      await this.tryAutoLogin();
      await this.refreshLoginState(6_000);
    }
    if (this.loggedIn) await this.dismissPopups().catch(() => false);
    return this.status();
  }

  /**
   * Re-enter an already-visible Tradovate login flow without navigating or
   * reloading. This is safe to attempt while a recorded trade is open because
   * it only clicks the bounded Login / clock Continue / Simulation controls and
   * preserves the selected account, ATM, and quantity bookkeeping.
   */
  async resumeExistingLogin(): Promise<BrowserStatus> {
    if (!this.page) return this.status();
    await this.refreshLoginState(1_000);
    if (!this.loggedIn) {
      await this.tryAutoLogin();
      await this.refreshLoginState(6_000);
    }
    if (this.loggedIn) await this.dismissPopups().catch(() => false);
    return this.status();
  }

  async inspectCapabilities(): Promise<TicketCapabilities> {
    if (!this.page) {
      return { mode: "sequential", reason: "Tradovate is not connected, so ticket isolation cannot be proved." };
    }
    if (!this.ticketCapabilities) this.ticketCapabilities = await probeTicketCapabilities(this.page);
    return this.ticketCapabilities;
  }

  private async dualTicketController(): Promise<DualTicketController> {
    const capability = await this.inspectCapabilities();
    if (capability.mode !== "dual-ticket" || !capability.controller) {
      throw new Error(`Dual-ticket operations are unavailable: ${capability.reason}`);
    }
    return capability.controller;
  }

  async armForLane(group: Group, label: string): Promise<void> {
    const controller = await this.dualTicketController();
    const current = await controller.read(dualStage(group));
    await controller.prepare(dualStage(group), { ...current, account: label });
  }

  async readLaneEquity(_group: Group): Promise<number | null> {
    // The live top-bar equity is global, not proven ticket-scoped. Returning
    // null prevents one lane from attributing another lane's balance.
    return null;
  }

  async selectLaneAtmPreset(group: Group, name: string): Promise<void> {
    const controller = await this.dualTicketController();
    const current = await controller.read(dualStage(group));
    await controller.prepare(dualStage(group), { ...current, atmPreset: name });
  }

  async setLaneQuantity(group: Group, quantity: number): Promise<void> {
    const controller = await this.dualTicketController();
    const current = await controller.read(dualStage(group));
    await controller.prepare(dualStage(group), { ...current, quantity });
  }

  async clickLaneOrder(group: Group, action: "buy" | "sell", _label: string): Promise<void> {
    await (await this.dualTicketController()).clickOrder(dualStage(group), action);
  }

  async clickLaneExit(group: Group, _label: string): Promise<void> {
    await (await this.dualTicketController()).clickExit(dualStage(group));
  }

  async verifyLaneAccount(group: Group, label: string): Promise<boolean> {
    return (await (await this.dualTicketController()).read(dualStage(group))).account === label;
  }

  /** Read the visible ticket size from the DOM, never from the cached value. */
  private async displayedQuantity(): Promise<number | null> {
    if (!this.page) return null;
    return this.page.evaluate(() => {
      const stack: (Document | ShadowRoot)[] = [document];
      let numeric: HTMLInputElement | null = null;
      let formControl: HTMLInputElement | null = null;
      while (stack.length) {
        const root = stack.pop()!;
        const marked = root.querySelector("[data-bot-qty]") as HTMLInputElement | null;
        if (marked && marked.offsetWidth > 0 && marked.offsetHeight > 0) return Number(marked.value);
        const all = root.querySelectorAll("*");
        for (let i = 0; i < all.length; i++) {
          const el = all[i] as HTMLElement;
          if (el.shadowRoot) stack.push(el.shadowRoot);
          if (!(el instanceof HTMLInputElement)) continue;
          const style = getComputedStyle(el);
          if (el.offsetWidth <= 0 || el.offsetHeight <= 0 || style.display === "none" || style.visibility === "hidden") continue;
          const hint = `${el.getAttribute("aria-label") || ""} ${el.name || ""} ${el.placeholder || ""}`.toLowerCase();
          const cls = (el.className || "").toString().toLowerCase();
          if (/qty|quantity|size|contract/.test(hint)) return Number(el.value);
          if (!numeric && el.type === "number") numeric = el;
          if (!formControl && cls.includes("form-control") && /^\s*\d+\s*$/.test(el.value)) formControl = el;
        }
      }
      return numeric ? Number(numeric.value) : formControl ? Number(formControl.value) : null;
    }).catch(() => null);
  }

  async verifySequentialPreparedOrderState(label: string, atmPreset: string, quantity?: number): Promise<boolean> {
    if (!await this.verifyActiveAccount(label)) return false;
    if (atmPreset.trim() && !await this.atmPresetShown(atmPreset)) return false;
    const displayed = await this.displayedQuantity();
    if (!Number.isInteger(displayed) || displayed! < 1) return false;
    return quantity == null || displayed === Math.floor(quantity);
  }

  async verifySequentialExitState(label: string): Promise<boolean> {
    return this.verifyActiveAccount(label);
  }

  /** Fail-closed final read immediately before a Buy/Sell click. */
  async verifyPreparedOrderState(group: Group, label: string, atmPreset: string, quantity?: number): Promise<boolean> {
    const capability = await this.inspectCapabilities();
    if (capability.mode === "dual-ticket" && capability.controller) {
      const state = await capability.controller.read(dualStage(group));
      return state.account === label
        && (!atmPreset.trim() || state.atmPreset === atmPreset.trim())
        && (quantity == null || state.quantity === Math.floor(quantity));
    }
    return this.verifySequentialPreparedOrderState(label, atmPreset, quantity);
  }

  /** Fail-closed final account read immediately before an Exit click. */
  async verifyExitState(group: Group, label: string): Promise<boolean> {
    const capability = await this.inspectCapabilities();
    if (capability.mode === "dual-ticket" && capability.controller) {
      return (await capability.controller.read(dualStage(group))).account === label;
    }
    return this.verifySequentialExitState(label);
  }

  /** Re-check whether the trader screen is actually loaded and logged in. */
  async refreshLoginState(timeout = 3_000): Promise<boolean> {
    if (!this.page) return false;
    const marker = this.page.getByText(TXT.loggedInMarker, { exact: true }).first();
    this.loggedIn = await marker.isVisible({ timeout }).catch(() => false);
    if (this.loggedIn) this.shouldBeLoggedIn = true; // a real session existed — self-heal may re-login it later
    return this.loggedIn;
  }

  /**
   * Bounded, click-only session recovery. This deliberately never inspects or
   * fills credentials and never touches an order control. The persistent
   * browser profile must already hold any username/password needed by Login.
   */
  private async tryAutoLogin(): Promise<void> {
    await this.snapshot("autologin-1-loginpage");
    let clickedApprovedControl = false;
    let unknownPolls = 0;
    for (let step = 0; step < 80; step++) {
      if (await this.refreshLoginState(250)) return;

      const clockHeading = this.p.getByText(TXT.clockWarning).first();
      const continueButton = this.p.getByRole("button", { name: TXT.clockContinue, exact: true }).first();
      const loginButton = this.p.getByRole("button", { name: TXT.loginButton, exact: true }).first();
      const simulationButton = this.p.getByRole("button", { name: TXT.simulationButton }).first();

      let action: { kind: "clock" | "login" | "simulation"; locator: Locator } | null = null;
      if (
        await clockHeading.isVisible().catch(() => false)
        && await continueButton.isVisible().catch(() => false)
      ) {
        action = { kind: "clock", locator: continueButton };
      } else if (await loginButton.isVisible().catch(() => false)) {
        action = { kind: "login", locator: loginButton };
      } else if (await simulationButton.isVisible().catch(() => false)) {
        action = { kind: "simulation", locator: simulationButton };
      }

      if (!action) {
        unknownPolls++;
        const limit = clickedApprovedControl ? 40 : 4;
        if (unknownPolls >= limit) return;
        await this.p.waitForTimeout(250).catch(() => {});
        continue;
      }

      if (action.kind === "clock") {
        log.warn("Tradovate displayed its clock warning; continuing without changing Windows time.");
      }
      await action.locator.click({ timeout: 5_000 }).catch((error: Error) => {
        log.warn(`Tradovate ${action!.kind} recovery click error: ${error.message}`);
      });
      clickedApprovedControl = true;
      unknownPolls = 0;
      await this.snapshot(`autologin-${step + 2}-after-${action.kind}`);
      await this.p.waitForTimeout(500).catch(() => {});
    }
  }

  /**
   * Read every account id visible in the Tradovate account menu (for the
   * dashboard's “Scan” feature). Opens the menu, collects LFE…/LFF… labels,
   * then closes the menu. Places no orders.
   */
  async listAccounts(): Promise<string[]> {
    await this.requireLoggedIn();
    try {
      await this.p.keyboard.press("Escape").catch(() => {});
      const active = await this.readVisibleActiveAccount();
      const opener = active ? await this.visibleAccountLocator(active) : null;
      if (!opener) throw new Error("Could not find the visible selected-account control.");
      await opener.click({ timeout: 10_000 });
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
    const current = await this.readVisibleActiveAccount();
    if (current === label) {
      this.currentAccount = label;
      this.lastQty = null; // new account — ticket size unknown, re-set on next order
      this.lastPreset = null; // and its ATM preset — per-account, must be re-set
      return;
    }
    log.info(`Switching active account to ${label}`);
    try {
      let lastObserved = current;
      for (let attempt = 0; attempt < 2; attempt++) {
        await this.p.keyboard.press("Escape").catch(() => {});
        const visibleCurrent = await this.readVisibleActiveAccount();
        const opener = visibleCurrent ? await this.visibleAccountLocator(visibleCurrent) : null;
        if (!opener) throw new Error("Could not find the visible selected-account control.");
        await opener.click({ timeout: 10_000 });
        await this.p.waitForTimeout(100).catch(() => {});

        const seen = new Set<string>();
        const option = await this.findAccountInOpenMenu(label, seen);
        if (!option) {
          await this.p.keyboard.press("Escape").catch(() => {});
          const list = [...seen].sort().join(", ") || "no accounts";
          throw new Error(`Account ${label} was not found in the Tradovate account menu even after scrolling (menu showed: ${list}).`);
        }
        await option.click({ timeout: 10_000 });
        await this.p.waitForTimeout(Math.max(0, this.config.switchSettleMs));
        lastObserved = await this.readVisibleActiveAccount();
        if (lastObserved === label) {
          this.currentAccount = label;
          this.lastQty = null; // new account — ticket size unknown, re-set on next order
          this.lastPreset = null; // and its ATM preset — per-account, must be re-set
          return;
        }
        this.currentAccount = null;
      }
      throw new Error(`Tradovate still showed ${lastObserved ?? "no account"} after selecting ${label}.`);
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

  /** Rebuild the sequential ticket from live Tradovate state after manual drift. */
  async repairSequentialPreparedOrderState(label: string, atmPreset: string, quantity?: number): Promise<void> {
    this.currentAccount = null;
    this.lastPreset = null;
    this.lastQty = null;
    await this.armFor(label);
    if (atmPreset.trim()) await this.selectAtmPreset(atmPreset, true);
    if (quantity != null) await this.setQuantity(quantity, true);
  }

  /** Cheap safety read used only while closing/monitoring an open trade. */
  async verifyActiveAccount(label: string): Promise<boolean> {
    await this.requireLoggedIn();
    const matches = await this.readVisibleActiveAccount() === label;
    if (!matches) this.currentAccount = null;
    return matches;
  }

  /** Tradovate leaves every account-menu label mounted while the menu is
   * closed. Playwright's `.first()` can therefore read or click a hidden stale
   * row instead of the selected-account header. Close the menu, then use only
   * a genuinely visible account token as the broker source of truth. */
  private async readVisibleActiveAccount(): Promise<string | null> {
    if (!this.page) return null;
    await this.page.keyboard.press("Escape").catch(() => {});
    await this.page.waitForTimeout(50).catch(() => {});
    const matches = this.page.getByText(TXT.accountIdPattern);
    const count = await matches.count().catch(() => 0);
    let best: { label: string; area: number; y: number } | null = null;
    for (let i = 0; i < count; i++) {
      const item = matches.nth(i);
      if (!await item.isVisible().catch(() => false)) continue;
      const text = await item.textContent().catch(() => null);
      const candidate = text?.match(/LF[EF]\d{6,}/)?.[0] ?? null;
      if (!candidate) continue;
      const box = await item.boundingBox().catch(() => null);
      const area = box ? box.width * box.height : Number.POSITIVE_INFINITY;
      const y = box?.y ?? Number.POSITIVE_INFINITY;
      if (!best || area < best.area || (area === best.area && y < best.y)) best = { label: candidate, area, y };
    }
    return best?.label ?? null;
  }

  /** Find the smallest visible element containing one exact account token.
   * Clicking the inner text bubbles to Tradovate's stable header/menu control
   * while hidden duplicate rows are ignored. */
  private async visibleAccountLocator(label: string): Promise<Locator | null> {
    if (!this.page) return null;
    const matches = this.page.getByText(label, { exact: false });
    const count = await matches.count().catch(() => 0);
    let best: { locator: Locator; area: number } | null = null;
    for (let i = 0; i < count; i++) {
      const item = matches.nth(i);
      if (!await item.isVisible().catch(() => false)) continue;
      const text = (await item.textContent().catch(() => null) ?? "").replace(/\s+/g, " ").trim();
      const tokens = text.split(/[^A-Za-z0-9_-]+/).filter(Boolean);
      if (!tokens.includes(label)) continue;
      const box = await item.boundingBox().catch(() => null);
      const area = box ? box.width * box.height : Number.POSITIVE_INFINITY;
      if (!best || area < best.area) best = { locator: item, area };
    }
    return best?.locator ?? null;
  }

  /**
   * With the account menu already open, find the row for `label` — scrolling the
   * menu down to bring accounts that are below the fold (or lazily rendered by a
   * long/virtualized list) into view. Records every account id it passes into
   * `seen` so a failure can report exactly what the menu actually contained.
   */
  private async findAccountInOpenMenu(label: string, seen: Set<string>, maxScrolls = 30): Promise<Locator | null> {
    const collect = async () => {
      for (const t of await this.p.getByText(TXT.accountIdPattern).allTextContents().catch(() => [])) {
        for (const m of t.match(/LF[EF]\d{6,}/g) ?? []) seen.add(m);
      }
    };
    await collect();
    let found = await this.visibleAccountLocator(label);
    let previousLast = "";
    for (let i = 0; i < maxScrolls && !found; i++) {
      const rows = this.p.getByText(TXT.accountIdPattern);
      const n = await rows.count().catch(() => 0);
      if (n === 0) break;
      // Pulling the last rendered row into view scrolls a plain long list and
      // forces a virtualized list to render its next batch.
      await rows.nth(n - 1).scrollIntoViewIfNeeded({ timeout: 2_000 }).catch(() => {});
      await this.p.waitForTimeout(120).catch(() => {});
      await collect();
      found = await this.visibleAccountLocator(label);
      const lastText = (await rows.nth(n - 1).textContent().catch(() => "")) ?? "";
      const lastToken = lastText.match(/LF[EF]\d{6,}/)?.[0] ?? "";
      if (!lastToken || lastToken === previousLast) break; // reached the end — no more rows appearing
      previousLast = lastToken;
    }
    return found;
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

  /** Read the selected account's position from the order ticket and top
   * `Positions: + N/- N` summary in one page pass. The ticket is primary and
   * the top summary is corroborating/fallback evidence. Hidden, malformed,
   * duplicate, or conflicting evidence always fails safe. */
  async readSelectedPosition(): Promise<BrokerPosition> {
    const checkedAt = new Date().toISOString();
    if (!this.page || !this.loggedIn) {
      return { status: "unknown", reason: "Tradovate is not connected and logged in.", checkedAt };
    }
    const evidence = await this.page.evaluate(() => {
      const roots: (Document | ShadowRoot)[] = [document];
      const labels: HTMLElement[] = [];
      const positionContainers: Array<{ element: HTMLElement; value: string }> = [];
      const summaryCandidates: string[] = [];
      while (roots.length) {
        const root = roots.pop()!;
        const all = root.querySelectorAll("*");
        for (let i = 0; i < all.length; i++) {
          const el = all[i] as HTMLElement;
          if (el.shadowRoot) roots.push(el.shadowRoot);
          const style = getComputedStyle(el);
          if (el.offsetWidth <= 0 || el.offsetHeight <= 0 || style.display === "none" || style.visibility === "hidden") continue;
          const text = (el.textContent || "").replace(/\s+/g, " ").trim();
          if (text.toUpperCase() === "POSITION") labels.push(el);

          // The live Tradovate ticket currently renders POSITION, its integer,
          // and the USD placeholder in one container (for example
          // "POSITION0-.-- USD"). There may be no standalone POSITION element,
          // so capture the integer directly from the smallest matching visible
          // container. A decimal such as "0.00 USD" is deliberately rejected.
          const direct = text.match(/^POSITION\s*:?\s*([+-]?(?:\d+|\d{1,3}(?:,\d{3})+))(?=\s|$|[-A-Za-z])/i);
          if (direct) {
            let hasMatchingDescendant = false;
            const descendants = el.querySelectorAll("*");
            for (let j = 0; j < descendants.length; j++) {
              const child = descendants[j] as HTMLElement;
              const childStyle = getComputedStyle(child);
              if (child.offsetWidth <= 0 || child.offsetHeight <= 0 || childStyle.display === "none" || childStyle.visibility === "hidden") continue;
              const childText = (child.textContent || "").replace(/\s+/g, " ").trim();
              if (/^POSITION\s*:?\s*([+-]?(?:\d+|\d{1,3}(?:,\d{3})+))(?=\s|$|[-A-Za-z])/i.test(childText)) {
                hasMatchingDescendant = true;
                break;
              }
            }
            if (!hasMatchingDescendant) positionContainers.push({ element: el, value: direct[1]! });
          }

          if (/^Positions:\s*\+\s*\d+\s*\/\s*-\s*\d+$/i.test(text)) {
            let hasMatchingDescendant = false;
            const descendants = el.querySelectorAll("*");
            for (let j = 0; j < descendants.length; j++) {
              const child = descendants[j] as HTMLElement;
              const childStyle = getComputedStyle(child);
              if (child.offsetWidth <= 0 || child.offsetHeight <= 0 || childStyle.display === "none" || childStyle.visibility === "hidden") continue;
              const childText = (child.textContent || "").replace(/\s+/g, " ").trim();
              if (/^Positions:\s*\+\s*\d+\s*\/\s*-\s*\d+$/i.test(childText)) {
                hasMatchingDescendant = true;
                break;
              }
            }
            if (!hasMatchingDescendant) summaryCandidates.push(text);
          }
        }
      }

      // Accept a direct POSITION value only when it belongs to the actual
      // order ticket containing both market-entry buttons. This rejects the
      // portfolio/history decoys elsewhere on the page.
      const directTicketCandidates: string[] = [];
      for (let i = 0; i < positionContainers.length; i++) {
        const position = positionContainers[i]!;
        let ticket: HTMLElement | null = position.element;
        while (ticket && ticket.tagName !== "BODY" && ticket.tagName !== "HTML") {
          let hasBuy = false;
          let hasSell = false;
          const descendants = ticket.querySelectorAll("*");
          for (let j = 0; j < descendants.length; j++) {
            const node = descendants[j] as HTMLElement;
            const style = getComputedStyle(node);
            if (node.offsetWidth <= 0 || node.offsetHeight <= 0 || style.display === "none" || style.visibility === "hidden") continue;
            const text = (node.textContent || "").replace(/\s+/g, " ").trim();
            if (text === "Buy Mkt") hasBuy = true;
            if (text === "Sell Mkt") hasSell = true;
          }
          if (hasBuy && hasSell) break;
          ticket = ticket.parentElement;
        }
        if (ticket && ticket.tagName !== "BODY" && ticket.tagName !== "HTML") {
          directTicketCandidates.push(position.value);
        }
      }
      if (directTicketCandidates.length > 0) {
        return { ticketCandidates: directTicketCandidates, summaryCandidates };
      }

      const found: string[] = [];
      for (let i = 0; i < labels.length; i++) {
        const label = labels[i]!;
        let ticket: HTMLElement | null = label.parentElement;
        while (ticket && ticket.tagName !== "BODY" && ticket.tagName !== "HTML") {
          let hasBuy = false;
          let hasSell = false;
          const descendants = ticket.querySelectorAll("*");
          for (let j = 0; j < descendants.length; j++) {
            const node = descendants[j] as HTMLElement;
            const style = getComputedStyle(node);
            if (node.offsetWidth <= 0 || node.offsetHeight <= 0 || style.display === "none" || style.visibility === "hidden") continue;
            const text = (node.textContent || "").replace(/\s+/g, " ").trim();
            if (text === "Buy Mkt") hasBuy = true;
            if (text === "Sell Mkt") hasSell = true;
          }
          if (hasBuy && hasSell) break;
          ticket = ticket.parentElement;
        }
        if (!ticket || ticket.tagName === "BODY" || ticket.tagName === "HTML") continue;

        let scope: HTMLElement | null = label.parentElement;
        let candidate: string | null = null;
        while (scope) {
          const numeric: string[] = [];
          // Live Tradovate wraps the count in <div class="number">0<span…></span></div>
          // — the value is the element's OWN text node, and a smaller child span
          // may carry an average price. So look at each DIRECT child of the
          // position cell and read only its own (non-descendant) text; a nested
          // decimal price is deliberately never considered, so it can't be
          // mistaken for the whole-contract count.
          const children = scope.children;
          for (let j = 0; j < children.length; j++) {
            const node = children[j] as HTMLElement;
            const style = getComputedStyle(node);
            if (node.offsetWidth <= 0 || node.offsetHeight <= 0 || style.display === "none" || style.visibility === "hidden") continue;
            let own = "";
            for (let k = 0; k < node.childNodes.length; k++) {
              const cn = node.childNodes[k]!;
              if (cn.nodeType === 3) own += cn.textContent || "";
            }
            own = own.replace(/\s+/g, " ").trim();
            if (/^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(own)) numeric.push(own);
          }
          // A live open Tradovate position reverses that nesting: the
          // div.number's own text is the average price ("@28814.00") and the
          // signed contract count is a child span ("-10"). If no direct child
          // supplied a count, inspect only leaf descendants inside this tight
          // Position cell. Decimal prices/P&L remain ineligible, and multiple
          // whole-number leaves remain ambiguous instead of guessing.
          if (numeric.length === 0) {
            const descendants = scope.querySelectorAll("*");
            for (let j = 0; j < descendants.length; j++) {
              const node = descendants[j] as HTMLElement;
              if (node.childElementCount > 0) continue;
              const style = getComputedStyle(node);
              if (node.offsetWidth <= 0 || node.offsetHeight <= 0 || style.display === "none" || style.visibility === "hidden") continue;
              const text = (node.textContent || "").replace(/\s+/g, " ").trim();
              if (/^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(text)) numeric.push(text);
            }
          }
          if (numeric.length === 1) {
            candidate = numeric[0]!;
            break;
          }
          if (scope === ticket) break;
          scope = scope.parentElement;
        }
        if (candidate != null) found.push(candidate);
      }
      return { ticketCandidates: found, summaryCandidates };
    }).catch(() => ({ ticketCandidates: [] as string[], summaryCandidates: [] as string[] }));

    const ticket = classifyBrokerPosition(evidence.ticketCandidates, checkedAt);
    const summary = classifyTopPositionSummary(evidence.summaryCandidates, checkedAt);
    return combineBrokerPositionSources(ticket, summary);
  }

  /**
   * READ-ONLY calibration probe. When `readSelectedPosition` returns UNKNOWN it
   * is because the real Tradovate POSITION readout doesn't match the shapes the
   * classifier expects (the ticket-scoped POSITION cell, or a `Positions: +N/-N`
   * summary). This dumps everything visible on the page that mentions "position"
   * so the exact live markup can be seen and the selector calibrated. It never
   * clicks, types, or changes anything. Capped so the payload stays small.
   */
  async diagnosePosition(): Promise<{ position: BrokerPosition; nearby: Array<Record<string, string>> }> {
    const position = await this.readSelectedPosition();
    if (!this.page || !this.loggedIn) return { position, nearby: [] };
    const nearby = await this.page.evaluate(() => {
      const roots: (Document | ShadowRoot)[] = [document];
      const rows: Array<Record<string, string>> = [];
      const seen = new Set<HTMLElement>();
      while (roots.length && rows.length < 40) {
        const root = roots.pop()!;
        const all = root.querySelectorAll("*");
        for (let i = 0; i < all.length && rows.length < 40; i++) {
          const el = all[i] as HTMLElement;
          if (el.shadowRoot) roots.push(el.shadowRoot);
          const style = getComputedStyle(el);
          if (el.offsetWidth <= 0 || el.offsetHeight <= 0 || style.display === "none" || style.visibility === "hidden") continue;
          const own = (el.textContent || "").replace(/\s+/g, " ").trim();
          if (!/position/i.test(own) || own.length > 80) continue;
          // Only the tightest element wrapping the word (skip big ancestors that
          // merely contain a position element deeper down).
          if (el.parentElement && seen.has(el.parentElement)) continue;
          seen.add(el);

          const container = el.parentElement ?? el;
          const containerText = (container.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120);
          const numbers: string[] = [];
          const leaves = container.querySelectorAll("*");
          for (let j = 0; j < leaves.length; j++) {
            const leaf = leaves[j] as HTMLElement;
            if (leaf.childElementCount > 0) continue;
            const ls = getComputedStyle(leaf);
            if (leaf.offsetWidth <= 0 || leaf.offsetHeight <= 0 || ls.display === "none" || ls.visibility === "hidden") continue;
            const t = (leaf.textContent || "").replace(/\s+/g, " ").trim();
            if (t && /\d/.test(t) && t.length <= 24) numbers.push(t);
          }

          let insideTicket = "no";
          let anc: HTMLElement | null = container;
          for (let hops = 0; anc && hops < 25; hops++) {
            const at = (anc.textContent || "");
            if (at.includes("Buy Mkt") && at.includes("Sell Mkt")) { insideTicket = "yes"; break; }
            anc = anc.parentElement;
          }

          // Compact element tree of the position cell so the value's real
          // element boundary is visible (does "0" live in its own box, or is it
          // glued to the "Position" text?). Direct text nodes are quoted.
          const parts: string[] = [];
          const stack: Array<{ node: HTMLElement; depth: number }> = [{ node: el, depth: 0 }];
          while (stack.length && parts.length < 30) {
            const { node, depth } = stack.pop()!;
            const cls = (node.getAttribute("class") || "").split(/\s+/).filter(Boolean).slice(0, 2).join(".");
            let direct = "";
            for (let k = 0; k < node.childNodes.length; k++) {
              const cn = node.childNodes[k]!;
              if (cn.nodeType === 3) direct += cn.textContent || "";
            }
            direct = direct.replace(/\s+/g, " ").trim();
            parts.push(`${"·".repeat(depth)}<${node.tagName.toLowerCase()}${cls ? "." + cls : ""}>${direct ? ` "${direct.slice(0, 24)}"` : ""}`);
            const kids = Array.from(node.children) as HTMLElement[];
            for (let k = kids.length - 1; k >= 0; k--) stack.push({ node: kids[k]!, depth: depth + 1 });
          }

          rows.push({
            tag: el.tagName.toLowerCase(),
            label: own.slice(0, 60),
            containerText,
            numbersNearby: numbers.slice(0, 8).join(" | ") || "(none)",
            insideOrderTicket: insideTicket,
            structure: parts.join("  "),
          });
        }
      }
      return rows;
    }).catch(() => [] as Array<Record<string, string>>);
    return { position, nearby };
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
   * Select a saved Tradovate ATM preset by NAME from the ATM dropdown, so the
   * exchange holds that preset's stop/target. Done at ARM time (idle) — off the
   * entry click. Cached (same preset = no-op). Verifies the preset shows after
   * and throws on any miss, so a wrong bracket can't be armed. SAFE: only ever
   * opens the ATM dropdown and clicks a matching option — never a trade button.
   */
  async selectAtmPreset(name: string, force = false): Promise<void> {
    const want = name.trim();
    if (!want) return;
    if (!force && this.lastPreset === want) return;
    await this.requireLoggedIn();
    const p = this.p;

    if (await this.atmPresetShown(want)) {
      this.lastPreset = want;
      return;
    }

    // Normalize any previous open-menu state, then remember exact-text matches
    // that are already visible. Only a NEW match revealed by clicking the ATM
    // control can be an ATM option; this prevents a numeric preset such as 25
    // from ever matching quantity, ladder, or other order-ticket UI.
    await p.keyboard.press("Escape").catch(() => {});
    await p.waitForTimeout(100).catch(() => {});
    await this.markAtmVisibleBaseline();

    // Tradovate has several nearby controls (quantity, ATM, DAY/GTC). Anchor
    // to the exact visible ATM label and accept only a preset-bearing select /
    // combobox / dropdown control on that same row, never a generic icon.
    let control = await this.findAtmPresetControl();
    if (!control) {
      await this.snapshot("atm-dropdown-not-found", true);
      throw new Error(`Couldn't find the ATM dropdown to pick preset "${want}".`);
    }
    // Open the dropdown, tolerating a transient block: after several lanes close
    // and re-arm at once the screen churns, and an overlay or a still-settling
    // ticket can briefly intercept the click. Clear popups and retry once with a
    // generous timeout (this is arm time, off the Buy/Sell click path).
    try {
      await control.scrollIntoViewIfNeeded({ timeout: 2_000 }).catch(() => {});
      await control.click({ timeout: 6_000 });
    } catch {
      await this.dismissPopups().catch(() => false);
      await p.keyboard.press("Escape").catch(() => {});
      await p.waitForTimeout(150).catch(() => {});
      await this.markAtmVisibleBaseline();
      control = (await this.findAtmPresetControl()) ?? control;
      await control.scrollIntoViewIfNeeded({ timeout: 2_000 }).catch(() => {});
      // Force skips the "hold still / not covered" waits that a still-settling
      // ticket fails during simultaneous multi-lane arming — the click resolves
      // but never becomes actionable. We've already located the exact ATM
      // control, so firing a real press straight at it is safe here (arm time,
      // off the Buy/Sell path).
      await control.click({ force: true, timeout: 6_000 });
    }
    let option = await this.findOpenAtmOption(want);
    const deadline = Date.now() + 2_500;
    while (!option && Date.now() < deadline) {
      await p.waitForTimeout(75).catch(() => {});
      option = await this.findOpenAtmOption(want);
    }

    if (!option) {
      const seen = await this.dumpAtmOptions();
      await p.keyboard.press("Escape").catch(() => {});
      await this.snapshot("atm-preset-not-in-dropdown", true);
      const list = seen.length ? ` The dropdown showed: [${seen.join(", ")}].` : "";
      throw new Error(`ATM preset "${want}" wasn't in the dropdown.${list} Check the name matches exactly.`);
    }

    await option.scrollIntoViewIfNeeded({ timeout: 2_000 }).catch(() => {});
    try {
      await option.click({ timeout: 6_000 });
    } catch {
      // Same churn tolerance for picking the option out of the open list.
      await option.click({ force: true, timeout: 6_000 });
    }
    await p.waitForTimeout(200).catch(() => {});
    if (!(await this.atmPresetShown(want))) {
      await this.snapshot("atm-preset-not-applied", true);
      this.lastPreset = null;
      throw new Error(`ATM preset "${want}" didn't apply — bracket left unchanged so a wrong one can't fire.`);
    }
    this.lastPreset = want;
    log.info(`ATM preset selected: ${want}`);
  }

  /** Is `name` the currently-selected ATM preset shown in the panel? */
  private async atmPresetShown(name: string): Promise<boolean> {
    const control = await this.findAtmPresetControl();
    if (!control) return false;
    const shown = await control
      .evaluate((el) =>
        el instanceof HTMLSelectElement
          ? (el.selectedOptions[0]?.textContent ?? el.value)
          : (el.textContent ?? ""),
      )
      .catch(() => "");
    return shown.trim() === name.trim();
  }

  /** Locate the actual ATM preset control, not the quantity or DAY/GTC controls. */
  private async findAtmPresetControl(): Promise<Locator | null> {
    if (!this.page) return null;
    // Tradovate's ATM strategy selector carries a stable test id. Prefer it: a
    // self-re-resolving locator survives the order ticket re-mounting mid-arm
    // (the heuristic marker below can be lost when React re-renders the row).
    const byTestId = this.page.locator('[data-testid="atm-strategy-select"]').first();
    if (await byTestId.count().then((n) => n > 0).catch(() => false)) {
      return byTestId;
    }
    const marked = await this.page
      .evaluate(() => {
        const old = document.querySelectorAll("[data-bot-atm-preset-control]");
        for (let i = 0; i < old.length; i++) old[i]!.removeAttribute("data-bot-atm-preset-control");

        const all = document.querySelectorAll("*");
        let label: HTMLElement | null = null;
        for (let i = 0; i < all.length; i++) {
          const el = all[i] as HTMLElement;
          if ((el.textContent || "").trim() !== "ATM") continue;
          const r = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          if (r.width > 0 && r.height > 0 && style.display !== "none" && style.visibility !== "hidden") {
            label = el;
            break;
          }
        }
        if (!label) return false;

        const lr = label.getBoundingClientRect();
        const labelY = lr.top + lr.height / 2;
        const candidates = document.querySelectorAll(
          '[role="combobox"], select, button[aria-haspopup], [class*="dropdown" i], [class*="select" i]',
        );
        let best: HTMLElement | null = null;
        let bestDistance = Number.POSITIVE_INFINITY;
        for (let i = 0; i < candidates.length; i++) {
          const el = candidates[i] as HTMLElement;
          if (el === label || el.contains(label)) continue;
          const r = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          if (r.width <= 0 || r.height <= 0 || style.display === "none" || style.visibility === "hidden") continue;
          const text = (el.textContent || "").replace(/\s+/g, " ").trim();
          if (/Buy Mkt|Sell Mkt|Buy Bid|Sell Ask|Exit at Mkt/i.test(text)) continue;
          if (!(el instanceof HTMLSelectElement) && !/[A-Za-z0-9]/.test(text)) continue;
          const sameRow = Math.abs(r.top + r.height / 2 - labelY) <= Math.max(10, lr.height * 0.6);
          const distance = r.left - lr.right;
          if (!sameRow || distance < -8 || distance > 300) continue;
          if (distance < bestDistance) {
            best = el;
            bestDistance = distance;
          }
        }
        if (!best) return false;
        best.setAttribute("data-bot-atm-preset-control", "1");
        return true;
      })
      .catch(() => false);
    return marked ? this.page.locator("[data-bot-atm-preset-control]") : null;
  }

  /** Mark every visible element before the ATM popup opens. */
  private async markAtmVisibleBaseline(): Promise<void> {
    if (!this.page) return;
    await this.page.evaluate(() => {
      const all = document.querySelectorAll("body *");
      for (let i = 0; i < all.length; i++) {
        const el = all[i] as HTMLElement;
        el.removeAttribute("data-bot-atm-visible-before");
        el.removeAttribute("data-bot-atm-option");
        el.removeAttribute("data-bot-atm-popup-surface");
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        if (r.width > 0 && r.height > 0 && style.display !== "none" && style.visibility !== "hidden") {
          el.setAttribute("data-bot-atm-visible-before", "1");
        }
      }
    });
  }

  /**
   * Find the matching option in the OPEN ATM dropdown. Robust and simple: try
   * real listbox/menu semantics first (and the test fixture), then fall back to
   * plain geometry — a visible leaf whose EXACT text is the preset, sitting in
   * the ATM control's column just below it. No fragile "what became visible"
   * diffing, which is what kept missing a preset that was plainly in the list.
   */
  private async findOpenAtmOption(want: string): Promise<Locator | null> {
    if (!this.page) return null;
    for (const role of ["option", "menuitem"] as const) {
      const byRole = this.page.getByRole(role, { name: want, exact: true }).first();
      if (
        (await byRole.count().then((n) => n > 0).catch(() => false)) &&
        (await byRole.isVisible().catch(() => false))
      ) {
        return byRole;
      }
    }
    const marked = await this.page
      .evaluate((wanted) => {
        document.querySelectorAll("[data-bot-atm-option]").forEach((el) =>
          el.removeAttribute("data-bot-atm-option"),
        );
        const control = (document.querySelector('[data-testid="atm-strategy-select"]') ||
          document.querySelector("[data-bot-atm-preset-control]")) as HTMLElement | null;
        if (!control) return false;
        const cr = control.getBoundingClientRect();
        const cx = cr.left + cr.width / 2;
        let best: HTMLElement | null = null;
        let bestTop = Number.POSITIVE_INFINITY;
        const all = document.querySelectorAll("body *");
        for (let i = 0; i < all.length; i++) {
          const el = all[i] as HTMLElement;
          const tag = el.tagName.toLowerCase();
          if (tag === "input" || tag === "select" || tag === "textarea" || tag === "button") continue;
          if (control.contains(el) || el.contains(control)) continue;
          if ((el.textContent || "").replace(/\s+/g, " ").trim() !== wanted) continue;
          // Leaf only, so the click lands on the item, not an enclosing wrapper.
          const hasTextChild = Array.from(el.children).some(
            (c) => (c.textContent || "").replace(/\s+/g, " ").trim().length > 0,
          );
          if (hasTextChild) continue;
          const r = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          if (r.width <= 0 || r.height <= 0 || style.display === "none" || style.visibility === "hidden") continue;
          // In the ATM control's column (excludes a stray "25" in the price
          // ladder) and below it (the opened list drops down under the box).
          const sameColumn = cx >= r.left - 20 && cx <= r.right + 20;
          const below = r.top >= cr.top - 4 && r.top <= cr.bottom + 700;
          if (!sameColumn || !below) continue;
          if (r.top < bestTop) {
            best = el;
            bestTop = r.top;
          }
        }
        if (!best) return false;
        best.setAttribute("data-bot-atm-option", "1");
        return true;
      }, want)
      .catch(() => false);
    return marked ? this.page.locator("[data-bot-atm-option]") : null;
  }

  /** The visible option texts in the ATM column — for a helpful miss message. */
  private async dumpAtmOptions(): Promise<string[]> {
    if (!this.page) return [];
    return await this.page
      .evaluate(() => {
        const control = (document.querySelector('[data-testid="atm-strategy-select"]') ||
          document.querySelector("[data-bot-atm-preset-control]")) as HTMLElement | null;
        if (!control) return [];
        const cr = control.getBoundingClientRect();
        const cx = cr.left + cr.width / 2;
        const seen: string[] = [];
        const all = document.querySelectorAll("body *");
        for (let i = 0; i < all.length; i++) {
          const el = all[i] as HTMLElement;
          const text = (el.textContent || "").replace(/\s+/g, " ").trim();
          if (!text || text.length > 40) continue;
          const hasTextChild = Array.from(el.children).some(
            (c) => (c.textContent || "").replace(/\s+/g, " ").trim().length > 0,
          );
          if (hasTextChild) continue;
          const r = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          if (r.width <= 0 || r.height <= 0 || style.display === "none" || style.visibility === "hidden") continue;
          const sameColumn = cx >= r.left - 20 && cx <= r.right + 20;
          const below = r.top >= cr.top - 4 && r.top <= cr.bottom + 700;
          if (sameColumn && below && !seen.includes(text)) seen.push(text);
        }
        return seen.slice(0, 15);
      })
      .catch(() => []);
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
    this.shouldBeLoggedIn = false; // an explicit disconnect clears the "should be logged in" expectation
    this.currentAccount = null;
    this.ticketCapabilities = undefined;
  }
}
