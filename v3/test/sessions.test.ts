import assert from "node:assert/strict";
import test from "node:test";
import type { BrokerPosition } from "../src/brokerPosition.js";
import { LoginManager, LoginWorker, TradovateSessionAdapter, type TradingSessionAdapter } from "../src/sessions.js";
import type { Group, OrderRequest, SavedLogin, StoredAccount } from "../src/types.js";

let active = 0;
let maxActive = 0;

class FakeAdapter implements TradingSessionAdapter {
  connected = true;
  loggedIn = true;
  selectedAccount: string | null = null;
  calls: string[] = [];
  delayMs = 0;
  orderDelayMs = 0;
  failPreset = false;
  atmPreset = "";
  quantity: number | undefined;
  verificationAllowed = true;
  repairSucceeds = true;
  visibleAccount: string | undefined;
  visibleAtmPreset: string | undefined;
  activeVerificationAllowed = true;
  activeVerificationResults: boolean[] = [];
  position: BrokerPosition = { status: "flat", checkedAt: "now" };

  status() { return { connected: this.connected, loggedIn: this.loggedIn, selectedAccount: this.selectedAccount }; }
  async connect() { this.connected = true; this.loggedIn = true; }
  async recover() { this.connected = true; this.loggedIn = true; }
  async resumeExistingLogin() { this.calls.push("resume-login"); this.connected = true; this.loggedIn = true; }
  async disconnect() { this.connected = false; this.loggedIn = false; }
  async discoverAccounts() { return ["E1", "F1"]; }
  async armFor(label: string) { this.calls.push(`arm:${label}`); this.selectedAccount = label; }
  async readSelectedEquity() { this.calls.push("equity"); return 50_000; }
  async readSelectedPosition() { this.calls.push("position"); return this.position; }
  async selectAtmPreset(name: string) {
    this.calls.push(`atm:${name}`);
    if (this.failPreset) throw new Error("preset missing");
    this.atmPreset = name;
  }
  async setQuantity(quantity: number, force = false) {
    this.calls.push(`qty:${quantity}${force ? ":force" : ""}`);
    this.quantity = quantity;
  }
  async repairPreparedOrderState(group: Group, label: string, atmPreset: string, quantity?: number) {
    this.calls.push(`repair:${group}:${label}:${atmPreset}${quantity == null ? "" : `:${quantity}`}`);
    if (!this.repairSucceeds) return;
    this.selectedAccount = label;
    this.atmPreset = atmPreset;
    this.visibleAccount = label;
    this.visibleAtmPreset = atmPreset;
    if (quantity != null) this.quantity = quantity;
  }
  async clickOrder(action: "buy" | "sell", label: string) {
    this.calls.push(`order:${action}:${label}`);
    if (this.orderDelayMs) await new Promise((resolve) => setTimeout(resolve, this.orderDelayMs));
  }
  async clickExit(label: string) { this.calls.push(`exit:${label}`); }
  async readSettledEquity() { this.calls.push("settled"); return 50_100; }
  async dismissPopups() { this.calls.push("popups"); return false; }
  async refreshLoginState() { return this.loggedIn; }
  async verifyActiveAccount(label: string) {
    const allowed = this.activeVerificationResults.length
      ? this.activeVerificationResults.shift()!
      : this.activeVerificationAllowed && this.selectedAccount === label;
    if (!allowed) this.selectedAccount = null;
    return allowed;
  }
  async verifyPreparedOrderState(_group: Group, label: string, atmPreset: string, quantity?: number) {
    return this.verificationAllowed
      && (this.visibleAccount ?? this.selectedAccount) === label
      && (this.visibleAtmPreset ?? this.atmPreset) === atmPreset
      && (quantity == null || this.quantity === quantity);
  }
  async verifyExitState(_group: Group, label: string) { return this.verificationAllowed && this.selectedAccount === label; }
  async work(name: string) {
    this.calls.push(`start:${name}`);
    active++;
    maxActive = Math.max(maxActive, active);
    if (this.delayMs) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    active--;
    this.calls.push(`end:${name}`);
  }
}

class DualFakeAdapter extends FakeAdapter {
  laneAccounts = { evals: "E0", funded: "F0" };
  laneAtm = { evals: "25", funded: "funded" };
  laneQty = { evals: 1, funded: 1 };

