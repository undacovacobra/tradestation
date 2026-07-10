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
