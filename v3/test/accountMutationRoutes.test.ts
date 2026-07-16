import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express from "express";
import type { Group, StoredAccount } from "../src/types.js";

type RegisterAccountMutationRoutes = typeof import("../src/accountMutationRoutes.js").registerAccountMutationRoutes;

async function loadRegisterAccountMutationRoutes(): Promise<RegisterAccountMutationRoutes> {
  try {
    const module = await import("../src/accountMutationRoutes.js");
    return module.registerAccountMutationRoutes;
  } catch (error) {
    assert.fail(`account mutation routes must be independently registerable: ${(error as Error).message}`);
  }
}

class MemoryAccountStore {
  readonly accounts: StoredAccount[];

  constructor(accounts: StoredAccount[] = []) {
    this.accounts = accounts;
  }

  find(label: string): StoredAccount | undefined {
    return this.accounts.find((account) => account.tradovateLabel === label);
  }

  upsertAccount(label: string, group: Group, name?: string, loginId = "primary-tradovate"): StoredAccount {
    if (loginId === "invalid-login") throw new Error("Unknown login invalid-login");
    const existing = this.find(label);
    if (existing) {
      existing.group = group;
      if (name) existing.name = name;
      existing.loginId = loginId;
      existing.firm = `Firm:${loginId}`;
      return existing;
    }
    const account: StoredAccount = {
      tradovateLabel: label,
      name: name ?? label,
      group,
      enabled: true,
      status: "active",
      atmPreset: "",
      loginId,
      firm: `Firm:${loginId}`,
    };
    this.accounts.push(account);
    return account;
  }

  removeAccount(label: string): boolean {
    const index = this.accounts.findIndex((account) => account.tradovateLabel === label);
    if (index === -1) return false;
    this.accounts.splice(index, 1);
    return true;
  }

  toggleAccount(label: string): boolean {
    const account = this.find(label);
    if (!account) return false;
    account.enabled = !account.enabled;
    return true;
  }

  moveAccount(label: string, direction: "up" | "down"): boolean {
    const from = this.accounts.findIndex((account) => account.tradovateLabel === label);
    if (from === -1) return false;
    const step = direction === "up" ? -1 : 1;
    const to = from + step;
    if (to < 0 || to >= this.accounts.length || this.accounts[to]?.group !== this.accounts[from]?.group) return false;
    const account = this.accounts[from]!;
    this.accounts[from] = this.accounts[to]!;
    this.accounts[to] = account;
    return true;
  }

  reactivate(label: string): boolean {
    const account = this.find(label);
    if (!account || account.status !== "passed") return false;
    account.status = "active";
    return true;
  }
}

function account(label: string, group: Group, status: StoredAccount["status"] = "active"): StoredAccount {
  return { tradovateLabel: label, name: label, group, enabled: true, status, atmPreset: "", loginId: "primary-tradovate", firm: "Primary prop firm" };
}

