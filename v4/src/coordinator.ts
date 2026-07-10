import { resolve } from "node:path";
import type { AccountDefinition, TradeResult, V4Alert } from "./models.js";
import { isCloseAlert } from "./models.js";
import { PoolRotation } from "./poolRotation.js";
import type { Registry } from "./registry.js";
import type { ConnectionWorker } from "./workers.js";
import type { BalanceLog } from "./balances.js";

export class TradeCoordinator {
  private readonly rotations = new Map<string, PoolRotation>();
  private readonly poolQueues = new Map<string, Promise<unknown>>();
  private readonly recentSignals = new Map<string, number>();
  private readonly reservedAccounts = new Map<string, string>();
  private readonly reservedLanes = new Map<string, string>();
  private readonly targetChecks = new Set<string>();

  constructor(
    private readonly registry: Registry,
    private readonly workers: { get(id: string): ConnectionWorker | undefined },
    stateDir: string,
    today: () => string,
    private readonly balances?: BalanceLog,
  ) {
    for (const pool of registry.pools()) {
      this.rotations.set(pool.id, new PoolRotation(pool.id, resolve(stateDir, `${pool.id}.json`), pool.benchWinnersForDay, today));
    }
  }

  status() {
    const balanceSnapshot = this.balances?.snapshot() ?? {};
    return this.registry.pools().map((pool) => {
      const rotation = this.rotations.get(pool.id);
      const state = rotation?.snapshot();
      let nextAccountId: string | null = state?.openTrade?.accountId ?? null;
      if (!state?.openTrade && rotation) {
        try { nextAccountId = rotation.select(this.registry.accountsInPool(pool.id), this.lockedAccounts(pool.id)).id; }
        catch { nextAccountId = null; }
      }
      return {
        ...pool,
        executionLane: pool.executionLane ?? pool.id,
        state: state ? { ...state, nextAccountId } : undefined,
        accounts: pool.accountIds.map((id) => this.registry.account(id)).filter((account): account is AccountDefinition => Boolean(account)).map((account) => {
          const record = balanceSnapshot[account.id];
          return {
            ...account,
            balance: record?.balance ?? null,
            balanceUpdatedAt: record?.updatedAt ?? null,
            balanceHistory: record?.history ?? [],
            isNext: nextAccountId === account.id,
            toTarget: pool.balanceTarget && record ? Math.max(0, pool.balanceTarget - record.balance) : null,
          };
        }),
      };
    });
  }

  private enqueuePool<T>(poolId: string, task: () => Promise<T>): Promise<T> {
    const prior = this.poolQueues.get(poolId) ?? Promise.resolve();
    const result = prior.then(task, task);
    this.poolQueues.set(poolId, result.catch(() => undefined));
    return result;
  }

  private duplicateKey(poolId: string, alert: V4Alert): string | null {
    const id = alert.signalId ?? alert.tradeId;
    if (!id) return null;
    return `${poolId}:${id}:${alert.action}:${alert.marketPosition ?? ""}`;
  }

  private lockedAccounts(exceptPoolId: string): Set<string> {
    const locked = new Set<string>([...this.reservedAccounts].filter(([, poolId]) => poolId !== exceptPoolId).map(([accountId]) => accountId));
    for (const [poolId, rotation] of this.rotations) {
      if (poolId === exceptPoolId) continue;
      const id = rotation.snapshot().openTrade?.accountId;
      if (id) locked.add(id);
    }
    return locked;
  }

  private executionLane(poolId: string): string {
    return this.registry.pool(poolId)?.executionLane ?? poolId;
  }

  private laneOwner(lane: string, exceptPoolId: string): string | undefined {
    const reservedBy = this.reservedLanes.get(lane);
    if (reservedBy && reservedBy !== exceptPoolId) return reservedBy;
    for (const [poolId, rotation] of this.rotations) {
      if (poolId !== exceptPoolId && this.executionLane(poolId) === lane && rotation.snapshot().openTrade) return poolId;
    }
    return undefined;
  }

