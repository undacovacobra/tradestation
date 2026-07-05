import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Group, OrderRequest, StoredAccount } from "./types.js";
import { tradingDayKey } from "./tradingDay.js";

export interface OpenTrade {
  tradovateLabel: string;
  accountName: string;
  symbol: string;
  action: "buy" | "sell";
  tradeId?: string;
  /** Contracts traded on this entry (from the alert), if the alert carried one. */
  quantity?: number;
  openedAt: string;
  /** Account balance read at arm time (before entry), to judge win/loss. */
  entryBalance?: number;
}

export interface TradeRecord {
  accountName: string;
  tradovateLabel: string;
  symbol: string;
  action: string;
  quantity?: number;
  openedAt: string;
  closedAt: string;
  won?: boolean;
  pnl?: number;
  exitBalance?: number;
}

export interface GroupState {
  nextLabel: string | null;
  openTrade: OpenTrade | null;
  /** tradovateLabel -> trading-day (YYYY-MM-DD) it last closed a WINNER. */
  lastWonDay: Record<string, string>;
  history: TradeRecord[];
}

const emptyState = (): GroupState => ({ nextLabel: null, openTrade: null, lastWonDay: {}, history: [] });

/**
 * Account-cycling for ONE group: one round-trip at a time, advance to the next.
 * Keyed by account LABEL so it survives add/remove/reorder. When
 * `benchWinnersForDay` is on, an account that closes a WINNER sits out the rest
 * of the (futures) trading day; losers/breakeven keep cycling.
 */
export class GroupRotation {
  private state: GroupState;

  constructor(
    readonly group: Group,
    private readonly statePath: string,
    private readonly benchWinnersForDay: boolean,
    /** Trading-day label for an instant (defaults to now). Injectable for tests. */
    private readonly today: (at?: Date) => string = defaultToday,
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

  /** True when this account won a trade earlier today and is benched for the day. */
  isBenchedToday(label: string): boolean {
    return this.benchWinnersForDay && this.state.lastWonDay[label] === this.today();
  }

  peekNext(accounts: StoredAccount[]): StoredAccount | null {
    const choice = this.selectAccountForEntry(accounts);
    return "error" in choice ? null : choice.account;
  }

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
      if (this.isBenchedToday(acct.tradovateLabel)) continue;
      return { account: acct };
    }
    return { error: "Every account here already won a trade today, so they're all resting until tomorrow." };
  }

  /** Manually choose which account takes the next entry (only when flat). */
  setNext(label: string, accounts: StoredAccount[]): boolean {
    if (this.state.openTrade) return false;
    if (!accounts.some((a) => a.tradovateLabel === label)) return false;
    this.state.nextLabel = label;
    this.save();
    return true;
  }

  recordOpen(account: StoredAccount, order: OrderRequest, entryBalance?: number): OpenTrade {
    const open: OpenTrade = {
      tradovateLabel: account.tradovateLabel,
      accountName: account.name,
      symbol: order.symbol,
      action: order.action,
      tradeId: order.tradeId,
      quantity: order.quantity,
      openedAt: new Date().toISOString(),
      entryBalance,
    };
    this.state.openTrade = open;
    this.state.nextLabel = account.tradovateLabel;
    this.save();
    return open;
  }

  /**
   * Record the close and advance. If the trade won (explicit `won`, or
   * exitBalance above the recorded entry balance) the account is benched for the
   * rest of the trading day. Returns the closed trade, whether it won, and the
   * next account.
   */
  recordClose(
    accounts: StoredAccount[],
    opts: { won?: boolean; exitBalance?: number } = {},
  ): { closed: OpenTrade; next: StoredAccount | null; won: boolean; pnl?: number } {
    const closed = this.state.openTrade;
    if (!closed) throw new Error("recordClose called with no open trade");

    let pnl: number | undefined;
    if (closed.entryBalance != null && opts.exitBalance != null) {
      pnl = Math.round((opts.exitBalance - closed.entryBalance) * 100) / 100;
    }
    const won = opts.won === true || (pnl != null && pnl > 0);

    this.state.history.push({
      accountName: closed.accountName,
      tradovateLabel: closed.tradovateLabel,
      symbol: closed.symbol,
      action: closed.action,
      quantity: closed.quantity,
      openedAt: closed.openedAt,
      closedAt: new Date().toISOString(),
      won,
      pnl,
      exitBalance: opts.exitBalance,
    });
    if (this.state.history.length > 500) this.state.history.splice(0, this.state.history.length - 500);
    if (won) this.state.lastWonDay[closed.tradovateLabel] = this.today();
    this.state.openTrade = null;

    let next: StoredAccount | null = null;
    if (accounts.length > 0) {
      const idx = accounts.findIndex((a) => a.tradovateLabel === closed.tradovateLabel);
      next = accounts[(idx + 1) % accounts.length]!;
    }
    this.state.nextLabel = next?.tradovateLabel ?? null;
    this.save();
    return { closed, next, won, pnl };
  }

  tradesToday(): number {
    const today = this.today();
    return this.state.history.filter((h) => this.today(new Date(h.closedAt)) === today).length;
  }

  /** Today's finished round-trips, newest first — for the dashboard trade log. */
  todaysHistory(): TradeRecord[] {
    const today = this.today();
    return this.state.history.filter((h) => this.today(new Date(h.closedAt)) === today).reverse();
  }
}

/** Fallback trading day: 6pm US/Eastern reset (server injects the configured one). */
function defaultToday(at: Date = new Date()): string {
  return tradingDayKey(at, "America/New_York", 18);
}
