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

test("worker pre-arms account and bracket, then applies the webhook quantity immediately before entry", async () => {
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
    async testPreparedQuantity() {},
    async verifyPrepared(prepared) { events.push(`verify:${prepared.id}:${prepared.targetPerContract}/${prepared.stopPerContract}`); },
    async enterPrepared(prepared, incoming) { events.push(`qty:${incoming.quantity}`); events.push(`fast:${prepared.id}`); },
    async enter(prepared) { events.push(`full:${prepared.id}`); }, async close() {},
    async readBalance() { events.push("balance"); return 50_000; }, async readSelectedBalance() { return 50_000; }, async readSettledBalance() { return 50_000; },
  };
  const worker = new ConnectionWorker(definition, adapter);
  await worker.prearm(account);
  assert.equal(worker.isArmed(account), true);
  await worker.enter(account, alert);
  assert.deepEqual(events, ["balance", "prepare:a1:30/20", "qty:2", "fast:a1"]);

  const changed = { ...account, targetPerContract: 31 };
  await assert.rejects(() => worker.enter(changed, alert), /not ready|not armed/i);
});

test("worker dry run is instant when already armed and never places an order", async () => {
  const events: string[] = [];
  const definition: ConnectionDefinition = {
    id: "c1", name: "Login", firm: "Firm", adapter: "simulated", url: "https://example.com",
    sessionDir: ".s", accountPattern: ".+", enabled: true, autoConnect: false,
  };
  const adapter = {
    async connect() {}, async recover() {}, async disconnect() {},
    status(): WorkerStatus { return { connectionId: "c1", connected: true, loggedIn: true, busy: false, selectedAccount: "ACCOUNT-1" }; },
    async discoverAccounts() { return []; }, async setBracket() {}, async inspectFields() { return []; }, async inspectAtmControls() { return []; },
    async prepare(prepared: AccountDefinition) { events.push(`prepare:${prepared.id}`); },
    async testPreparedQuantity(_prepared: AccountDefinition, quantity: number) { events.push(`qty:${quantity}`); },
    async verifyPrepared(prepared: AccountDefinition) { events.push(`verify:${prepared.id}`); },
    async enterPrepared() { events.push("ORDER"); }, async enter() { events.push("ORDER"); }, async close() {},
    async readBalance() { events.push("balance"); return 50_000; }, async readSelectedBalance() { return 50_000; }, async readSettledBalance() { return 50_000; },
  };
  const worker = new ConnectionWorker(definition, adapter);
  const first = await worker.dryRun(account, 2);
  assert.equal(first.alreadyArmed, false);
  assert.deepEqual(events, ["balance", "prepare:a1", "qty:2"]);
  const second = await worker.dryRun(account, 2);
  assert.equal(second.alreadyArmed, true);
  assert.deepEqual(events, ["balance", "prepare:a1", "qty:2", "qty:2"]);
  assert.equal(worker.isArmed(account), true);
});

test("one worker blocks a second differently bracketed account until it is separately prepared", async () => {
  const events: string[] = [];
  const definition: ConnectionDefinition = {
    id: "c1", name: "Login", firm: "Firm", adapter: "simulated", url: "https://example.com",
    sessionDir: ".s", accountPattern: ".+", enabled: true, autoConnect: false,
  };
  const adapter = {
    async connect() {}, async recover() {}, async disconnect() {},
    status(): WorkerStatus { return { connectionId: "c1", connected: true, loggedIn: true, busy: false, selectedAccount: null }; },
    async discoverAccounts() { return []; }, async setBracket() {}, async inspectFields() { return []; }, async inspectAtmControls() { return []; },
    async prepare(prepared: AccountDefinition) {
      events.push(`start:${prepared.id}:${prepared.targetPerContract}/${prepared.stopPerContract}`);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 15));
    },
    async testPreparedQuantity() {},
    async verifyPrepared(prepared: AccountDefinition) { events.push(`verify:${prepared.id}`); },
    async enterPrepared(prepared: AccountDefinition) {
      events.push(`order:${prepared.id}`);
    },
    async enter() {},
    async close() {}, async readBalance(prepared: AccountDefinition) { events.push(`balance:${prepared.id}`); return 50_000; },
    async readSelectedBalance() { return 50_000; }, async readSettledBalance() { return 50_000; },
  };
  const worker = new ConnectionWorker(definition, adapter);
  const funded = { ...account, id: "a2", name: "Funded", platformLabel: "ACCOUNT-2", stage: "funded" as const, targetPerContract: 4000, stopPerContract: 1000 };
  await worker.prearm(account);
  await worker.enter(account, alert);
  await assert.rejects(() => worker.enter(funded, alert), /not ready/i);
  assert.deepEqual(events, [
    "balance:a1", "start:a1:30/20", "order:a1",
  ]);
});

