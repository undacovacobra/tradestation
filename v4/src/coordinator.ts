import { resolve } from "node:path";
import type { AccountDefinition, TradeResult, V4Alert } from "./models.js";
import { isCloseAlert } from "./models.js";
import { PoolRotation } from "./poolRotation.js";
import type { Registry } from "./registry.js";
import type { ConnectionWorker } from "./workers.js";

export class TradeCoordinator {
  private readonly rotations = new Map<string, PoolRotation>();
  private readonly poolQueues = new Map<string, Promise<unknown>>();
  private readonly recentSignals = new Map<string, number>();
  private readonly reservedAccounts = new Map<string, string>();

  constructor(
    private readonly registry: Registry,
    private readonly workers: Map<string, ConnectionWorker>,
    stateDir: string,
    today: () => string,
  ) {
    for (const pool of registry.pools()) {
      this.rotations.set(pool.id, new PoolRotation(pool.id, resolve(stateDir, `${pool.id}.json`), pool.benchWinnersForDay, today));
    }
  }

  status() {
    return this.registry.pools().map((pool) => ({
      ...pool,
      state: this.rotations.get(pool.id)?.snapshot(),
      accounts: this.registry.accountsInPool(pool.id),
    }));
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
      try {
        if (!simulated) {
          const status = worker.status();
          if (!status.connected || !status.loggedIn) throw new Error(`${worker.definition.name} is not connected and logged in`);
          await worker.run((adapter) => adapter.enter(account, alert));
        }
        rotation.recordOpen(account, alert, simulated);
      } finally {
        this.reservedAccounts.delete(account.id);
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
    if (!simulated) {
      const status = worker.status();
      if (!status.connected || !status.loggedIn) throw new Error(`${worker.definition.name} is not connected; the open trade was not touched`);
      await worker.run((adapter) => adapter.close(account));
    }
    rotation.recordClose(this.registry.accountsInPool(poolId));
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
}
