import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { TradeCoordinator } from "../src/coordinator.js";
import type { AccountDefinition, ConnectionDefinition, V4Alert, WorkerStatus } from "../src/models.js";
import { Registry } from "../src/registry.js";
import { ConnectionWorker, type ConnectionAdapter } from "../src/workers.js";

let active = 0;
let maxActive = 0;
class FakeAdapter implements ConnectionAdapter {
  balance = 50_000;
  closes = 0;
  prepares: string[] = [];
  connected = true;
  constructor(private readonly id: string) {}
  async connect() {}
  async recover() {}
  async disconnect() {}
  status(): WorkerStatus { return { connectionId: this.id, connected: this.connected, loggedIn: this.connected, busy: false, selectedAccount: null }; }
  async discoverAccounts() { return []; }
  async setBracket() {}
  async inspectFields() { return []; }
  async inspectAtmControls() { return []; }
  async prepare(account: AccountDefinition) { this.prepares.push(account.id); }
  async enterPrepared(account: AccountDefinition, alert: V4Alert) { await this.enter(account, alert); }
  async enter(_account: AccountDefinition, _alert: V4Alert) {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 30));
    active--;
  }
  async close() { this.closes++; }
  async readBalance() { return this.balance; }
  async readSelectedBalance() { return this.balance; }
  async readSettledBalance() { return this.balance; }
}

function setup(mode: "practice" | "live" = "live", executionLanes?: [string, string], evalTarget?: number, sameConnection = false) {
  const dir = mkdtempSync(resolve(tmpdir(), "v4-coordinator-"));
  const connections: ConnectionDefinition[] = [
    { id: "c1", name: "Login 1", firm: "Firm A", adapter: "simulated", url: "https://example.com", sessionDir: ".s1", accountPattern: ".+", enabled: true, autoConnect: false },
    { id: "c2", name: "Login 2", firm: "Firm B", adapter: "simulated", url: "https://example.com", sessionDir: ".s2", accountPattern: ".+", enabled: true, autoConnect: false },
  ];
  writeFileSync(resolve(dir, "registry.json"), JSON.stringify({
    version: 4, running: true, mode, connections,
    accounts: [
      { id: "a1", name: "A", firm: "Firm A", stage: "eval", connectionId: "c1", platformLabel: "X1", enabled: true, status: "active", tags: [] },
      { id: "a2", name: "B", firm: "Firm B", stage: "funded", connectionId: sameConnection ? "c1" : "c2", platformLabel: "Y2", enabled: true, status: "active", tags: [] },
    ],
    pools: [
      { id: "p1", name: "Pool 1", accountIds: ["a1"], enabled: true, benchWinnersForDay: false, executionLane: executionLanes?.[0], balanceTarget: evalTarget },
      { id: "p2", name: "Pool 2", accountIds: ["a2"], enabled: true, benchWinnersForDay: false, executionLane: executionLanes?.[1] },
    ],
  }));
  const adapters = new Map(connections.map((connection) => [connection.id, new FakeAdapter(connection.id)]));
  const workers = new Map<string, ConnectionWorker>(connections.map((connection) => [connection.id, new ConnectionWorker(connection, adapters.get(connection.id)!)]));
  const registry = new Registry(resolve(dir, "registry.json"));
  return { coordinator: new TradeCoordinator(registry, workers, resolve(dir, "state"), () => "2026-07-10"), registry, adapters };
}

test("broadcast runs independent logins concurrently", async () => {
  active = 0; maxActive = 0;
  const { coordinator } = setup("live");
  const results = await coordinator.handleMany(["p1", "p2"], { action: "buy", symbol: "MNQ", quantity: 1, test: false });
  assert.equal(results.every((r) => r.ok), true);
  assert.equal(maxActive, 2);
});

test("pools in the same execution lane cannot open at the same time", async () => {
  active = 0; maxActive = 0;
  const { coordinator } = setup("live", ["shared", "shared"]);
  const results = await coordinator.handleMany(["p1", "p2"], { action: "buy", symbol: "MNQ", quantity: 1, test: false });
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.filter((result) => !result.ok).length, 1);
  assert.match(results.find((result) => !result.ok)?.message ?? "", /execution lane shared is already in use/i);
  assert.equal(maxActive, 1);
});

test("test webhook is plan-only and never opens pool state", async () => {
  const { coordinator } = setup("live");
  const result = await coordinator.handle("p1", { action: "buy", symbol: "MNQ", quantity: 1, test: true });
  assert.match(result.message, /TEST ONLY/);
  assert.equal(coordinator.status().find((p) => p.id === "p1")?.state?.openTrade, null);
});

