import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { AccountSchema, ConnectionSchema, RegistrySchema, type AccountDefinition, type ConnectionDefinition, type PoolDefinition, type RegistryData } from "./models.js";

const EMPTY: RegistryData = { version: 4, running: true, mode: "practice", connections: [], accounts: [], pools: [] };

export class Registry {
  private data: RegistryData;

  constructor(private readonly path: string) {
    this.data = this.load();
    this.validateReferences();
  }

  private load(): RegistryData {
    if (!existsSync(this.path)) return RegistrySchema.parse(EMPTY);
    return RegistrySchema.parse(JSON.parse(readFileSync(this.path, "utf8")));
  }

  private validateReferences(): void {
    const connectionIds = new Set<string>();
    for (const connection of this.data.connections) {
      if (connectionIds.has(connection.id)) throw new Error(`Duplicate connection id: ${connection.id}`);
      connectionIds.add(connection.id);
      try { new RegExp(connection.accountPattern); } catch { throw new Error(`Invalid accountPattern on ${connection.id}`); }
    }
    const accountIds = new Set<string>();
    for (const account of this.data.accounts) {
      if (accountIds.has(account.id)) throw new Error(`Duplicate account id: ${account.id}`);
      accountIds.add(account.id);
      if (!connectionIds.has(account.connectionId)) throw new Error(`Account ${account.id} references missing connection ${account.connectionId}`);
    }
    const poolIds = new Set<string>();
    for (const pool of this.data.pools) {
      if (poolIds.has(pool.id)) throw new Error(`Duplicate pool id: ${pool.id}`);
      poolIds.add(pool.id);
      for (const id of pool.accountIds) if (!accountIds.has(id)) throw new Error(`Pool ${pool.id} references missing account ${id}`);
    }
  }

  snapshot(): RegistryData { return structuredClone(this.data); }
  get running(): boolean { return this.data.running; }
  get mode(): "practice" | "live" { return this.data.mode; }
  connections(): ConnectionDefinition[] { return this.data.connections.filter((x) => x.enabled); }
  connection(id: string): ConnectionDefinition | undefined { return this.data.connections.find((x) => x.id === id); }
  account(id: string): AccountDefinition | undefined { return this.data.accounts.find((x) => x.id === id); }
  pool(id: string): PoolDefinition | undefined { return this.data.pools.find((x) => x.id === id); }
  pools(): PoolDefinition[] { return this.data.pools; }
  accountsInPool(poolId: string): AccountDefinition[] {
    const pool = this.pool(poolId);
    if (!pool) return [];
    return pool.accountIds.map((id) => this.account(id)).filter((a): a is AccountDefinition => Boolean(a?.enabled && a.status === "active"));
  }

  /** Save one browser-discovered account and attach it to existing rotation pools. */
  onboardAccount(input: {
    id: string;
    name: string;
    firm: string;
    stage: "eval" | "funded";
    connectionId: string;
    platformLabel: string;
    poolIds: string[];
  }): AccountDefinition {
    if (!this.connection(input.connectionId)) throw new Error(`Unknown connection: ${input.connectionId}`);
    if (this.account(input.id)) throw new Error(`Account id already exists: ${input.id}`);
    const sameLabel = this.data.accounts.find((account) => account.connectionId === input.connectionId && account.platformLabel === input.platformLabel);
    if (sameLabel) throw new Error(`${input.platformLabel} is already configured as ${sameLabel.name}`);
    const pools = [...new Set(input.poolIds)].map((id) => {
      const pool = this.pool(id);
      if (!pool) throw new Error(`Unknown pool: ${id}`);
      return pool;
    });
    const account = AccountSchema.parse({
      id: input.id,
      name: input.name,
      firm: input.firm,
      stage: input.stage,
      connectionId: input.connectionId,
      platformLabel: input.platformLabel,
      enabled: true,
      status: "active",
      tags: [],
    });
    this.data.accounts.push(account);
    for (const pool of pools) if (!pool.accountIds.includes(account.id)) pool.accountIds.push(account.id);
    this.validateReferences();
    this.save();
    return account;
  }

