import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AccountBalance, Group } from "./types.js";
import type { SettingsStore } from "./store.js";
import type { GroupRotation } from "./rotation.js";
import { pushEvent } from "./events.js";
import { log } from "./logger.js";

/**
 * The account monitor: on a fixed interval it reads the Tradovate account
 * menu ONCE (one menu-open gives every account id + balance) and uses that
 * single read for three jobs:
 *
 *  1. Keep a balance + history record per account (drives the dashboard's
 *     balance display, mini P&L chart, and "$ to go" figure).
 *  2. Auto-add accounts that appeared in Tradovate but aren't in the bot yet
 *     (LFE… -> evals, LFF… -> funded).
 *  3. Enforce the eval profit target: an eval at/above the target is retired
 *     ("passed"), and if it's the one holding the open trade, that trade is
 *     flattened immediately without waiting for a webhook.
 *
 * The interval only does real work while the Tradovate browser is connected
 * and logged in — it can't read numbers off a screen that isn't there.
 */

export interface BalancePoint {
  t: string; // ISO time
  b: number; // dollars
}

export interface BalanceRecord {
  balance: number;
  updatedAt: string;
  history: BalancePoint[];
}

export interface MonitorDeps {
  store: SettingsStore;
  rotations: Record<Group, GroupRotation>;
  /** Is the browser connected + logged in right now? */
  isBrowserReady: () => boolean;
  /** Read the account menu (already serialized with trades by the caller). */
  readBalances: () => Promise<AccountBalance[]>;
  /** Flatten the group's open trade and advance the rotation. */
  forceClose: (group: Group, reason: string) => Promise<void>;
  balancesPath: string;
  /** Relaxed cadence (seconds) when no trade is open. */
  intervalSeconds: number;
  /** Fast cadence (seconds) while any trade is open. */
  activeIntervalSeconds: number;
}

const HISTORY_MAX = 288; // at one point/5min that's ~24h of chart
const HISTORY_MIN_GAP_MS = 5 * 60 * 1000;

export class Monitor {
  private balances: Record<string, BalanceRecord> = {};
  private sweeping = false;
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private warnedNoBalances = false;

  constructor(private readonly deps: MonitorDeps) {
    this.balances = this.load();
  }

  private load(): Record<string, BalanceRecord> {
    if (!existsSync(this.deps.balancesPath)) return {};
    try {
      return JSON.parse(readFileSync(this.deps.balancesPath, "utf8"));
    } catch {
      return {};
    }
  }

  private save(): void {
    mkdirSync(dirname(this.deps.balancesPath), { recursive: true });
    writeFileSync(this.deps.balancesPath, JSON.stringify(this.balances, null, 2));
  }

  balanceOf(label: string): number | null {
    return this.balances[label]?.balance ?? null;
  }

  /** Everything the dashboard needs, keyed by account label. */
  snapshot(): Record<string, { balance: number; updatedAt: string; history: BalancePoint[] }> {
    const out: Record<string, { balance: number; updatedAt: string; history: BalancePoint[] }> = {};
    for (const [label, rec] of Object.entries(this.balances)) {
      out[label] = { balance: rec.balance, updatedAt: rec.updatedAt, history: rec.history.slice(-60) };
    }
    return out;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    // First sweep shortly after boot so the dashboard fills in fast, then the
    // loop re-schedules itself at a cadence that depends on whether a trade is
    // open (fast) or not (relaxed).
    this.timer = setTimeout(() => void this.tick(), 5_000);
    log.info(
      `Account monitor started (every ${this.deps.intervalSeconds}s idle, every ${this.deps.activeIntervalSeconds}s while a trade is open, when logged in).`,
    );
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** True when either lane is holding an open trade right now. */
  private anyTradeOpen(): boolean {
    return Object.values(this.deps.rotations).some((r) => !r.isFlat);
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    await this.sweep();
    if (!this.running) return;
    // Watch the live account every few seconds; relax when nothing is open.
    const seconds = this.anyTradeOpen() ? this.deps.activeIntervalSeconds : this.deps.intervalSeconds;
    this.timer = setTimeout(() => void this.tick(), seconds * 1000);
  }

  /** One full pass: read the menu, then apply the three jobs. */
  async sweep(): Promise<void> {
    if (this.sweeping || !this.deps.isBrowserReady()) return;
    this.sweeping = true;
    try {
      const rows = await this.deps.readBalances();
      await this.applyRows(rows);
    } catch (err) {
      log.warn(`Balance sweep failed: ${(err as Error).message}`);
    } finally {
      this.sweeping = false;
    }
  }

  /**
   * Record balances + history from a menu read, and warn once if we can see
   * accounts but no dollar amounts. Used by both the periodic sweep and the
   * "Scan Tradovate accounts" button (so balances fill in the moment you scan).
   */
  recordBalances(rows: AccountBalance[]): void {
    const now = new Date().toISOString();
    let sawDollars = false;
    for (const { label, balance } of rows) {
      if (balance === null) continue;
      sawDollars = true;
      const rec = this.balances[label];
      if (!rec) {
        this.balances[label] = { balance, updatedAt: now, history: [{ t: now, b: balance }] };
        continue;
      }
      rec.balance = balance;
      rec.updatedAt = now;
      const last = rec.history[rec.history.length - 1];
      const gapOk = !last || Date.now() - new Date(last.t).getTime() >= HISTORY_MIN_GAP_MS;
      if (!last || Math.abs(balance - last.b) >= 1 || gapOk) {
        rec.history.push({ t: now, b: balance });
        if (rec.history.length > HISTORY_MAX) rec.history.splice(0, rec.history.length - HISTORY_MAX);
      }
    }
    if (rows.length > 0 && !sawDollars && !this.warnedNoBalances) {
      this.warnedNoBalances = true;
      pushEvent(
        "warn",
        "I can see the accounts in Tradovate but no dollar amounts next to them, so balances (and the auto-stop at the target) can't work yet. A screenshot of the open account menu will let us fix this.",
      );
    }
  }

  /** Record balances from a manual scan and persist right away. */
  scanIngest(rows: AccountBalance[]): void {
    this.recordBalances(rows);
    this.save();
  }

  /** Split from sweep() so tests can feed fake menu rows without a browser. */
  async applyRows(rows: AccountBalance[]): Promise<void> {
    const { store, rotations, forceClose } = this.deps;

    // (1) Record balances + history.
    this.recordBalances(rows);

    // (2) Auto-add accounts that are new in Tradovate.
    for (const { label } of rows) {
      if (store.find(label)) continue;
      const group: Group = label.startsWith("LFF") ? "funded" : "evals";
      store.upsertAccount(label, group);
      pushEvent("info", `New account spotted in Tradovate: ${label} — added to ${group} automatically.`, group);
    }

    // (3) Enforce the eval target.
    const target = store.evalTarget;
    for (const acct of [...store.accounts]) {
      if (acct.group !== "evals" || acct.status !== "active") continue;
      const bal = this.balanceOf(acct.tradovateLabel);
      if (bal === null || bal < target) continue;

      pushEvent(
        "trade",
        `🏆 ${acct.name} reached $${bal.toLocaleString()} — that's at/above the $${target.toLocaleString()} target!`,
        "evals",
      );
      const open = rotations.evals.getState().openTrade;
      if (open && open.tradovateLabel === acct.tradovateLabel) {
        await forceClose("evals", `${acct.name} hit the $${target.toLocaleString()} target.`);
      }
      store.markPassed(acct.tradovateLabel);
      pushEvent("info", `${acct.name} moved to the Passed column — it will not be traded anymore.`, "evals");
    }

    this.save();
  }
}