test("evaluation pool automatically closes and passes account at 53000", async () => {
  const { coordinator, registry, adapters } = setup("live", undefined, 53_000);
  await coordinator.handle("p1", { action: "buy", symbol: "MNQ", quantity: 1, test: false });
  adapters.get("c1")!.balance = 53_000;
  const results = await coordinator.monitorBalanceTargets();
  assert.equal(results[0]?.ok, true);
  assert.equal(adapters.get("c1")!.closes, 1);
  assert.equal(coordinator.status().find((pool) => pool.id === "p1")?.state?.openTrade, null);
  assert.equal(registry.account("a1")?.status, "passed");
});

test("funded pool never uses the evaluation balance target", async () => {
  const { coordinator, adapters } = setup("live", undefined, 53_000);
  await coordinator.handle("p2", { action: "buy", symbol: "MNQ", quantity: 1, test: false });
  adapters.get("c2")!.balance = 60_000;
  const results = await coordinator.monitorBalanceTargets();
  assert.equal(results.length, 0);
  assert.equal(adapters.get("c2")!.closes, 0);
});

test("coordinator exposes skip-today status and allows resuming the account", async () => {
  const { coordinator } = setup("live");
  await coordinator.skipToday("p1", "a1");
  const skipped = coordinator.status().find((pool) => pool.id === "p1")?.accounts.find((account) => account.id === "a1");
  assert.equal(skipped?.skippedToday, true);
  assert.equal(skipped?.isNext, false);
  await assert.rejects(() => coordinator.setNext("p1", "a1"), /skipped for today/i);

  await coordinator.resumeToday("p1", "a1");
  await coordinator.setNext("p1", "a1");
  const resumed = coordinator.status().find((pool) => pool.id === "p1")?.accounts.find((account) => account.id === "a1");
  assert.equal(resumed?.skippedToday, false);
  assert.equal(resumed?.isNext, true);
});

test("daily rotation controls reject the account holding an open trade", async () => {
  const { coordinator } = setup("live");
  await coordinator.handle("p1", { action: "buy", symbol: "MNQ", quantity: 1, test: false });
  assert.equal(coordinator.hasOpenTradeForAccount("a1"), true);
  await assert.rejects(() => coordinator.skipToday("p1", "a1"), /open trade/i);
  await assert.rejects(() => coordinator.resumeToday("p1", "a1"), /open trade/i);
});

test("Make Next pre-arms that account and status reports the exact armed bracket", async () => {
  const { coordinator, adapters } = setup("live");
  await coordinator.setNext("p1", "a1");
  const pool = coordinator.status().find((item) => item.id === "p1");
  assert.equal(pool?.armed, true);
  assert.equal(pool?.armedAccountId, "a1");
  assert.equal(pool?.prearmError, undefined);
  assert.deepEqual(adapters.get("c1")?.prepares, ["a1"]);
});

test("different logins can stay armed independently and entry uses the prepared fast path", async () => {
  const { coordinator, adapters } = setup("live");
  await coordinator.prearmConnection("c1");
  await coordinator.prearmConnection("c2");
  const status = coordinator.status();
  assert.equal(status.find((pool) => pool.id === "p1")?.armed, true);
  assert.equal(status.find((pool) => pool.id === "p2")?.armed, true);
  await coordinator.handle("p1", { action: "buy", symbol: "MNQ", quantity: 1, test: false });
  assert.deepEqual(adapters.get("c1")?.prepares, ["a1"]);
});

test("closing a trade advances and immediately re-arms the resulting next account", async () => {
  const { coordinator, adapters } = setup("live");
  await coordinator.prearmPool("p1");
  await coordinator.handle("p1", { action: "buy", symbol: "MNQ", quantity: 1, test: false });
  await coordinator.handle("p1", { action: "close", symbol: "MNQ", test: false });
  assert.equal(coordinator.status().find((pool) => pool.id === "p1")?.armed, true);
  assert.deepEqual(adapters.get("c1")?.prepares, ["a1", "a1"]);
});

test("one login exposes only its last prepared account as armed across multiple pools", async () => {
  const { coordinator, adapters } = setup("live", undefined, undefined, true);
  await coordinator.prearmConnection("c1");
  const status = coordinator.status();
  assert.equal(status.find((pool) => pool.id === "p1")?.armed, false);
  assert.equal(status.find((pool) => pool.id === "p2")?.armed, true);
  assert.deepEqual(adapters.get("c1")?.prepares, ["a1", "a2"]);
});

test("a failed pre-arm is visible and never claims the pool is ready", async () => {
  const { coordinator, adapters } = setup("live");
  adapters.get("c1")!.connected = false;
  await coordinator.prearmPool("p1");
  const pool = coordinator.status().find((item) => item.id === "p1");
  assert.equal(pool?.armed, false);
  assert.match(pool?.prearmError ?? "", /not connected and logged in/i);
});
