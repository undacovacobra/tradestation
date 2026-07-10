import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { RegistrySchema, type AccountDefinition, type ConnectionDefinition, type PoolDefinition, type RegistryData } from "./models.js";

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
