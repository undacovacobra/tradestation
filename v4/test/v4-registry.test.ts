import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { Registry } from "../src/registry.js";

test("browser-discovered account can be classified and attached to pools", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "v4-onboard-"));
  const path = resolve(dir, "registry.json");
  writeFileSync(path, JSON.stringify({
    version: 4, running: true, mode: "practice",
    connections: [{ id: "login-1", name: "Login 1", firm: "Firm", adapter: "simulated", url: "https://example.com", sessionDir: ".s", accountPattern: ".+", enabled: true, autoConnect: false }],
    accounts: [{ id: "seed", name: "Seed", firm: "Firm", stage: "eval", connectionId: "login-1", platformLabel: "SEED", enabled: false, status: "held", tags: [] }],
    pools: [{ id: "eval-primary", name: "Eval", accountIds: ["seed"], enabled: true, benchWinnersForDay: false }],
  }));
  const registry = new Registry(path);
  const account = registry.onboardAccount({ id: "firm-eval-2", name: "Evaluation 2", firm: "Firm", stage: "eval", connectionId: "login-1", platformLabel: "ANY-LABEL-002", poolIds: ["eval-primary"] });
  assert.equal(account.platformLabel, "ANY-LABEL-002");
  assert.deepEqual(registry.pool("eval-primary")?.accountIds, ["seed", "firm-eval-2"]);
  assert.equal(new Registry(path).account("firm-eval-2")?.stage, "eval");
});

test("execution lane can be changed and persists", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "v4-lane-"));
  const path = resolve(dir, "registry.json");
  writeFileSync(path, JSON.stringify({
    version: 4, running: true, mode: "practice", connections: [], accounts: [],
    pools: [{ id: "eval-primary", name: "Eval", accountIds: [], enabled: true, benchWinnersForDay: false }],
  }));
  const registry = new Registry(path);
  registry.setPoolExecutionLane("eval-primary", "weekday-cycle");
  assert.equal(new Registry(path).pool("eval-primary")?.executionLane, "weekday-cycle");
});

test("connection can be added dynamically and persists", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "v4-connection-"));
  const path = resolve(dir, "registry.json");
  writeFileSync(path, JSON.stringify({ version: 4, running: true, mode: "practice", connections: [], accounts: [], pools: [] }));
  const registry = new Registry(path);
  registry.addConnection({ id: "firm-two", name: "Firm Two", firm: "Firm", adapter: "simulated", url: "https://example.com", sessionDir: ".sessions/firm-two", accountPattern: ".+", enabled: true, autoConnect: false });
  assert.equal(new Registry(path).connection("firm-two")?.name, "Firm Two");
});

test("referenced connection cannot be removed", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "v4-remove-connection-"));
  const path = resolve(dir, "registry.json");
  writeFileSync(path, JSON.stringify({
    version: 4, running: true, mode: "practice",
    connections: [{ id: "c1", name: "Login", firm: "Firm", adapter: "simulated", url: "https://example.com", sessionDir: ".s", accountPattern: ".+", enabled: true, autoConnect: false }],
    accounts: [{ id: "a1", name: "Account", firm: "Firm", stage: "eval", connectionId: "c1", platformLabel: "A1", enabled: true, status: "active", tags: [] }],
    pools: [{ id: "p1", name: "Pool", accountIds: ["a1"], enabled: true, benchWinnersForDay: false }],
  }));
  assert.throws(() => new Registry(path).removeConnection("c1"), /still has accounts/i);
});

test("pool order and account status can be managed", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "v4-manage-pool-"));
  const path = resolve(dir, "registry.json");
  writeFileSync(path, JSON.stringify({
    version: 4, running: true, mode: "practice",
    connections: [{ id: "c1", name: "Login", firm: "Firm", adapter: "simulated", url: "https://example.com", sessionDir: ".s", accountPattern: ".+", enabled: true, autoConnect: false }],
    accounts: [
      { id: "a1", name: "One", firm: "Firm", stage: "eval", connectionId: "c1", platformLabel: "A1", enabled: true, status: "active", tags: [] },
      { id: "a2", name: "Two", firm: "Firm", stage: "eval", connectionId: "c1", platformLabel: "A2", enabled: true, status: "active", tags: [] },
    ],
    pools: [{ id: "p1", name: "Pool", accountIds: ["a1", "a2"], enabled: true, benchWinnersForDay: false }],
  }));
  const registry = new Registry(path);
  registry.movePoolAccount("p1", "a2", "up");
  registry.setAccountStatus("a1", "held");
  assert.deepEqual(registry.pool("p1")?.accountIds, ["a2", "a1"]);
  assert.equal(registry.account("a1")?.status, "held");
});

test("configured account fields and pool memberships can be updated without changing broker identity", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "v4-edit-account-"));
  const path = resolve(dir, "registry.json");
  writeFileSync(path, JSON.stringify({
    version: 4, running: true, mode: "practice",
    connections: [{ id: "c1", name: "Login", firm: "Firm", adapter: "simulated", url: "https://example.com", sessionDir: ".s", accountPattern: ".+", enabled: true, autoConnect: false }],
    accounts: [{ id: "a1", name: "Original", firm: "Firm", stage: "eval", connectionId: "c1", platformLabel: "BROKER-A1", enabled: true, status: "active", tags: [] }],
    pools: [
      { id: "p1", name: "Evaluation", accountIds: ["a1"], enabled: true, benchWinnersForDay: false },
      { id: "p2", name: "Funded", accountIds: [], enabled: true, benchWinnersForDay: false },
    ],
  }));
  const registry = new Registry(path);
  const updated = registry.updateAccount("a1", { name: "Renamed", firm: "New Firm", stage: "funded", poolIds: ["p2"] });
  assert.equal(updated.name, "Renamed");
  assert.equal(updated.firm, "New Firm");
  assert.equal(updated.stage, "funded");
  assert.equal(updated.connectionId, "c1");
  assert.equal(updated.platformLabel, "BROKER-A1");
  assert.deepEqual(registry.pool("p1")?.accountIds, []);
  assert.deepEqual(registry.pool("p2")?.accountIds, ["a1"]);
  assert.equal(new Registry(path).account("a1")?.name, "Renamed");
});