  async inspectCapabilities() { return { mode: "dual-ticket" as const, reason: "fixture proved independent" }; }
  async armForLane(group: Group, label: string) { this.calls.push(`lane-arm:${group}:${label}`); this.laneAccounts[group] = label; }
  async readLaneEquity(group: Group) { this.calls.push(`lane-equity:${group}`); return 50_000; }
  async readLanePosition(group: Group) { this.calls.push(`lane-position:${group}`); return this.position; }
  async selectLaneAtmPreset(group: Group, name: string) { this.calls.push(`lane-atm:${group}:${name}`); this.laneAtm[group] = name; }
  async setLaneQuantity(group: Group, quantity: number) { this.calls.push(`lane-qty:${group}:${quantity}`); this.laneQty[group] = quantity; }
  async clickLaneOrder(group: Group, action: "buy" | "sell", label: string) { this.calls.push(`lane-order:${group}:${action}:${label}`); }
  async clickLaneExit(group: Group, label: string) { this.calls.push(`lane-exit:${group}:${label}`); }
  async verifyLaneAccount(group: Group, label: string) { return this.laneAccounts[group] === label; }
  override async verifyPreparedOrderState(group: Group, label: string, atmPreset: string, quantity?: number) {
    return this.laneAccounts[group] === label && this.laneAtm[group] === atmPreset && (quantity == null || this.laneQty[group] === quantity);
  }
  override async verifyExitState(group: Group, label: string) { return this.laneAccounts[group] === label; }
}

function login(id: string): SavedLogin {
  return { id, name: id, firm: "Firm", platform: "tradovate", sessionDir: `.sessions/${id}`, enabled: true, autoConnect: false };
}

function account(label: string, group: Group, loginId: string): StoredAccount {
  return {
    tradovateLabel: label,
    name: label,
    group,
    enabled: true,
    status: "active",
    atmPreset: group === "evals" ? "25" : "funded",
    loginId,
    firm: "Firm",
  };
}

const callbacks = {
  onBalance() {},
  onPresetError() {},
};

test("one login serializes maintenance tasks", async () => {
  active = 0; maxActive = 0;
  const adapter = new FakeAdapter();
  adapter.delayMs = 20;
  const worker = new LoginWorker(login("one"), adapter);
  await Promise.all([
    worker.runMaintenance(() => adapter.work("a")),
    worker.runMaintenance(() => adapter.work("b")),
  ]);
  assert.equal(maxActive, 1);
  assert.deepEqual(adapter.calls, ["start:a", "end:a", "start:b", "end:b"]);
});

test("different login workers run concurrently", async () => {
  active = 0; maxActive = 0;
  const a = new FakeAdapter();
  const b = new FakeAdapter();
  a.delayMs = 25; b.delayMs = 25;
  const manager = new LoginManager([login("a"), login("b")], (definition) => definition.id === "a" ? a : b);
  await Promise.all([
    manager.get("a")!.runMaintenance(() => a.work("a")),
    manager.get("b")!.runMaintenance(() => b.work("b")),
  ]);
  assert.equal(maxActive, 2);
});

test("preparing records the exact group account and ATM", async () => {
  const adapter = new FakeAdapter();
  const worker = new LoginWorker(login("one"), adapter);
  const acct = account("E1", "evals", "one");
  await worker.prepare("evals", acct, callbacks);
  assert.equal(worker.isReady("evals", acct), true);
  assert.deepEqual(adapter.calls, ["arm:E1", "equity", "atm:25"]);
  assert.deepEqual(worker.status().ready && {
    group: worker.status().ready?.group,
    accountLabel: worker.status().ready?.accountLabel,
    atmPreset: worker.status().ready?.atmPreset,
  }, { group: "evals", accountLabel: "E1", atmPreset: "25" });
});

test("a sequential session remembers both lane plans while only the selected lane is physically ready", async () => {
  const adapter = new FakeAdapter();
  const worker = new LoginWorker(login("one"), adapter);
  const evalAccount = account("E1", "evals", "one");
  const fundedAccount = account("F1", "funded", "one");
  await worker.prepare("evals", evalAccount, callbacks);
  await worker.prepare("funded", fundedAccount, callbacks);
  assert.equal(worker.isReady("evals", evalAccount), false);
  assert.equal(worker.isReady("funded", fundedAccount), true);
  assert.deepEqual(Object.keys(worker.status().readyByStage ?? {}).sort(), ["evals", "funded"]);
  assert.equal(worker.status().executionMode, "sequential");
});

