import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AccountDefinition, OpenPoolTrade, PoolState, V4Alert } from "./models.js";

const emptyState = (): PoolState => ({ nextAccountId: null, openTrade: null, lastWonDay: {}, history: [] });

export class PoolRotation {
  private state: PoolState;

  constructor(
    readonly poolId: string,
    private readonly statePath: string,
    private readonly benchWinnersForDay: boolean,
    private readonly today: () => string,
  ) {
    this.state = this.load();
  }

  private load(): PoolState {
    if (!existsSync(this.statePath)) return emptyState();
    try { return { ...emptyState(), ...JSON.parse(readFileSync(this.statePath, "utf8")) }; }
    catch { return emptyState(); }
  }

  private save(): void {
    mkdirSync(dirname(this.statePath), { recursive: true });
    const tmp = `${this.statePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    renameSync(tmp, this.statePath);
  }

  snapshot(): PoolState { return structuredClone(this.state); }
  get isFlat(): boolean { return this.state.openTrade === null; }

  setNext(accountId: string, accounts: AccountDefinition[]): void {
    if (this.state.openTrade) throw new Error(`Pool ${this.poolId} has an open trade`);
    if (!accounts.some((account) => account.id === accountId)) throw new Error(`Account ${accountId} is not active in pool ${this.poolId}`);
    this.state.nextAccountId = accountId;
    this.save();
  }

  select(accounts: AccountDefinition[], lockedAccountIds: Set<string>): AccountDefinition {
    if (this.state.openTrade) throw new Error(`Pool ${this.poolId} already has an open trade on ${this.state.openTrade.accountName}`);
    if (!accounts.length) throw new Error(`Pool ${this.poolId} has no enabled active accounts`);
    const start = Math.max(0, accounts.findIndex((a) => a.id === this.state.nextAccountId));
    for (let step = 0; step < accounts.length; step++) {
      const account = accounts[(start + step) % accounts.length]!;
      if (lockedAccountIds.has(account.id)) continue;
      if (this.benchWinnersForDay && this.state.lastWonDay[account.id] === this.today()) continue;
      return account;
    }
    throw new Error(`Pool ${this.poolId} has no available accounts; every account is busy, held, or benched`);
  }

  recordOpen(account: AccountDefinition, alert: V4Alert, simulated: boolean, entryBalance?: number): OpenPoolTrade {
    const open: OpenPoolTrade = {
      accountId: account.id,
      accountName: account.name,
      connectionId: account.connectionId,
      platformLabel: account.platformLabel,
      symbol: alert.symbol,
      action: alert.action as "buy" | "sell",
      quantity: alert.quantity,
      signalId: alert.signalId ?? alert.tradeId,
      openedAt: new Date().toISOString(),
      simulated,
      entryBalance,
    };
    this.state.openTrade = open;
    this.state.nextAccountId = account.id;
    this.save();
    return open;
  }

  recordClose(accounts: AccountDefinition[], won?: boolean): OpenPoolTrade {
    const open = this.state.openTrade;
    if (!open) throw new Error(`Pool ${this.poolId} has no open trade`);
    this.state.history.push({ ...open, closedAt: new Date().toISOString(), won });
    if (this.state.history.length > 1_000) this.state.history.splice(0, this.state.history.length - 1_000);
    if (won) this.state.lastWonDay[open.accountId] = this.today();
    const index = accounts.findIndex((a) => a.id === open.accountId);
    this.state.nextAccountId = accounts.length ? accounts[(Math.max(0, index) + 1) % accounts.length]!.id : null;
    this.state.openTrade = null;
    this.save();
    return open;
  }
}