  async handle(poolId: string, alert: V4Alert): Promise<TradeResult> {
    return this.enqueuePool(poolId, async () => {
      if (!this.registry.running) throw new Error("V4 is paused");
      const pool = this.registry.pool(poolId);
      if (!pool?.enabled) throw new Error(`Unknown or disabled pool: ${poolId}`);
      const rotation = this.rotations.get(poolId);
      if (!rotation) throw new Error(`Pool ${poolId} was added after startup; restart V4 to activate it`);

      const duplicateKey = this.duplicateKey(poolId, alert);
      const now = Date.now();
      for (const [key, at] of this.recentSignals) if (now - at > 86_400_000) this.recentSignals.delete(key);
      if (duplicateKey && this.recentSignals.has(duplicateKey)) {
        return { ok: true, poolId, message: "Duplicate signal ignored", simulated: true };
      }

      if (isCloseAlert(alert)) return this.close(poolId, alert, rotation);
      if (alert.action !== "buy" && alert.action !== "sell") throw new Error(`Unsupported entry action: ${alert.action}`);

      const lane = this.executionLane(poolId);
      const laneOwner = this.laneOwner(lane, poolId);
      if (laneOwner) throw new Error(`Execution lane ${lane} is already in use by pool ${laneOwner}`);

      const accounts = this.registry.accountsInPool(poolId);
      const account = rotation.select(accounts, this.lockedAccounts(poolId));
      const worker = this.workers.get(account.connectionId);
      if (!worker) throw new Error(`No worker for connection ${account.connectionId}`);
      const simulated = alert.test || this.registry.mode === "practice";

      if (alert.test) {
        return {
          ok: true,
          poolId,
          accountId: account.id,
          connectionId: account.connectionId,
          simulated: true,
          message: `TEST ONLY — would ${alert.action} ${alert.symbol} on ${account.name} via ${worker.definition.name}; no state or broker was changed`,
        };
      }

      this.reservedAccounts.set(account.id, poolId);
      this.reservedLanes.set(lane, poolId);
      let entryBalance: number | null = null;
      try {
        if (!simulated) {
          const status = worker.status();
          if (!status.connected || !status.loggedIn) throw new Error(`${worker.definition.name} is not connected and logged in`);
          await worker.run(async (adapter) => {
            entryBalance = await adapter.readBalance(account);
            await adapter.enter(account, alert);
          });
          if (entryBalance != null) this.balances?.set(account.id, entryBalance);
        }
        rotation.recordOpen(account, alert, simulated, entryBalance ?? undefined);
      } finally {
        this.reservedAccounts.delete(account.id);
        this.reservedLanes.delete(lane);
      }
      if (duplicateKey) this.recentSignals.set(duplicateKey, now);
      return {
        ok: true,
        poolId,
        accountId: account.id,
        connectionId: account.connectionId,
        simulated,
        message: `${simulated ? "Planned" : "Opened"} ${alert.action} ${alert.symbol} on ${account.name} via ${worker.definition.name}`,
      };
    });
  }

  private async close(poolId: string, alert: V4Alert, rotation: PoolRotation): Promise<TradeResult> {
    const open = rotation.snapshot().openTrade;
    if (!open) return { ok: true, poolId, message: "Close ignored: pool is already flat", simulated: true };
    const account = this.registry.account(open.accountId);
    if (!account) throw new Error(`Open trade references missing account ${open.accountId}`);
    const worker = this.workers.get(open.connectionId);
    if (!worker) throw new Error(`No worker for connection ${open.connectionId}`);
    const simulated = alert.test || open.simulated || this.registry.mode === "practice";
    if (alert.test) {
      return {
        ok: true,
        poolId,
        accountId: account.id,
        connectionId: account.connectionId,
        simulated: true,
        message: `TEST ONLY — would close ${open.symbol} on ${account.name}; no state or broker was changed`,
      };
    }
    let exitBalance: number | null = null;
    if (!simulated) {
      const status = worker.status();
      if (!status.connected || !status.loggedIn) throw new Error(`${worker.definition.name} is not connected; the open trade was not touched`);
      await worker.run(async (adapter) => {
        await adapter.close(account);
        exitBalance = await adapter.readSettledBalance(account);
      });
      if (exitBalance != null) this.balances?.set(account.id, exitBalance);
    }
    const won = exitBalance != null && open.entryBalance != null ? exitBalance > open.entryBalance : undefined;
    rotation.recordClose(this.registry.accountsInPool(poolId), won);
    return {
      ok: true,
      poolId,
      accountId: account.id,
      connectionId: account.connectionId,
      simulated,
      message: `${simulated ? "Planned close of" : "Closed"} ${alert.symbol} on ${account.name}`,
    };
  }