test("a failed ATM selection never marks the session ready", async () => {
  const adapter = new FakeAdapter();
  adapter.failPreset = true;
  const worker = new LoginWorker(login("one"), adapter);
  await assert.rejects(() => worker.prepare("evals", account("E1", "evals", "one"), callbacks), /preset missing/i);
  assert.equal(worker.status().ready, undefined);
});

test("unplanned live entry self-prepares and queues safely behind credential work", async () => {
  const adapter = new FakeAdapter();
  const worker = new LoginWorker(login("one"), adapter);
  const acct = account("E1", "evals", "one");
  const order: OrderRequest = { action: "buy", symbol: "MNQ", quantity: 2 };
  adapter.delayMs = 30;
  const maintenance = worker.runMaintenance(() => adapter.work("maintenance"));
  const entry = worker.enterPrepared("evals", acct, order, { skipFundedWindow: true });
  await Promise.all([maintenance, entry]);
  assert.deepEqual(adapter.calls, [
    "start:maintenance",
    "end:maintenance",
    "arm:E1",
    "equity",
    "atm:25",
    "qty:2:force",
    "order:buy:E1",
  ]);
});

test("prepared entry only sets quantity and clicks, then consumes readiness", async () => {
  const adapter = new FakeAdapter();
  const worker = new LoginWorker(login("one"), adapter);
  const acct = account("E1", "evals", "one");
  await worker.prepare("evals", acct, callbacks);
  adapter.calls.length = 0;
  const timing = await worker.enterPrepared("evals", acct, { action: "sell", symbol: "MNQ", quantity: 3 });
  assert.deepEqual(adapter.calls, ["qty:3:force", "order:sell:E1"]);
  assert.equal(worker.status().ready, undefined);
  assert.ok(timing.totalMs >= 0);
});

test("final broker verification blocks an entry if account, ATM, or quantity drifted", async () => {
  const adapter = new FakeAdapter();
  const worker = new LoginWorker(login("one"), adapter);
  const acct = account("E1", "evals", "one");
  await worker.prepare("evals", acct, callbacks);
  adapter.calls.length = 0;
  adapter.verificationAllowed = false;
  await assert.rejects(
    () => worker.enterPrepared("evals", acct, { action: "buy", symbol: "MNQ", quantity: 2 }, { skipFundedWindow: true }),
    /Final broker verification failed/i,
  );
  assert.equal(adapter.calls.some((call) => call.startsWith("order:")), false);
});

test("prepared entry is blocked if the exact login is no longer connected and logged in", async () => {
  const adapter = new FakeAdapter();
  const worker = new LoginWorker(login("one"), adapter);
  const acct = account("E1", "evals", "one");
  await worker.prepare("evals", acct, callbacks);
  adapter.calls.length = 0;
  adapter.loggedIn = false;

  assert.equal(worker.isReady("evals", acct), false);

  await assert.rejects(
    () => worker.enterPrepared("evals", acct, { action: "buy", symbol: "MNQ" }),
    /connected and logged in/i,
  );
  assert.equal(adapter.calls.some((call) => call.startsWith("order:")), false);
});

test("a prepare queued behind entry cannot switch the session after the order opens", async () => {
  const adapter = new FakeAdapter();
  const worker = new LoginWorker(login("one"), adapter);
  const evalAccount = account("E1", "evals", "one");
  const fundedAccount = account("F1", "funded", "one");
  await worker.prepare("evals", evalAccount, callbacks);
  adapter.calls.length = 0;
  adapter.orderDelayMs = 20;

  const entry = worker.enterPrepared("evals", evalAccount, { action: "buy", symbol: "MNQ" }, { skipFundedWindow: true });
  const queuedPrepare = worker.prepare("funded", fundedAccount, callbacks, true);
  await entry;
  await assert.rejects(queuedPrepare, /open trade/i);

  assert.equal(adapter.selectedAccount, "E1");
  assert.equal(adapter.calls.includes("arm:F1"), false);
});

