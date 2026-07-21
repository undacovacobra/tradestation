import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { PRIMARY_LOGIN_ID, SettingsStore } from "../src/store.js";
import type { Group, StoredAccount } from "../src/types.js";

function account(label: string, group: Group, atmPreset: string): StoredAccount {
  return {
    tradovateLabel: label,
    name: label,
    group,
    enabled: true,
    status: "active",
    atmPreset,
    loginId: PRIMARY_LOGIN_ID,
    firm: "Primary prop firm",
  };
}

function tempPath(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "store-"));
  return {
    path: join(dir, "settings.json"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("new accounts receive their group ATM default", () => {
  const { path, cleanup } = tempPath();
  try {
    const store = new SettingsStore(path);
    assert.equal(store.upsertAccount("LFE1", "evals").atmPreset, "25");
    assert.equal(store.upsertAccount("LFF1", "funded").atmPreset, "funded");
  } finally {
    cleanup();
  }
});

test("legacy blank presets migrate once without overwriting custom presets", () => {
  const { path, cleanup } = tempPath();
  try {
    writeFileSync(
      path,
      JSON.stringify({
        accounts: [
          { ...account("LFE1", "evals", ""), loginId: undefined, firm: undefined },
          { ...account("LFF1", "funded", "   "), loginId: undefined, firm: undefined },
          { ...account("LFE2", "evals", "50"), loginId: undefined, firm: undefined },
        ],
      }),
    );

    const store = new SettingsStore(path);
    assert.equal(store.find("LFE1")?.atmPreset, "25");
    assert.equal(store.find("LFF1")?.atmPreset, "funded");
    assert.equal(store.find("LFE2")?.atmPreset, "50");
    assert.equal(store.logins.length, 1);
    assert.equal(store.logins[0]?.id, PRIMARY_LOGIN_ID);
    assert.equal(store.find("LFE1")?.loginId, PRIMARY_LOGIN_ID);
    assert.equal(store.find("LFE1")?.firm, "Primary prop firm");
    assert.equal(JSON.parse(readFileSync(path, "utf8")).atmDefaultsVersion, 1);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).multiLoginVersion, 1);

    store.setAtmPreset("LFE1", "");
    assert.equal(new SettingsStore(path).find("LFE1")?.atmPreset, "");
  } finally {
    cleanup();
  }
});

test("login ids and browser session directories are unique", () => {
  const { path, cleanup } = tempPath();
  try {
    const store = new SettingsStore(path);
    const first = store.addLogin("Apex Eval", "Apex");
    const second = store.addLogin("Apex Eval", "Apex");
    assert.equal(first.id, "apex-eval");
    assert.equal(second.id, "apex-eval-2");
    assert.equal(first.autoConnect, true);
    assert.notEqual(first.sessionDir, second.sessionDir);
    assert.throws(
      () => store.addLogin("Duplicate session", "Apex", { sessionDir: first.sessionDir }),
      /session directory.*already/i,
    );
  } finally {
    cleanup();
  }
});

test("account assignment follows the selected login and its firm", () => {
  const { path, cleanup } = tempPath();
  try {
    const store = new SettingsStore(path);
    const login = store.addLogin("TakeProfit Funded", "TakeProfit Trader");
    const account = store.upsertAccount("TPF1", "funded", undefined, login.id);
    assert.equal(account.atmPreset, "funded");
    assert.equal(account.loginId, login.id);
    assert.equal(account.firm, "TakeProfit Trader");

    assert.equal(store.assignAccountLogin("TPF1", PRIMARY_LOGIN_ID), true);
    assert.equal(store.find("TPF1")?.loginId, PRIMARY_LOGIN_ID);
    assert.equal(store.find("TPF1")?.firm, "Primary prop firm");
  } finally {
    cleanup();
  }
});