  async handleMany(poolIds: string[], alert: V4Alert): Promise<TradeResult[]> {
    const unique = [...new Set(poolIds)];
    const results = await Promise.allSettled(unique.map((poolId) => this.handle(poolId, alert)));
    return results.map((result, index) => result.status === "fulfilled"
      ? result.value
      : { ok: false, poolId: unique[index]!, message: result.reason instanceof Error ? result.reason.message : String(result.reason), simulated: true });
  }

  accountForOpenTrade(poolId: string): AccountDefinition | undefined {
    const id = this.rotations.get(poolId)?.snapshot().openTrade?.accountId;
    return id ? this.registry.account(id) : undefined;
  }

  hasOpenTradeForConnection(connectionId: string): boolean {
    return [...this.rotations.values()].some((rotation) => rotation.snapshot().openTrade?.connectionId === connectionId);
  }

  setNext(poolId: string, accountId: string): void {
    const rotation = this.rotations.get(poolId);
    if (!rotation) throw new Error(`Unknown pool: ${poolId}`);
    rotation.setNext(accountId, this.registry.accountsInPool(poolId));
  }

  async refreshBalances(): Promise<Array<{ connectionId: string; refreshed: number; deferred: boolean; error?: string }>> {
    const results = [];
    for (const connection of this.registry.connections()) {
      const worker = this.workers.get(connection.id);
      if (!worker) continue;
      if (this.hasOpenTradeForConnection(connection.id)) {
        results.push({ connectionId: connection.id, refreshed: 0, deferred: true });
        continue;
      }
      let refreshed = 0;
      try {
        for (const account of this.registry.snapshot().accounts.filter((item) => item.connectionId === connection.id && item.enabled)) {
          const balance = await worker.run((adapter) => adapter.readBalance(account));
          if (balance != null) { this.balances?.set(account.id, balance); refreshed++; }
        }
        results.push({ connectionId: connection.id, refreshed, deferred: false });
      } catch (error) {
        results.push({ connectionId: connection.id, refreshed, deferred: false, error: (error as Error).message });
      }
    }
    return results;
  }

  async monitorBalanceTargets(): Promise<TradeResult[]> {
    const results: TradeResult[] = [];
    for (const pool of this.registry.pools()) {
      const open = this.rotations.get(pool.id)?.snapshot().openTrade;
      if (!pool.balanceTarget || !open || open.simulated || this.targetChecks.has(pool.id)) continue;
      const worker = this.workers.get(open.connectionId);
      if (!worker) continue;
      this.targetChecks.add(pool.id);
      try {
        const balance = await worker.run((adapter) => adapter.readSelectedBalance());
        if (balance != null) this.balances?.set(open.accountId, balance);
        if (balance == null || balance < pool.balanceTarget) continue;
        const result = await this.handle(pool.id, { action: "close", symbol: open.symbol, test: false, signalId: `balance-target-${open.accountId}-${balance}` });
        if (result.ok) this.registry.setAccountStatus(open.accountId, "passed");
        results.push(result);
      } catch (error) {
        throw new Error(`Target check failed for ${pool.id} on ${open.accountName}: ${(error as Error).message}`);
      } finally {
        this.targetChecks.delete(pool.id);
      }
    }
    return results;
  }
}