test("safe quantity test never clicks an order and preserves readiness", async () => {
  const adapter = new FakeAdapter();
  const worker = new LoginWorker(login("one"), adapter);
  const acct = account("E1", "evals", "one");
  await worker.prepare("evals", acct, callbacks);
  adapter.calls.length = 0;
  await worker.testPreparedQuantity("evals", acct, 4);
  assert.deepEqual(adapter.calls, ["qty:4:force"]);
  assert.equal(worker.isReady("evals", acct), true);
});

test("dashboard quantity diagnostic also forces the visible value", async () => {
  const adapter = new FakeAdapter();
  const worker = new LoginWorker(login("one"), adapter);

  await worker.testQuantity(6);

  assert.deepEqual(adapter.calls, ["qty:6:force"]);
  assert.equal(adapter.calls.some((call) => call.startsWith("order:")), false);
});

test("open-trade safety can verify the broker still shows the expected account", async () => {
  const adapter = new FakeAdapter();
  const worker = new LoginWorker(login("one"), adapter);
  adapter.selectedAccount = "E1";
  assert.equal(await worker.verifyActiveAccount("E1"), true);
  adapter.selectedAccount = "F1";
  assert.equal(await worker.verifyActiveAccount("E1"), false);
});

test("click-only login recovery is allowed while the worker retains an open-trade lease", async () => {
  const adapter = new FakeAdapter();
  const worker = new LoginWorker(login("one"), adapter);
  worker.restoreOpenTrade("funded", "F1");
  adapter.loggedIn = false;

  const status = await worker.resumeExistingLogin();

  assert.equal(status.loggedIn, true);
  assert.deepEqual(adapter.calls, ["resume-login"]);
  await assert.rejects(
    worker.prepare("evals", account("E1", "evals", "one"), callbacks),
    /open trade/i,
  );
});

test("a sequential position read switches read-only, verifies the exact account, and preserves signed quantity", async () => {
  const adapter = new FakeAdapter();
  adapter.selectedAccount = "E0";
  adapter.position = { status: "open", netPosition: -2, checkedAt: "now" };
  const worker = new LoginWorker(login("one"), adapter);
  worker.restoreOpenTrade("evals", "E1");

  const result = await worker.readLanePosition("evals", "E1");

  assert.deepEqual(result, { status: "open", netPosition: -2, checkedAt: "now" });
  assert.deepEqual(adapter.calls, ["arm:E1", "position"]);
});

test("webhook quantity is authoritative even when the ticket was already prepared", async () => {
  const adapter = new FakeAdapter();
  const worker = new LoginWorker(login("one"), adapter);
  const acct = account("E1", "evals", "one");
  await worker.prepare("evals", acct, callbacks);
  adapter.quantity = 3;
  adapter.calls.length = 0;

  await worker.enterPrepared("evals", acct, { action: "buy", symbol: "MNQ", quantity: 3 });

  assert.equal(adapter.calls.includes("qty:3:force"), true);
  assert.equal(adapter.calls.at(-1), "order:buy:E1");
});

test("entry repairs manual account and ATM drift before placing", async () => {
  const adapter = new FakeAdapter();
  const worker = new LoginWorker(login("one"), adapter);
  const acct = account("F1", "funded", "one");
  await worker.prepare("funded", acct, callbacks);
  adapter.visibleAccount = "E1";
  adapter.visibleAtmPreset = "25";
  adapter.calls.length = 0;

  await worker.enterPrepared("funded", acct, { action: "sell", symbol: "MNQ", quantity: 4 });

  assert.deepEqual(adapter.calls, [
    "repair:funded:F1:funded",
    "qty:4:force",
    "order:sell:F1",
  ]);
});

