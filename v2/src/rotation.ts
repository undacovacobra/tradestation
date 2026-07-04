import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Group, OrderRequest, StoredAccount } from "./types.js";

export interface OpenTrade {
  tradovateLabel: string;
  accountName: string;
  symbol: string;
  action: "buy" | "sell";
  tradeId?: string;
  openedAt: string;
}

export interface GroupState {
  /** Label of the account the NEXT trade should use (null = start of list). */
  nextLabel: string | null;
  /** The currently open round-trip, or null if flat. */
  openTrade: OpenTrade | null;
  history: Array<{
    accountName: string;
    tradovateLabel: string;
    symbol: string;
    action: string;
    openedAt: string;
    closedAt: string;
  }>;
}

const emptyState = (): GroupState => ({ nextLabel: null, openTrade: null, history: [] });

/**
 * The account-cycling logic for ONE group (evals or funded): open exactly one
 * round-trip at a time, then advance to the next account. Keyed by account
 * LABEL (not array index) so it survives add / remove / reorder mid-rotation.
 * Deliberately simple: no balances, no daily rules — just the cycle.
 */
export class GroupRotation {
  private state: GroupState;

  constructor(
    readonly group: Group,
    private readonly statePath: string,
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

  /** Decide which account takes the next entry, or explain why none can. */
  selectAccountForEntry(accounts: StoredAccount[]): { account: StoredAccount } | { error: string } {
    if (this.state.openTrade) {
      const t = this.state.openTrade;
      return { error: `A trade is already open on ${t.accountName} (${t.symbol}). It must close first.` };
    }
    if (accounts.length === 0) {
      return { error: "This group has no accounts turned on. Add or enable accounts on the dashboard." };
    }
    const idx = accounts.findIndex((a) => a.tradovateLabel === this.state.nextLabel);
    return { account: accounts[idx === -1 ? 0 : idx]! };
  }

  /** Manually choose which account takes the next entry (only when flat). */
  setNext(label: string, accounts: StoredAccount[]): boolean {
    if (this.state.openTrade) return false;
    if (!accounts.some((a) => a.tradovateLabel === label)) return false;
    this.state.nextLabel = label;
    this.save();
    return true;
  }

  /** Record that an entry was placed on the given account. */
  recordOpen(account: StoredAccount, order: OrderRequest): OpenTrade {
    const open: OpenTrade = {
      tradovateLabel: account.tradovateLabel,
      accountName: account.name,
      symbol: order.symbol,
      action: order.action,
      tradeId: order.tradeId,
      openedAt: new Date().toISOString(),
    };
    this.state.openTrade = open;
    this.state.nextLabel = account.tradovateLabel;
    this.save();
    return open;
  }

  /**
   * Record that the open round-trip closed, then advance to the account AFTER
   * the one just traded. Returns the closed trade and the next account.
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
    if (this.state.history.length > 500) this.state.history.splice(0, this.state.history.length - 500);
    this.state.openTrade = null;

    let next: StoredAccount | null = null;
    if (accounts.length > 0) {
      const idx = accounts.findIndex((a) => a.tradovateLabel === closed.tradovateLabel);
      next = accounts[(idx + 1) % accounts.length]!;
    }
    this.state.nextLabel = next?.tradovateLabel ?? null;
    this.save();
    return { closed, next };
  }

  /** How many round-trips this group closed today (UTC), for display only. */
  tradesToday(): number {
    const today = new Date().toISOString().slice(0, 10);
    return this.state.history.filter((h) => h.closedAt.slice(0, 10) === today).length;
  }
}