test("unarmed order is blocked before any browser order call", async () => {
  let ordered = false;
  const definition: ConnectionDefinition = {
    id: "c1", name: "Login", firm: "Firm", adapter: "simulated", url: "https://example.com",
    sessionDir: ".s", accountPattern: ".+", enabled: true, autoConnect: false,
  };
  const adapter = {
    async connect() {}, async recover() {}, async disconnect() {},
    status(): WorkerStatus { return { connectionId: "c1", connected: true, loggedIn: true, busy: false, selectedAccount: "ACCOUNT-1" }; },
    async discoverAccounts() { return []; }, async setBracket() {}, async inspectFields() { return []; }, async inspectAtmControls() { return []; },
    async prepare() {}, async testPreparedQuantity() {}, async verifyPrepared() {},
    async enterPrepared() { ordered = true; }, async enter() { ordered = true; }, async close() {},
    async readBalance() { return 50_000; }, async readSelectedBalance() { return 50_000; }, async readSettledBalance() { return 50_000; },
  };
  const worker = new ConnectionWorker(definition, adapter);
  await assert.rejects(() => worker.enter(account, alert), /not ready|not armed/i);
  assert.equal(ordered, false);
});

test("live entry is blocked instead of waiting behind preparation work", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
  const definition: ConnectionDefinition = {
    id: "c1", name: "Login", firm: "Firm", adapter: "simulated", url: "https://example.com",
    sessionDir: ".s", accountPattern: ".+", enabled: true, autoConnect: false,
  };
  const adapter = {
    async connect() {}, async recover() {}, async disconnect() {},
    status(): WorkerStatus { return { connectionId: "c1", connected: true, loggedIn: true, busy: false, selectedAccount: "ACCOUNT-1" }; },
    async discoverAccounts() { return []; }, async setBracket() {}, async inspectFields() { return []; }, async inspectAtmControls() { return []; },
    async prepare() { await gate; }, async testPreparedQuantity() {}, async verifyPrepared() {}, async enterPrepared() {}, async enter() {}, async close() {},
    async readBalance() { return 50_000; }, async readSelectedBalance() { return 50_000; }, async readSettledBalance() { return 50_000; },
  };
  const worker = new ConnectionWorker(definition, adapter);
  const preparing = worker.prearm(account);
  await assert.rejects(() => worker.enter(account, alert), /busy.*blocked/i);
  release();
  await preparing;
});

test("fast entry prepares the account without setting the ATM, then only sets quantity and clicks", async () => {
  const events: string[] = [];
  const definition: ConnectionDefinition = {
    id: "c1", name: "Login", firm: "Firm", adapter: "simulated", url: "https://example.com",
    sessionDir: ".s", accountPattern: ".+", enabled: true, autoConnect: false,
  };
  const adapter = {
    async connect() {}, async recover() {}, async disconnect() {},
    status(): WorkerStatus { return { connectionId: "c1", connected: true, loggedIn: true, busy: false, selectedAccount: "ACCOUNT-1" }; },
    async discoverAccounts() { return []; }, async setBracket() {}, async inspectFields() { return []; }, async inspectAtmControls() { return []; },
    async prepare() { events.push("STANDARD-ATM"); },
    async prepareFast(prepared: AccountDefinition) { events.push(`fast-ready:${prepared.id}`); },
    async testPreparedQuantity() {}, async verifyPrepared() {},
    async enterPrepared(_prepared: AccountDefinition, incoming: V4Alert) { events.push(`qty:${incoming.quantity}`); events.push("order"); },
    async enter() {}, async close() {},
    async readBalance() { events.push("balance"); return 50_000; }, async readSelectedBalance() { return 50_000; }, async readSettledBalance() { return 50_000; },
  };
  const worker = new ConnectionWorker(definition, adapter);
  await worker.prearmFast(account);
  assert.equal(worker.isArmed(account, "fast-entry"), true);
  await worker.enterFast(account, alert);
  assert.deepEqual(events, ["balance", "fast-ready:a1", "qty:2", "order"]);
});

test("standard and fast readiness cannot be confused", async () => {
  const definition: ConnectionDefinition = {
    id: "c1", name: "Login", firm: "Firm", adapter: "simulated", url: "https://example.com",
    sessionDir: ".s", accountPattern: ".+", enabled: true, autoConnect: false,
  };
  const adapter = {
    async connect() {}, async recover() {}, async disconnect() {},
    status(): WorkerStatus { return { connectionId: "c1", connected: true, loggedIn: true, busy: false, selectedAccount: "ACCOUNT-1" }; },
    async discoverAccounts() { return []; }, async setBracket() {}, async inspectFields() { return []; }, async inspectAtmControls() { return []; },
    async prepare() {}, async prepareFast() {}, async testPreparedQuantity() {}, async verifyPrepared() {}, async enterPrepared() {}, async enter() {}, async close() {},
    async readBalance() { return 50_000; }, async readSelectedBalance() { return 50_000; }, async readSettledBalance() { return 50_000; },
  };
  const worker = new ConnectionWorker(definition, adapter);
  await worker.prearmFast(account);
  assert.equal(worker.isArmed(account), false);
  await assert.rejects(() => worker.enter(account, alert), /not ready/i);
});