test("a login referenced by an account cannot be removed", () => {
  const { path, cleanup } = tempPath();
  try {
    const store = new SettingsStore(path);
    const login = store.addLogin("Eval window", "Apex");
    store.upsertAccount("E1", "evals", undefined, login.id);
    assert.throws(() => store.removeLogin(login.id), /still has accounts/i);
    store.removeAccount("E1");
    assert.equal(store.removeLogin(login.id), true);
  } finally {
    cleanup();
  }
});

test("legacy settings gain credential-lane migration state without changing ATM values", () => {
  const { path, cleanup } = tempPath();
  try {
    writeFileSync(path, JSON.stringify({
      accounts: [
        { ...account("E1", "evals", "custom-eval"), loginId: undefined, firm: undefined },
        { ...account("F1", "funded", "custom-funded"), loginId: undefined, firm: undefined },
      ],
    }));

    const store = new SettingsStore(path);
    assert.equal(store.find("E1")?.atmPreset, "custom-eval");
    assert.equal(store.find("F1")?.atmPreset, "custom-funded");
    assert.equal(store.credentialLaneVersion, 1);
    assert.equal(store.mode, "practice");
    assert.equal(store.running, false);
    assert.deepEqual(store.credentialLanes().map((lane) => lane.key), [
      `${PRIMARY_LOGIN_ID}:evals`,
      `${PRIMARY_LOGIN_ID}:funded`,
      `${PRIMARY_LOGIN_ID}:winning`,
    ]);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).credentialLaneVersion, 1);
  } finally {
    cleanup();
  }
});

test("credential ids reserve global webhook names", () => {
  const { path, cleanup } = tempPath();
  try {
    const store = new SettingsStore(path);
    assert.equal(store.addLogin("Evals", "Firm").id, "evals-credential");
    assert.equal(store.addLogin("Funded", "Firm").id, "funded-credential");
  } finally { cleanup(); }
});

test("legacy reserved credential ids migrate without losing account ownership", () => {
  const { path, cleanup } = tempPath();
  try {
    writeFileSync(path, JSON.stringify({
      mode: "practice",
      running: false,
      atmDefaultsVersion: 1,
      multiLoginVersion: 1,
      credentialLaneVersion: 1,
      logins: [{ id: "evals", name: "Evals", firm: "Firm", platform: "tradovate", sessionDir: ".sessions/evals", enabled: true, autoConnect: false }],
      accounts: [{ ...account("E1", "evals", "25"), loginId: "evals", firm: "Firm" }],
    }));
    const oldState = join(dirname(path), "state-evals-evals.json");
    writeFileSync(oldState, JSON.stringify({ nextLabel: "E1", openTrade: null, lastWonDay: {}, history: [] }));
    const store = new SettingsStore(path);
    assert.equal(store.logins[0]?.id, "evals-credential");
    assert.equal(store.find("E1")?.loginId, "evals-credential");
    assert.equal(existsSync(join(dirname(path), "state-evals-credential-evals.json")), true);
  } finally { cleanup(); }
});

test("account ordering moves only within one credential lane", () => {
  const { path, cleanup } = tempPath();
  try {
    const store = new SettingsStore(path);
    const extra = store.addLogin("Other", "Firm");
    store.upsertAccount("P1", "evals");
    store.upsertAccount("O1", "evals", undefined, extra.id);
    store.upsertAccount("P2", "evals");
    assert.equal(store.moveAccount("P2", "up"), true);
    assert.deepEqual(store.accounts.map((item) => item.tradovateLabel), ["P2", "O1", "P1"]);
  } finally { cleanup(); }
});

test("credential lanes are derived for each enabled saved login", () => {
  const { path, cleanup } = tempPath();
  try {
    const store = new SettingsStore(path);
    const extra = store.addLogin("Second Prop", "Second Firm");
    assert.deepEqual(store.credentialLanes().map((lane) => lane.key), [
      `${PRIMARY_LOGIN_ID}:evals`,
      `${PRIMARY_LOGIN_ID}:funded`,
      `${PRIMARY_LOGIN_ID}:winning`,
      `${extra.id}:evals`,
      `${extra.id}:funded`,
      `${extra.id}:winning`,
    ]);
  } finally {
    cleanup();
  }
});
