import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Group, OrderRequest, StoredAccount } from "./types.js";

export interface OpenTrade {
  tradovateLabel: string;
  accountName: string;
  symbol: string;
  action: "buy" | "sell";
  /** Contracts the ALERT asked for (actual size is whatever is set on Tradovate). */
  quantity?: number;
  tradeId?: string;
  openedAt: string;
}

export interface GroupState {
  /** Label of the account the NEXT trade should use (null = start of list). */
  nextLabel: string | null;
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

const emptyState = (): GroupState => ({
  nextLabel: null,
  openTrade: null,
  lastTradedDay: {},
  history: [],
});

/**
 * The account-cycling logic for ONE group (evals or funded): open exactly one
 * round-trip at a time, advance to the next account when it closes.
 *
 * Unlike V1 this is keyed by account LABEL, not array index, because the
 * dashboard lets the user add / remove / reorder accounts while the bot runs.
 * The current account list is passed into each call.
 */
export class GroupRotation {
  private state: GroupState;

  constructor(
    readonly group: Group,
    private readonly statePath: string,
    private readonly oncePerDay: boolean,
    /** Injectable clock for tests. Returns YYYY-MM-DD for "today". */
    private readonly today: () => string = defaultToday,
  ) {
    this.state = this.load();
  }

  private load(): GroupState {
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

  getState(): Readonly<GroupState> {
    return this.state;
  }

  get isFlat(): boolean {
    return this.state.openTrade === null;
  }

  /** The account the next entry would use, given the current list (for display). */
  peekNext(accounts: StoredAccount[]): StoredAccount | null {
    const choice = this.selectAccountForEntry(accounts);
    return "error" in choice ? null : choice.account;
  }

  /**
   * Decide which account should take the next entry, or explain why none can.
   * Starts at the remembered next account (falling back to the top of the list
   * if it was removed), skips accounts already traded today when oncePerDay is
   * on, and scans at most one full loop.
   */
  selectAccountForEntry(accounts: StoredAccount[]): { account: StoredAccount } | { error: string } {
    if (this.state.openTrade) {
      const t = this.state.openTrade;
      return { error: `A trade is already open on ${t.accountName} (${t.symbol}). It must close first.` };
    }
    const n = accounts.length;
    if (n === 0) {
      return { error: "This group has no accounts turned on. Add or enable accounts on the dashboard." };
    }
    const startIdx = Math.max(
      0,
      accounts.findIndex((a) => a.tradovateLabel === this.state.nextLabel),
    );
    for (let step = 0; step < n; step++) {
      const acct = accounts[(startIdx + step) % n]!;
      if (this.oncePerDay && this.state.lastTradedDay[acct.tradovateLabel] === this.today()) {
        continue;
      }
      return { account: acct };
    }
    return { error: "Every account in this group has already traded today (once-per-day is on)." };
  }

  /** Record that an entry was placed on the given account. */
  recordOpen(account: StoredAccount, order: OrderRequest): OpenTrade {
    const open: OpenTrade = {
      tradovateLabel: account.tradovateLabel,
      accountName: account.name,
      symbol: order.symbol,
      action: order.action,
      quantity: order.quantity,
      tradeId: order.tradeId,
      openedAt: new Date().toISOString(),
    };
    this.state.openTrade = open;
    this.state.nextLabel = account.tradovateLabel;
    this.state.lastTradedDay[account.tradovateLabel] = this.today();
    this.save();
    return open;
  }

  /**
   * Record that the open round-trip closed, then advance to the account AFTER
   * the one just traded (in the current list order). Returns the closed trade
   * and the account that will take the next entry (null if the list is empty).
   */
  recordClose(accounts: StoredAccount[]): { closed: OpenTrade; next: StoredAccount | null } {
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
    if (this.state.history.length > 500) {
      this.state.history.splice(0, this.state.history.length - 500);
    }
    this.state.openTrade = null;

    let next: StoredAccount | null = null;
    if (accounts.length > 0) {
      const idx = accounts.findIndex((a) => a.tradovateLabel === closed.tradovateLabel);
      // If the traded account was removed mid-trade, idx is -1 and (−1+1)%n = 0:
      // we simply restart from the top of the list.
      next = accounts[(idx + 1) % accounts.length]!;
    }
    this.state.nextLabel = next?.tradovateLabel ?? null;
    this.save();
    return { closed, next };
  }

  /** How many round-trips this group closed today. */
  tradesToday(): number {
    const today = this.today();
    return this.state.history.filter((h) => h.closedAt.slice(0, 10) === today).length;
  }
}

function defaultToday(): string {
  // NOTE: uses UTC calendar date. Futures "trading day" resets ~17:00 CT, so if
  // your strategy trades across that boundary you'll want a CT-aware day here.
  return new Date().toISOString().slice(0, 10);
}