test("eval signal self-prepares after a restored funded trade is manually flattened", async () => {
  const adapter = new FakeAdapter();
  const worker = new LoginWorker(login("one"), adapter);
  const evalAccount = account("E1", "evals", "one");

  // Exact production sequence: startup restored a funded trade, so no lanes
  // were prepared; account-specific flatten then left the funded ticket visible.
  worker.restoreOpenTrade("funded", "F1");
  adapter.selectedAccount = "F1";
  adapter.atmPreset = "funded";
  worker.clearOpenTrade("F1");
  adapter.calls.length = 0;

  await worker.enterPrepared(
    "evals",
    evalAccount,
    { action: "buy", symbol: "MNQ", quantity: 2 },
    { skipFundedWindow: true },
  );

  assert.deepEqual(adapter.calls, [
    "arm:E1",
    "equity",
    "atm:25",
    "qty:2:force",
    "order:buy:E1",
  ]);
});

test("unplanned eval entry can self-prepare while a funded account remains open", async () => {
  const adapter = new FakeAdapter();
  const worker = new LoginWorker(login("one"), adapter);
  const evalAccount = account("E1", "evals", "one");

  // ATLAS supports different accounts holding positions under one login. A
  // missing eval plan must use the guarded live-entry switch path, not the
  // background-preparation path that correctly refuses to switch open trades.
  worker.restoreOpenTrade("funded", "F1");
  adapter.selectedAccount = "F1";
  adapter.atmPreset = "funded";
  adapter.calls.length = 0;

  await worker.enterPrepared(
    "evals",
    evalAccount,
    { action: "buy", symbol: "MNQ", quantity: 3 },
    { skipFundedWindow: true },
  );

  assert.deepEqual(adapter.calls, [
    "arm:E1",
    "equity",
    "atm:25",
    "qty:3:force",
    "order:buy:E1",
  ]);
});

test("failed unplanned ATM preparation reports the error and never clicks an order", async () => {
  const adapter = new FakeAdapter();
  adapter.failPreset = true;
  const worker = new LoginWorker(login("one"), adapter);
  const presetErrors: string[] = [];
  const balances: Array<[string, number]> = [];

  await assert.rejects(
    worker.enterPrepared(
      "evals",
      account("E1", "evals", "one"),
      { action: "buy", symbol: "MNQ", quantity: 2 },
      {
        skipFundedWindow: true,
        prepareIfNeeded: {
          onBalance: (label, equity) => balances.push([label, equity]),
          onPresetError: (error) => presetErrors.push(error.message),
        },
      },
    ),
    /preset missing/i,
  );

  assert.deepEqual(balances, [["E1", 50_000]]);
  assert.deepEqual(presetErrors, ["preset missing"]);
  assert.equal(adapter.calls.some((call) => call.startsWith("order:")), false);
});

test("failed automatic ticket repair blocks the order", async () => {
  const adapter = new FakeAdapter();
  const worker = new LoginWorker(login("one"), adapter);
  const acct = account("F1", "funded", "one");
  await worker.prepare("funded", acct, callbacks);
  adapter.visibleAccount = "E1";
  adapter.visibleAtmPreset = "25";
  adapter.repairSucceeds = false;
  adapter.calls.length = 0;

  await assert.rejects(
    () => worker.enterPrepared("funded", acct, { action: "buy", symbol: "MNQ", quantity: 2 }),
    /verification failed|repair/i,
  );
  assert.equal(adapter.calls.some((call) => call.startsWith("repair:funded:F1:funded")), true);
  assert.equal(adapter.calls.some((call) => call.startsWith("order:")), false);
});

test("a lane snapshot force-reselects stale cached account state and reads position plus equity once", async () => {
  const adapter = new FakeAdapter();
  adapter.selectedAccount = "E1";
  adapter.activeVerificationResults = [false, true];
  adapter.position = { status: "open", netPosition: 3, checkedAt: "position-time" };
  const worker = new LoginWorker(login("one"), adapter);

  const result = await worker.readLaneSnapshot("evals", "E1");

  assert.equal(result.verifiedAccount, true);
  assert.deepEqual(result.position, { status: "open", netPosition: 3, checkedAt: "position-time" });
  assert.equal(result.equity, 50_000);
  assert.deepEqual(adapter.calls, ["arm:E1", "position", "equity"]);
});

test("an unverified lane snapshot never reads position or equity from the wrong account", async () => {
  const adapter = new FakeAdapter();
  adapter.selectedAccount = "OTHER";
  adapter.activeVerificationAllowed = false;
  const worker = new LoginWorker(login("one"), adapter);

  const result = await worker.readLaneSnapshot("funded", "F1");

  assert.equal(result.verifiedAccount, false);
  assert.equal(result.position.status, "unknown");
  assert.equal(result.equity, null);
  assert.deepEqual(adapter.calls, ["arm:F1"]);
});

