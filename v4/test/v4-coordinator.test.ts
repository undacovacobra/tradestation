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
  constructor(private readonly id: string) {}
  async connect() {}
  async recover() {}
  async disconnect() {}
  status(): WorkerStatus { return { connectionId: this.id, connected: true, loggedIn: true, busy: false, selectedAccount: null }; }
  async discoverAccounts() { return []; }
  async enter(_account: AccountDefinition, _alert: V4Alert) {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 30));
    active--;
  }
  async close() {}
}

function setup(mode: "practice" | "live" = "live", executionLanes?: [string, string]) {
  const dir = mkdtempSync(resolve(tmpdir(), "v4-coordinator-"));
  const connections: ConnectionDefinition[] = [
    { id: "c1", name: "Login 1", firm: "Firm A", adapter: "simulated", url: "https://example.com", sessionDir: ".s1", accountPattern: ".+", enabled: true, autoConnect: false },
    { id: "c2", name: "Login 2", firm: "Firm B", adapter: "simulated", url: "https://example.com", sessionDir: ".s2", accountPattern: ".+", enabled: true, autoConnect: false },
  ];
  writeFileSync(resolve(dir, "registry.json"), JSON.stringify({
    version: 4, running: true, mode, connections,
    accounts: [
      { id: "a1", name: "A", firm: "Firm A", stage: "eval", connectionId: "c1", platformLabel: "X1", enabled: true, status: "active", tags: [] },
      { id: "a2", name: "B", firm: "Firm B", stage: "funded", connectionId: "c2", platformLabel: "Y2", enabled: true, status: "active", tags: [] },
    ],
    pools: [
      { id: "p1", name: "Pool 1", accountIds: ["a1"], enabled: true, benchWinnersForDay: false, executionLane: executionLanes?.[0] },
      { id: "p2", name: "Pool 2", accountIds: ["a2"], enabled: true, benchWinnersForDay: false, executionLane: executionLanes?.[1] },
    ],
  }));
  const workers = new Map<string, ConnectionWorker>(connections.map((c) => [c.id, new ConnectionWorker(c, new FakeAdapter(c.id))]));
  return { coordinator: new TradeCoordinator(new Registry(resolve(dir, "registry.json")), workers, resolve(dir, "state"), () => "2026-07-10") };
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
