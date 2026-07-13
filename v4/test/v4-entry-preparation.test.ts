import assert from "node:assert/strict";
import test from "node:test";
import { ConnectionWorker, prepareAccount, prepareEntry } from "../src/workers.js";
import type { AccountDefinition, ConnectionDefinition, V4Alert, WorkerStatus } from "../src/models.js";
import type { ConnectionAdapter } from "../src/workers.js";

const account: AccountDefinition = {
  id: "a1", name: "Eval", firm: "Firm", stage: "eval", connectionId: "c1",
  platformLabel: "ACCOUNT-1", enabled: true, status: "active", tags: [],
  targetPerContract: 30, stopPerContract: 20,
};
const alert: V4Alert = { action: "buy", symbol: "MNQ", quantity: 2, test: false };

test("entry switches account, verifies bracket, sets quantity, then clicks order", async () => {
  const calls: string[] = [];
  const browser = {
    async switchAccount(label: string) { calls.push(`switch:${label}`); },
    async setBracket(target: number, stop: number) { calls.push(`bracket:${target}/${stop}`); },
    async setQuantity(quantity: number) { calls.push(`qty:${quantity}`); },
    async clickOrder(action: string, label: string) { calls.push(`order:${action}:${label}`); },
  };
  await prepareEntry(browser, account, alert);
  assert.deepEqual(calls, ["switch:ACCOUNT-1", "bracket:30/20", "qty:2", "order:buy:ACCOUNT-1"]);
});

test("a failed bracket verification blocks the order click", async () => {
  const calls: string[] = [];
  const browser = {
    async switchAccount() { calls.push("switch"); },
    async setBracket() { calls.push("bracket"); throw new Error("bracket mismatch"); },
    async setQuantity() { calls.push("qty"); },
    async clickOrder() { calls.push("order"); },
  };
  await assert.rejects(() => prepareEntry(browser, account, alert), /bracket mismatch/);
  assert.deepEqual(calls, ["switch", "bracket"]);
});

test("accounts with no bracket configured are blocked before browser interaction", async () => {
  const calls: string[] = [];
  const browser = {
    async switchAccount() { calls.push("switch"); },
    async setBracket() { calls.push("bracket"); },
    async setQuantity() { calls.push("qty"); },
    async clickOrder() { calls.push("order"); },
  };
  await assert.rejects(
    () => prepareEntry(browser, { ...account, targetPerContract: 0, stopPerContract: 0 }, alert),
    /configure.*take profit.*stop loss/i,
  );
  assert.deepEqual(calls, []);
});

test("preparing the next account switches and verifies its bracket without touching an order", async () => {
  const calls: string[] = [];
  const browser = {
    async switchAccount(label: string) { calls.push(`switch:${label}`); },
    async setBracket(target: number, stop: number) { calls.push(`bracket:${target}/${stop}`); },
  };
  await prepareAccount(browser, account);
  assert.deepEqual(calls, ["switch:ACCOUNT-1", "bracket:30/20"]);
});

test("worker uses the fast entry path only while the exact account bracket remains armed", async () => {
  const events: string[] = [];
  const definition: ConnectionDefinition = {
    id: "c1", name: "Login", firm: "Firm", adapter: "simulated", url: "https://example.com",
    sessionDir: ".s", accountPattern: ".+", enabled: true, autoConnect: false,
  };
  const adapter: ConnectionAdapter = {
    async connect() {}, async recover() {}, async disconnect() {},
    status(): WorkerStatus { return { connectionId: "c1", connected: true, loggedIn: true, busy: false, selectedAccount: "ACCOUNT-1" }; },
    async discoverAccounts() { return []; }, async setBracket() {}, async inspectFields() { return []; }, async inspectAtmControls() { return []; },
    async prepare(prepared) { events.push(`prepare:${prepared.id}:${prepared.targetPerContract}/${prepared.stopPerContract}`); },
    async enterPrepared(prepared) { events.push(`fast:${prepared.id}`); },
    async enter(prepared) { events.push(`full:${prepared.id}`); }, async close() {},
    async readBalance() { events.push("balance"); return 50_000; }, async readSelectedBalance() { return 50_000; }, async readSettledBalance() { return 50_000; },
  };
  const worker = new ConnectionWorker(definition, adapter);
  await worker.prearm(account);
  assert.equal(worker.isArmed(account), true);
  await worker.enter(account, alert);
  assert.deepEqual(events, ["prepare:a1:30/20", "balance", "fast:a1"]);

  const changed = { ...account, targetPerContract: 31 };
  await worker.enter(changed, alert);
  assert.deepEqual(events.slice(-2), ["balance", "full:a1"]);
  assert.equal(worker.isArmed(changed), true);
});
