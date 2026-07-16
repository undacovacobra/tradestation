import assert from "node:assert/strict";
import test from "node:test";
import {
  CredentialLaneRegistry,
  laneKey,
  parseLaneKey,
  type Stage,
} from "../src/lanes.js";
import type { SavedLogin, StoredAccount } from "../src/types.js";

function credential(id: string, enabled = true): SavedLogin {
  return {
    id,
    name: id === "apex" ? "Apex" : "Other Firm",
    firm: id === "apex" ? "Apex Trader Funding" : "Other Prop Firm",
    platform: "tradovate",
    sessionDir: `.tradovate-sessions/${id}`,
    enabled,
    autoConnect: false,
  };
}

function account(label: string, loginId: string, group: Stage, enabled = true): StoredAccount {
  return {
    tradovateLabel: label,
    name: label,
    group,
    enabled,
    status: "active",
    atmPreset: group === "evals" ? "25" : "funded",
    loginId,
    firm: loginId,
  };
}

test("lane keys round-trip without losing credential or stage", () => {
  assert.equal(laneKey("apex-main", "evals"), "apex-main:evals");
  assert.deepEqual(parseLaneKey("apex-main:funded"), {
    credentialId: "apex-main",
    stage: "funded",
  });
  assert.equal(parseLaneKey("missing-stage"), undefined);
  assert.equal(parseLaneKey("apex:unknown"), undefined);
});

test("registry derives two lanes for every enabled credential", () => {
  const registry = new CredentialLaneRegistry(
    [credential("apex"), credential("other"), credential("disabled", false)],
    [],
  );

  assert.deepEqual(registry.keys(), [
    "apex:evals",
    "apex:funded",
    "other:evals",
    "other:funded",
  ]);
  assert.equal(registry.get("disabled:evals"), undefined);
});

test("each lane contains only accounts owned by its credential and stage", () => {
  const accounts = [
    account("AE1", "apex", "evals"),
    account("AE-OFF", "apex", "evals", false),
    account("AF1", "apex", "funded"),
    account("OE1", "other", "evals"),
  ];
  const registry = new CredentialLaneRegistry(
    [credential("apex"), credential("other")],
    accounts,
  );

  assert.deepEqual(registry.get("apex:evals")?.accounts.map((item) => item.tradovateLabel), ["AE1"]);
  assert.deepEqual(registry.get("apex:funded")?.accounts.map((item) => item.tradovateLabel), ["AF1"]);
  assert.deepEqual(registry.get("other:evals")?.accounts.map((item) => item.tradovateLabel), ["OE1"]);
});

test("lane routes are credential-specific and exact", () => {
  const registry = new CredentialLaneRegistry([credential("apex")], []);
  const evals = registry.get("apex:evals");
  const funded = registry.get("apex:funded");

  assert.equal(evals?.webhookPath, "/webhook/apex/evals");
  assert.equal(funded?.webhookPath, "/webhook/apex/funded");
  assert.equal(evals?.credentialWebhookPath, "/webhook/apex");
  assert.equal(evals?.globalWebhookPath, "/webhook/evals");
  assert.equal(funded?.globalWebhookPath, "/webhook/funded");
});
