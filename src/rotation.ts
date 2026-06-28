import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AccountSpec, OrderRequest } from "./types.js";

export interface OpenTrade {
  accountIndex: number;
  accountName: string;
  tradovateLabel: string;
  symbol: string;
  action: "buy" | "sell";
  tradeId?: string;
  openedAt: string;
}

export interface RotationState {
  /** Index into the accounts array that the NEXT trade will use. */
  currentIndex: number;
  /** The currently open round-trip, or null if flat. */
  openTrade: OpenTrade | null;
  /** Map of tradovateLabel -> last calendar day (YYYY-MM-DD) it was traded. */
  lastTradedDay: Record<string, string>;
  history: Array<{
    accountName: string;
    tradovateLabel: string;
    symbol: string;
    action: string;
    openedAt: string;
    closedAt: string;
  }>;
}

const emptyState = (): RotationState => ({
  currentIndex: 0,
  openTrade: null,
  lastTradedDay: {},
  history: [],
});

/**
 * Owns the account-cycling logic: pick today's account, open exactly one
 * round-trip at a time, and advance to the next account when it closes.
 *
 * Pure-ish and persisted to a JSON file so the rotation survives restarts.
 */
export class AccountRotation {
  private state: RotationState;

  constructor(
    private readonly accounts: AccountSpec[],
    private readonly statePath: string,
    private readonly oncePerDay: boolean,
    /** Injectable clock for tests. Returns YYYY-MM-DD for "today". */
    private readonly today: () => string = defaultToday,
  ) {
    if (accounts.length === 0) throw new Error("AccountRotation needs at least one account");
    this.state = this.load();
    // Keep currentIndex in range if the account list shrank.
    this.state.currentIndex %= this.accounts.length;
  }

  private load(): RotationState {
    if (!existsSync(this.statePath)) return emptyState();
    try {
      return { ...emptyState(), ...JSON.parse(readFileSync(this.statePath, "utf8")) };
    } catch {
      return emptyState();
    }
  }

  private save(): void {
    mkdirSync(dirname(this.statePath), { recursive: true });
    writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
  }

  getState(): Readonly<RotationState> {
    return this.state;
  }

  get isFlat(): boolean {
    return this.state.openTrade === null;
  }

  /**
   * Decide which account should take the next entry, or explain why none can.
   * Skips accounts already traded today when oncePerDay is on, scanning at most
   * one full loop so we never spin forever.
   */
  selectAccountForEntry(): { account: AccountSpec; index: number } | { error: string } {
    if (this.state.openTrade) {
      const t = this.state.openTrade;
      return { error: `A trade is already open on ${t.accountName} (${t.symbol}). Close it first.` };
    }

    const n = this.accounts.length;
    for (let step = 0; step < n; step++) {
      const idx = (this.state.currentIndex + step) % n;
      const acct = this.accounts[idx]!;
      if (this.oncePerDay && this.state.lastTradedDay[acct.tradovateLabel] === this.today()) {
        continue;
      }
      return { account: acct, index: idx };
    }
    return { error: "Every account has already been traded today (oncePerDay is on)." };
  }

  /** Record that an entry was placed on the given account. */
  recordOpen(index: number, order: OrderRequest): OpenTrade {
    const acct = this.accounts[index]!;
    const open: OpenTrade = {
      accountIndex: index,
      accountName: acct.name,
      tradovateLabel: acct.tradovateLabel,
      symbol: order.symbol,
      action: order.action,
      tradeId: order.tradeId,
      openedAt: new Date().toISOString(),
    };
    this.state.openTrade = open;
    this.state.currentIndex = index;
    this.state.lastTradedDay[acct.tradovateLabel] = this.today();
    this.save();
    return open;
  }

  /**
   * Record that the open round-trip closed, then advance to the next account.
   * Returns the account that will take the next entry.
   */
  recordClose(): { closed: OpenTrade; next: AccountSpec } {
    const closed = this.state.openTrade;
    if (!closed) throw new Error("recordClose called with no open trade");

    this.state.history.push({
      accountName: closed.accountName,
      tradovateLabel: closed.tradovateLabel,
      symbol: closed.symbol,
      action: closed.action,
      openedAt: closed.openedAt,
      closedAt: new Date().toISOString(),
    });
    this.state.openTrade = null;
    this.state.currentIndex = (closed.accountIndex + 1) % this.accounts.length;
    this.save();
    return { closed, next: this.accounts[this.state.currentIndex]! };
  }
}

function defaultToday(): string {
  // NOTE: uses UTC calendar date. Futures "trading day" resets ~17:00 CT, so if
  // your strategy trades across that boundary you'll want a CT-aware day here.
  return new Date().toISOString().slice(0, 10);
}