  updateAccount(id: string, input: { name: string; firm: string; stage: "eval" | "funded"; poolIds: string[] }): AccountDefinition {
    const index = this.data.accounts.findIndex((account) => account.id === id);
    if (index < 0) throw new Error(`Unknown account: ${id}`);
    const current = this.data.accounts[index]!;
    const requestedPoolIds = [...new Set(input.poolIds)];
    for (const poolId of requestedPoolIds) if (!this.pool(poolId)) throw new Error(`Unknown pool: ${poolId}`);
    const updated = AccountSchema.parse({ ...current, name: input.name.trim(), firm: input.firm.trim(), stage: input.stage });

    this.data.accounts[index] = updated;
    const requested = new Set(requestedPoolIds);
    for (const pool of this.data.pools) {
      if (requested.has(pool.id)) {
        if (!pool.accountIds.includes(id)) pool.accountIds.push(id);
      } else {
        pool.accountIds = pool.accountIds.filter((accountId) => accountId !== id);
      }
    }
    this.validateReferences();
    this.save();
    return structuredClone(updated);
  }

  setPoolExecutionLane(poolId: string, executionLane: string): PoolDefinition {
    const pool = this.pool(poolId);
    if (!pool) throw new Error(`Unknown pool: ${poolId}`);
    const lane = executionLane.trim();
    if (!lane) throw new Error("Execution lane is required");
    pool.executionLane = lane;
    this.save();
    return structuredClone(pool);
  }

  addConnection(input: ConnectionDefinition): ConnectionDefinition {
    const connection = ConnectionSchema.parse(input);
    if (this.connection(connection.id)) throw new Error(`Connection id already exists: ${connection.id}`);
    if (this.data.connections.some((item) => item.sessionDir === connection.sessionDir)) throw new Error(`Session directory already belongs to another connection: ${connection.sessionDir}`);
    try { new RegExp(connection.accountPattern); } catch { throw new Error(`Invalid accountPattern on ${connection.id}`); }
    this.data.connections.push(connection);
    this.validateReferences();
    this.save();
    return structuredClone(connection);
  }

  removeConnection(id: string): void {
    if (this.data.accounts.some((account) => account.connectionId === id)) throw new Error(`Connection ${id} still has accounts`);
    const index = this.data.connections.findIndex((connection) => connection.id === id);
    if (index < 0) throw new Error(`Unknown connection: ${id}`);
    this.data.connections.splice(index, 1);
    this.save();
  }

  setAccountStatus(id: string, status: "active" | "passed" | "held"): AccountDefinition {
    const account = this.account(id);
    if (!account) throw new Error(`Unknown account: ${id}`);
    account.status = status;
    this.save();
    return structuredClone(account);
  }

  movePoolAccount(poolId: string, accountId: string, direction: "up" | "down"): PoolDefinition {
    const pool = this.pool(poolId);
    if (!pool) throw new Error(`Unknown pool: ${poolId}`);
    const index = pool.accountIds.indexOf(accountId);
    if (index < 0) throw new Error(`Account ${accountId} is not in pool ${poolId}`);
    const target = direction === "up" ? index - 1 : index + 1;
    if (target >= 0 && target < pool.accountIds.length) [pool.accountIds[index], pool.accountIds[target]] = [pool.accountIds[target]!, pool.accountIds[index]!];
    this.save();
    return structuredClone(pool);
  }

  removeAccountFromPool(poolId: string, accountId: string): PoolDefinition {
    const pool = this.pool(poolId);
    if (!pool) throw new Error(`Unknown pool: ${poolId}`);
    pool.accountIds = pool.accountIds.filter((id) => id !== accountId);
    this.save();
    return structuredClone(pool);
  }

  replace(next: RegistryData): void {
    this.data = RegistrySchema.parse(next);
    this.validateReferences();
    this.save();
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.path);
  }
}
