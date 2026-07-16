import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import test from "node:test";
import { registerLoginRoutes } from "../src/loginRoutes.js";
import type { Group, SavedLogin, StoredAccount } from "../src/types.js";

class FakeStore {
  logins: SavedLogin[] = [];
  accounts: StoredAccount[] = [];
  addLogin(name: string, firm: string): SavedLogin {
    const id = name.toLowerCase().replace(/\W+/g, "-");
    const login: SavedLogin = { id, name, firm, platform: "tradovate", sessionDir: `.sessions/${id}`, enabled: true, autoConnect: false };
    this.logins.push(login);
    return login;
  }
  removeLogin(id: string): boolean { const n = this.logins.length; this.logins = this.logins.filter((login) => login.id !== id); return n !== this.logins.length; }
  login(id: string) { return this.logins.find((login) => login.id === id); }
  find(label: string) { return this.accounts.find((account) => account.tradovateLabel === label); }
  assignAccountLogin(label: string, loginId: string): boolean {
    const account = this.find(label); const login = this.login(loginId);
    if (!account || !login) return false;
    account.loginId = login.id; account.firm = login.firm; return true;
  }
}

class FakeWorker {
  connected = false;
  readyInvalidated = false;
  async connect() { this.connected = true; }
  status() { return { connected: this.connected, loggedIn: this.connected, loginId: "", busy: false, pending: 0, selectedAccount: null }; }
  async discoverAccounts() { return ["E1", "F1"]; }
  invalidateReady() { this.readyInvalidated = true; }
}

class FakeManager {
  workers = new Map<string, FakeWorker>();
  add(login: SavedLogin) { const worker = new FakeWorker(); this.workers.set(login.id, worker); return worker; }
  get(id: string) { return this.workers.get(id); }
  async remove(id: string) { this.workers.delete(id); }
}

async function fixture() {
  const app = express(); app.use(express.json());
  const store = new FakeStore();
  const manager = new FakeManager();
  const armed: Group[] = [];
  registerLoginRoutes(app, {
    store,
    manager,
    hasOpenTradeForLogin: () => false,
    hasOpenTradeForAccount: () => false,
    armLogin: async () => {},
    armNext: (group) => { armed.push(group); },
    pushEvent: () => {},
  });
  const server: Server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No address");
  const request = (path: string, method: string, body?: unknown) => fetch(`http://127.0.0.1:${address.port}${path}`, {
    method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { store, manager, armed, request, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test("login creation validates names and adds a live worker", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request("/logins", "POST", { name: "", firm: "Apex" })).status, 400);
    const response = await f.request("/logins", "POST", { name: "Apex Eval", firm: "Apex" });
    assert.equal(response.status, 201);
    assert.equal(f.store.logins.length, 1);
    assert.ok(f.manager.get("apex-eval"));
  } finally { await f.close(); }
});

test("connect and login-scoped scan use the requested worker", async () => {
  const f = await fixture();
  try {
    await f.request("/logins", "POST", { name: "Apex Eval", firm: "Apex" });
    const connect = await f.request("/logins/apex-eval/connect", "POST");
    assert.equal(connect.status, 200);
    const scan = await f.request("/logins/apex-eval/accounts", "GET");
    assert.deepEqual((await scan.json() as { labels: string[] }).labels, ["E1", "F1"]);
  } finally { await f.close(); }
});

test("account assignment updates firm, invalidates sessions, and re-arms its group", async () => {
  const f = await fixture();
  try {
    await f.request("/logins", "POST", { name: "Primary", firm: "Apex" });
    await f.request("/logins", "POST", { name: "Funded", firm: "Tradeify" });
    f.store.accounts.push({ tradovateLabel: "F1", name: "F1", group: "funded", enabled: true, status: "active", atmPreset: "funded", loginId: "primary", firm: "Apex" });
    const response = await f.request("/accounts/login", "POST", { label: "F1", loginId: "funded" });
    assert.equal(response.status, 200);
    assert.equal(f.store.find("F1")?.firm, "Tradeify");
    assert.equal(f.manager.get("primary")?.readyInvalidated, true);
    assert.equal(f.manager.get("funded")?.readyInvalidated, true);
    assert.deepEqual(f.armed, ["funded"]);
  } finally { await f.close(); }
});

test("login removal is blocked while it owns an open trade", async () => {
  const app = express(); app.use(express.json());
  const store = new FakeStore(); const manager = new FakeManager();
  const login = store.addLogin("Open", "Firm"); manager.add(login);
  let reconciled = 0;
  registerLoginRoutes(app, {
    store, manager, hasOpenTradeForLogin: () => true, hasOpenTradeForAccount: () => false,
    armLogin: async () => {}, reconcileLogin: async () => { reconciled++; }, armNext: () => {}, pushEvent: () => {},
  });
  const server: Server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No address");
  try {
    const connect = await fetch(`http://127.0.0.1:${address.port}/logins/open/connect`, { method: "POST" });
    assert.equal(connect.status, 200);
    assert.equal(manager.get("open")?.connected, true);
    assert.equal(reconciled, 1);
    const response = await fetch(`http://127.0.0.1:${address.port}/logins/open`, { method: "DELETE" });
    assert.equal(response.status, 400);
    assert.ok(store.login("open"));
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