test("an unverified account position read fails safe without reading a different account", async () => {
  const adapter = new FakeAdapter();
  adapter.selectedAccount = "OTHER";
  adapter.activeVerificationAllowed = false;
  const worker = new LoginWorker(login("one"), adapter);

  const result = await worker.readLanePosition("funded", "F1");

  assert.equal(result.status, "unknown");
  if (result.status === "unknown") assert.match(result.reason, /verify/i);
  assert.deepEqual(adapter.calls, ["arm:F1"]);
});

test("reading flat does not clear a restored open-trade lease; explicit clearing is idempotent", async () => {
  const adapter = new FakeAdapter();
  adapter.selectedAccount = "E1";
  adapter.position = { status: "flat", checkedAt: "now" };
  const worker = new LoginWorker(login("one"), adapter);
  worker.restoreOpenTrade("evals", "E1");

  assert.equal((await worker.readLanePosition("evals", "E1")).status, "flat");
  await assert.rejects(
    worker.prepare("funded", account("F1", "funded", "one"), callbacks),
    /open trade/i,
  );

  worker.clearOpenTrade("E1");
  worker.clearOpenTrade("E1");
  await worker.prepare("funded", account("F1", "funded", "one"), callbacks);
  assert.equal(adapter.selectedAccount, "F1");
});

test("manager creates exactly one adapter and worker for each credential", () => {
  let factoryCalls = 0;
  const definitions = [login("one"), login("two")];
  const manager = new LoginManager(definitions, () => { factoryCalls++; return new FakeAdapter(); });
  assert.equal(factoryCalls, 2);
  assert.equal(manager.values().length, 2);
  assert.equal(manager.get("one"), manager.get("one"));
});

test("sequential fallback prepares a remembered nonphysical lane on its execution path", async () => {
  const adapter = new FakeAdapter();
  const worker = new LoginWorker(login("one"), adapter);
  const evalAccount = account("E1", "evals", "one");
  const fundedAccount = account("F1", "funded", "one");
  await worker.prepare("evals", evalAccount, callbacks);
  await worker.prepare("funded", fundedAccount, callbacks);
  adapter.calls.length = 0;

  await worker.enterPrepared("evals", evalAccount, { action: "buy", symbol: "MNQ", quantity: 3 }, { skipFundedWindow: true });
  assert.deepEqual(adapter.calls, ["arm:E1", "equity", "atm:25", "qty:3:force", "order:buy:E1"]);
});

test("close work overtakes pending funded and eval maintenance on one credential", async () => {
  const adapter = new FakeAdapter();
  adapter.selectedAccount = "F1";
  adapter.delayMs = 25;
  const worker = new LoginWorker(login("one"), adapter);
  const running = worker.runMaintenance(() => adapter.work("running"));
  const evalWork = worker.runMaintenance(() => adapter.work("eval-maint"), "evals");
  const fundedWork = worker.runMaintenance(() => adapter.work("funded-maint"), "funded");
  const close = worker.close("funded", "F1");
  await Promise.all([running, evalWork, fundedWork, close]);
  assert.deepEqual(adapter.calls, [
    "start:running", "end:running",
    "exit:F1",
    "start:funded-maint", "end:funded-maint",
    "start:eval-maint", "end:eval-maint",
  ]);
});

test("a close signal cancels an evaluation entry still inside the funded-priority window", async () => {
  const adapter = new FakeAdapter();
  const worker = new LoginWorker(login("one"), adapter, { fundedPriorityWindowMs: 100 });
  const acct = account("E1", "evals", "one");
  await worker.prepare("evals", acct, callbacks);
  adapter.calls.length = 0;
  const entry = worker.enterPrepared("evals", acct, { action: "buy", symbol: "MNQ", quantity: 1 });
  worker.cancelPendingEntry("evals");
  await assert.rejects(entry, /cancelled because a close signal/i);
  assert.equal(adapter.calls.some((call) => call.startsWith("order:")), false);
});

