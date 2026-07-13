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

test("execution mode changes persist", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "v4-registry-mode-"));
  const path = resolve(dir, "registry.json");
  writeFileSync(path, JSON.stringify({ version: 4, running: true, mode: "practice", connections: [], accounts: [], pools: [] }));
  const registry = new Registry(path);
  registry.setMode("live");
  assert.equal(registry.mode, "live");
  assert.equal(new Registry(path).mode, "live");
  registry.setMode("practice");
  assert.equal(new Registry(path).mode, "practice");
});

test("execution style defaults to standard and Fast Entry persists", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "v4-registry-execution-style-"));
  const path = resolve(dir, "registry.json");
  writeFileSync(path, JSON.stringify({ version: 4, running: true, mode: "practice", connections: [], accounts: [], pools: [] }));
  const registry = new Registry(path);
  assert.equal(registry.executionStyle, "standard");
  registry.setExecutionStyle("fast-entry");
  assert.equal(new Registry(path).executionStyle, "fast-entry");
  registry.setExecutionStyle("standard");
  assert.equal(new Registry(path).executionStyle, "standard");
});

test("remote access preference persists", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "v4-registry-remote-access-"));
  const path = resolve(dir, "registry.json");
  writeFileSync(path, JSON.stringify({ version: 4, running: true, mode: "practice", connections: [], accounts: [], pools: [] }));
  const registry = new Registry(path);
  assert.equal(registry.remoteAccessEnabled, false);
  registry.setRemoteAccessEnabled(true);
  assert.equal(new Registry(path).remoteAccessEnabled, true);
  registry.setRemoteAccessEnabled(false);
  assert.equal(new Registry(path).remoteAccessEnabled, false);
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

test("removing an account deletes it from the registry and every pool", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "v4-delete-account-"));
  const path = resolve(dir, "registry.json");
  writeFileSync(path, JSON.stringify({
    version: 4, running: true, mode: "practice",
    connections: [{ id: "c1", name: "Login", firm: "Firm", adapter: "simulated", url: "https://example.com", sessionDir: ".s", accountPattern: ".+", enabled: true, autoConnect: false }],
    accounts: [
      { id: "a1", name: "Delete Me", firm: "Firm", stage: "eval", connectionId: "c1", platformLabel: "A1", enabled: true, status: "active", tags: [] },
      { id: "a2", name: "Keep Me", firm: "Firm", stage: "eval", connectionId: "c1", platformLabel: "A2", enabled: true, status: "active", tags: [] },
    ],
    pools: [
      { id: "p1", name: "One", accountIds: ["a1", "a2"], enabled: true, benchWinnersForDay: false },
      { id: "p2", name: "Two", accountIds: ["a1"], enabled: true, benchWinnersForDay: false },
    ],
  }));
  const registry = new Registry(path);
  const removed = registry.removeAccount("a1");
  assert.equal(removed.platformLabel, "A1");
  assert.equal(registry.account("a1"), undefined);
  assert.deepEqual(registry.pool("p1")?.accountIds, ["a2"]);
  assert.deepEqual(registry.pool("p2")?.accountIds, []);
  assert.equal(new Registry(path).account("a1"), undefined);
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

test("unconfigured accounts migrate to stage defaults and valid custom pairs persist", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "v4-account-bracket-"));
  const path = resolve(dir, "registry.json");
  writeFileSync(path, JSON.stringify({
    version: 4, running: true, mode: "practice",
    connections: [{ id: "c1", name: "Login", firm: "Firm", adapter: "simulated", url: "https://example.com", sessionDir: ".s", accountPattern: ".+", enabled: true, autoConnect: false }],
    accounts: [
      { id: "a1", name: "Evaluation", firm: "Firm", stage: "eval", connectionId: "c1", platformLabel: "A1", enabled: true, status: "active", tags: [] },
      { id: "a2", name: "Funded", firm: "Firm", stage: "funded", connectionId: "c1", platformLabel: "A2", enabled: true, status: "active", tags: [], targetPerContract: 0, stopPerContract: 0 },
      { id: "a3", name: "Custom", firm: "Firm", stage: "funded", connectionId: "c1", platformLabel: "A3", enabled: true, status: "active", tags: [], targetPerContract: 2500, stopPerContract: 750 },
    ],
    pools: [{ id: "p1", name: "Pool", accountIds: ["a1", "a2", "a3"], enabled: true, benchWinnersForDay: false }],
  }));
  const registry = new Registry(path);
  assert.deepEqual(
    { target: registry.account("a1")?.targetPerContract, stop: registry.account("a1")?.stopPerContract },
    { target: 1520, stop: 1000 },
  );
  assert.deepEqual(
    { target: registry.account("a2")?.targetPerContract, stop: registry.account("a2")?.stopPerContract },
    { target: 4000, stop: 1000 },
  );
  assert.deepEqual(
    { target: registry.account("a3")?.targetPerContract, stop: registry.account("a3")?.stopPerContract },
    { target: 2500, stop: 750 },
  );
  assert.equal(new Registry(path).account("a2")?.targetPerContract, 4000, "migration is persisted");

  registry.updateAccount("a1", { name: "Account", firm: "Firm", stage: "eval", poolIds: ["p1"], targetPerContract: 30, stopPerContract: 20 });
  const reloaded = new Registry(path).account("a1");
  assert.equal(reloaded?.targetPerContract, 30);
  assert.equal(reloaded?.stopPerContract, 20);
});