async function post(
  path: string,
  body: unknown,
  store: MemoryAccountStore,
  rearmed: Group[],
  hasOpenTradeForAccount: (label: string) => boolean = () => false,
  hasActiveWorkForLogin: (loginId: string) => boolean = () => false,
): Promise<{ ok: boolean; status: number; error?: string }> {
  const registerAccountMutationRoutes = await loadRegisterAccountMutationRoutes();
  const app = express();
  app.use(express.json());
  const api = express.Router();
  registerAccountMutationRoutes(api, {
    store,
    armNext(group) {
      rearmed.push(group);
    },
    pushEvent() {},
    hasOpenTradeForAccount,
    hasActiveWorkForLogin,
  });
  app.use(api);

  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { ...(await response.json()) as { ok: boolean; error?: string }, status: response.status };
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

test("new account add, including scanned-add, re-arms the requested group", async () => {
  const rearmed: Group[] = [];
  const result = await post("/accounts/add", { label: "LFF1", group: "funded" }, new MemoryAccountStore(), rearmed);

  assert.equal(result.ok, true);
  assert.deepEqual(rearmed, ["funded"]);
});

test("scanned account add preserves the login that was scanned", async () => {
  const rearmed: Group[] = [];
  const store = new MemoryAccountStore();
  const result = await post(
    "/accounts/add",
    { label: "OTHER1", group: "evals", loginId: "other-firm" },
    store,
    rearmed,
  );

  assert.equal(result.ok, true);
  assert.equal(store.find("OTHER1")?.loginId, "other-firm");
  assert.equal(store.find("OTHER1")?.firm, "Firm:other-firm");
});

test("invalid login assignment returns structured JSON instead of an Express 500", async () => {
  const result = await post(
    "/accounts/add",
    { label: "OTHER1", group: "evals", loginId: "invalid-login" },
    new MemoryAccountStore(),
    [],
  );

  assert.equal(result.status, 400);
  assert.match(result.error ?? "", /unknown login/i);
});

test("cross-group upsert moves the account and re-arms only the destination group", async () => {
  const rearmed: Group[] = [];
  const store = new MemoryAccountStore([account("LFE1", "evals")]);
  const result = await post("/accounts/add", { label: "LFE1", group: "funded" }, store, rearmed);

  assert.equal(result.ok, true);
  assert.equal(store.find("LFE1")?.group, "funded");
  assert.deepEqual(rearmed, ["funded"]);
});

test("remove captures and re-arms the account's group before deleting it", async () => {
  const rearmed: Group[] = [];
  const store = new MemoryAccountStore([account("LFF1", "funded")]);
  const result = await post("/accounts/remove", { label: "LFF1" }, store, rearmed);

  assert.equal(result.ok, true);
  assert.equal(store.find("LFF1"), undefined);
  assert.deepEqual(rearmed, ["funded"]);
});

test("an account with an open trade cannot be moved or removed through account mutations", async () => {
  const rearmed: Group[] = [];
  const store = new MemoryAccountStore([account("LFE1", "evals")]);
  const open = (label: string) => label === "LFE1";

  const moved = await post("/accounts/add", { label: "LFE1", group: "funded", loginId: "other" }, store, rearmed, open);
  const removed = await post("/accounts/remove", { label: "LFE1" }, store, rearmed, open);

  assert.equal(moved.status, 409);
  assert.equal(removed.status, 409);
  assert.equal(store.find("LFE1")?.group, "evals");
  assert.equal(store.find("LFE1")?.loginId, "primary-tradovate");
  assert.deepEqual(rearmed, []);
});

test("account controls cannot mutate a login while broker work is in flight", async () => {
  const store = new MemoryAccountStore([account("LFE1", "evals")]);
  const result = await post(
    "/accounts/remove",
    { label: "LFE1" },
    store,
    [],
    () => false,
    (loginId) => loginId === "primary-tradovate",
  );
  assert.equal(result.status, 409);
  assert.ok(store.find("LFE1"));
});

test("toggle re-arms the mutated account's group", async () => {
  const rearmed: Group[] = [];
  const result = await post(
    "/accounts/toggle",
    { label: "LFE1" },
    new MemoryAccountStore([account("LFE1", "evals")]),
    rearmed,
  );

  assert.equal(result.ok, true);
  assert.deepEqual(rearmed, ["evals"]);
});

test("move re-arms the reordered account's group", async () => {
  const rearmed: Group[] = [];
  const result = await post(
    "/accounts/move",
    { label: "LFF2", direction: "up" },
    new MemoryAccountStore([account("LFF1", "funded"), account("LFF2", "funded")]),
    rearmed,
  );

  assert.equal(result.ok, true);
  assert.deepEqual(rearmed, ["funded"]);
});

test("reactivate re-arms the reactivated account's group", async () => {
  const rearmed: Group[] = [];
  const result = await post(
    "/accounts/reactivate",
    { label: "LFF1" },
    new MemoryAccountStore([account("LFF1", "funded", "passed")]),
    rearmed,
  );

  assert.equal(result.ok, true);
  assert.deepEqual(rearmed, ["funded"]);
});