test("final broker verification blocks Exit on the wrong account", async () => {
  const adapter = new FakeAdapter();
  adapter.selectedAccount = "OTHER";
  adapter.verificationAllowed = false;
  const worker = new LoginWorker(login("one"), adapter);
  await assert.rejects(() => worker.close("funded", "F1"), /Final broker verification failed before Exit/i);
  assert.equal(adapter.calls.includes("exit:F1"), false);
});

test("sequential close switches to and verifies a non-selected open lane", async () => {
  const adapter = new FakeAdapter();
  const worker = new LoginWorker(login("one"), adapter);
  const evalAccount = account("E1", "evals", "one");
  const fundedAccount = account("F1", "funded", "one");
  await worker.prepare("evals", evalAccount, callbacks);
  await worker.prepare("funded", fundedAccount, callbacks);
  await worker.enterPrepared("evals", evalAccount, { action: "buy", symbol: "MNQ", quantity: 1 }, { skipFundedWindow: true });
  await worker.enterPrepared("funded", fundedAccount, { action: "buy", symbol: "MNQ", quantity: 1 });
  assert.equal(adapter.selectedAccount, "F1");
  adapter.calls.length = 0;
  await worker.close("evals", "E1");
  assert.deepEqual(adapter.calls, ["arm:E1", "exit:E1"]);
});

test("an Exit click keeps the open-trade lease until broker-flat reconciliation clears it", async () => {
  const adapter = new FakeAdapter();
  adapter.selectedAccount = "E1";
  const worker = new LoginWorker(login("one"), adapter);
  worker.restoreOpenTrade("evals", "E1");

  await worker.close("evals", "E1");
  await assert.rejects(
    worker.prepare("funded", account("F1", "funded", "one"), callbacks),
    /open trade/i,
  );

  worker.clearOpenTrade("E1");
  await worker.prepare("funded", account("F1", "funded", "one"), callbacks);
  assert.equal(adapter.selectedAccount, "F1");
});

test("production adapter uses one authoritative sequential mode after a dual probe", async () => {
  const calls: string[] = [];
  // Construct without launching Chromium so the adapter boundary itself is
  // tested against a deterministic browser double.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adapter: any = Object.create(TradovateSessionAdapter.prototype);
  adapter.browser = {
    inspectCapabilities: async () => ({ mode: "dual-ticket", reason: "fixture proved it" }),
    verifySequentialPreparedOrderState: async () => { calls.push("verify-sequential-entry"); return true; },
    verifySequentialExitState: async () => { calls.push("verify-sequential-exit"); return true; },
    verifyPreparedOrderState: async () => { calls.push("verify-dual-entry"); return true; },
    verifyExitState: async () => { calls.push("verify-dual-exit"); return true; },
  };
  assert.equal((await adapter.inspectCapabilities()).mode, "sequential");
  assert.equal(await adapter.verifyPreparedOrderState("funded", "F1", "funded", 2), false);
  assert.equal(await adapter.verifyExitState("funded", "F1"), false);
  assert.deepEqual(calls, [], "a downgraded independent-ticket screen must fail closed before any click");
});

test("a proven dual-ticket session keeps both lanes ready and executes funded first", async () => {
  const adapter = new DualFakeAdapter();
  const worker = new LoginWorker(login("one"), adapter);
  const evalAccount = account("E1", "evals", "one");
  const fundedAccount = account("F1", "funded", "one");
  await worker.prepare("evals", evalAccount, callbacks);
  await worker.prepare("funded", fundedAccount, callbacks);

  assert.equal(worker.status().executionMode, "dual-ticket");
  assert.equal(worker.isReady("evals", evalAccount), true);
  assert.equal(worker.isReady("funded", fundedAccount), true);
  adapter.calls.length = 0;

  const evalEntry = worker.enterPrepared("evals", evalAccount, { action: "buy", symbol: "MNQ", quantity: 2 });
  const fundedEntry = worker.enterPrepared("funded", fundedAccount, { action: "sell", symbol: "MNQ", quantity: 3 });
  await Promise.all([evalEntry, fundedEntry]);

  assert.deepEqual(adapter.calls, [
    "lane-qty:funded:3",
    "lane-order:funded:sell:F1",
    "lane-qty:evals:2",
    "lane-order:evals:buy:E1",
  ]);
});