test("new accounts use editable stage defaults when no bracket is supplied", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "v4-new-account-bracket-"));
  const path = resolve(dir, "registry.json");
  writeFileSync(path, JSON.stringify({
    version: 4, running: true, mode: "practice",
    connections: [{ id: "c1", name: "Login", firm: "Firm", adapter: "simulated", url: "https://example.com", sessionDir: ".s", accountPattern: ".+", enabled: true, autoConnect: false }],
    accounts: [],
    pools: [{ id: "p1", name: "Pool", accountIds: [], enabled: true, benchWinnersForDay: false }],
  }));
  const registry = new Registry(path);
  const evaluation = registry.onboardAccount({ id: "e1", name: "Evaluation", firm: "Firm", stage: "eval", connectionId: "c1", platformLabel: "E1", poolIds: ["p1"] });
  const funded = registry.onboardAccount({ id: "f1", name: "Funded", firm: "Firm", stage: "funded", connectionId: "c1", platformLabel: "F1", poolIds: ["p1"] });
  assert.deepEqual({ target: evaluation.targetPerContract, stop: evaluation.stopPerContract }, { target: 1520, stop: 1000 });
  assert.deepEqual({ target: funded.targetPerContract, stop: funded.stopPerContract }, { target: 4000, stop: 1000 });
});

test("one-sided dollar brackets are rejected", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "v4-bad-bracket-"));
  const path = resolve(dir, "registry.json");
  writeFileSync(path, JSON.stringify({
    version: 4, running: true, mode: "practice",
    connections: [{ id: "c1", name: "Login", firm: "Firm", adapter: "simulated", url: "https://example.com", sessionDir: ".s", accountPattern: ".+", enabled: true, autoConnect: false }],
    accounts: [{ id: "a1", name: "Account", firm: "Firm", stage: "eval", connectionId: "c1", platformLabel: "A1", enabled: true, status: "active", tags: [] }],
    pools: [{ id: "p1", name: "Pool", accountIds: ["a1"], enabled: true, benchWinnersForDay: false }],
  }));
  const registry = new Registry(path);
  assert.throws(() => registry.updateAccount("a1", { name: "Account", firm: "Firm", stage: "eval", poolIds: ["p1"], targetPerContract: 30, stopPerContract: 0 }), /both.*positive|both.*zero/i);
});

test("bracket-only updates preserve account identity and pool membership", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "v4-inline-bracket-"));
  const path = resolve(dir, "registry.json");
  writeFileSync(path, JSON.stringify({
    version: 4, running: true, mode: "practice",
    connections: [{ id: "c1", name: "Login", firm: "Firm", adapter: "simulated", url: "https://example.com", sessionDir: ".s", accountPattern: ".+", enabled: true, autoConnect: false }],
    accounts: [{ id: "a1", name: "Original", firm: "Firm", stage: "eval", connectionId: "c1", platformLabel: "BROKER-A1", enabled: true, status: "active", tags: [] }],
    pools: [{ id: "p1", name: "Pool", accountIds: ["a1"], enabled: true, benchWinnersForDay: false }],
  }));
  const registry = new Registry(path);
  const updated = registry.updateAccountBracket("a1", 1500, 1000);
  assert.deepEqual(
    { name: updated.name, firm: updated.firm, stage: updated.stage, connectionId: updated.connectionId, platformLabel: updated.platformLabel },
    { name: "Original", firm: "Firm", stage: "eval", connectionId: "c1", platformLabel: "BROKER-A1" },
  );
  assert.equal(updated.targetPerContract, 1500);
  assert.equal(updated.stopPerContract, 1000);
  assert.deepEqual(registry.pool("p1")?.accountIds, ["a1"]);
  assert.throws(() => registry.updateAccountBracket("a1", 1500, 0), /both.*positive|both.*zero/i);
});
