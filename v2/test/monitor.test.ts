import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractBalance, extractAccountBalances } from "../src/balanceParse.js";
import { Monitor } from "../src/monitor.js";
import { SettingsStore } from "../src/store.js";
import { GroupRotation } from "../src/rotation.js";
import type { Group } from "../src/types.js";

// ---------------------------------------------------------------------------
// Balance parsing
// ---------------------------------------------------------------------------

test("extractBalance finds money next to an account id, not the id itself", () => {
  assert.equal(extractBalance("Eval 1 LFE05079261220005 $50,123.45"), 50123.45);
  assert.equal(extractBalance("LFF05079261220001  52,900.00 USD"), 52900);
  assert.equal(extractBalance("LFE05079261220006 -$120.50"), -120.5);
  // A bare integer is ambiguous (could be anything) -> null
  assert.equal(extractBalance("LFE05079261220006 50000"), null);
  assert.equal(extractBalance("LFE05079261220006"), null);
});

test("extractAccountBalances dedupes labels and keeps the row with dollars", () => {
  const rows = [
    "LFE05079261220005", // top-bar hit, no balance
    "Eval 1 LFE05079261220005 $50,123.45", // menu row with balance
    "Funded 1 LFF05079261220001 $52,001.10",
  ];
  const out = extractAccountBalances(rows);
  assert.deepEqual(out, [
    { label: "LFE05079261220005", balance: 50123.45 },
    { label: "LFF05079261220001", balance: 52001.1 },
  ]);
});

// ---------------------------------------------------------------------------
// Monitor behavior (fed fake menu rows — no browser needed)
// ---------------------------------------------------------------------------

function makeWorld() {
  const dir = mkdtempSync(join(tmpdir(), "monitor-"));
  const store = new SettingsStore(join(dir, "settings.json"));
  const rotations: Record<Group, GroupRotation> = {
    evals: new GroupRotation("evals", join(dir, "state-evals.json"), false),
    funded: new GroupRotation("funded", join(dir, "state-funded.json"), false),
  };
  const closed: string[] = [];
  const monitor = new Monitor({
    store,
    rotations,
    isBrowserReady: () => true,
    readBalances: async () => [],
    forceClose: async (group, reason) => {
      closed.push(`${group}:${reason}`);
      // Mirror what the real forceClose does to rotation state.
      if (!rotations[group].isFlat) rotations[group].recordClose(store.accountsIn(group));
    },
    balancesPath: join(dir, "balances.json"),
    intervalSeconds: 3600,
  });
  return { dir, store, rotations, monitor, closed, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("auto-adds new accounts by prefix (LFE->evals, LFF->funded)", async () => {
  const w = makeWorld();
  try {
    await w.monitor.applyRows([
      { label: "LFE111111", balance: 50000.5 },
      { label: "LFF222222", balance: 51000.25 },
    ]);
    assert.equal(w.store.find("LFE111111")?.group, "evals");
    assert.equal(w.store.find("LFF222222")?.group, "funded");
    assert.equal(w.monitor.balanceOf("LFE111111"), 50000.5);
  } finally {
    w.cleanup();
  }
});

test("eval at/above target is retired to Passed and stops rotating", async () => {
  const w = makeWorld();
  try {
    w.store.upsertAccount("LFE111111", "evals");
    w.store.upsertAccount("LFE222222", "evals");
    await w.monitor.applyRows([
      { label: "LFE111111", balance: 53_000 },
      { label: "LFE222222", balance: 50_500 },
    ]);
    assert.equal(w.store.find("LFE111111")?.status, "passed");
    assert.equal(w.store.find("LFE222222")?.status, "active");
    assert.deepEqual(
      w.store.accountsIn("evals").map((a) => a.tradovateLabel),
      ["LFE222222"],
      "passed account must leave the rotation",
    );
    assert.equal(w.closed.length, 0, "no open trade -> nothing to force-close");
  } finally {
    w.cleanup();
  }
});

test("target hit WHILE its trade is open force-closes that trade", async () => {
  const w = makeWorld();
  try {
    w.store.upsertAccount("LFE111111", "evals");
    const choice = w.rotations.evals.selectAccountForEntry(w.store.accountsIn("evals"));
    assert.ok("account" in choice);
    w.rotations.evals.recordOpen(choice.account, { action: "buy", symbol: "MNQ1!", quantity: 2, orderType: "market" });

    await w.monitor.applyRows([{ label: "LFE111111", balance: 53_250.75 }]);

    assert.equal(w.closed.length, 1, "the open trade must be force-closed");
    assert.match(w.closed[0]!, /^evals:/);
    assert.equal(w.rotations.evals.isFlat, true);
    assert.equal(w.store.find("LFE111111")?.status, "passed");
  } finally {
    w.cleanup();
  }
});

test("funded accounts are never auto-retired by the eval target", async () => {
  const w = makeWorld();
  try {
    w.store.upsertAccount("LFF222222", "funded");
    await w.monitor.applyRows([{ label: "LFF222222", balance: 99_999 }]);
    assert.equal(w.store.find("LFF222222")?.status, "active");
  } finally {
    w.cleanup();
  }
});

test("balance history accumulates for the dashboard chart", async () => {
  const w = makeWorld();
  try {
    w.store.upsertAccount("LFE111111", "evals");
    await w.monitor.applyRows([{ label: "LFE111111", balance: 50_000 }]);
    await w.monitor.applyRows([{ label: "LFE111111", balance: 50_150 }]);
    const snap = w.monitor.snapshot()["LFE111111"]!;
    assert.equal(snap.balance, 50_150);
    assert.ok(snap.history.length >= 2);
  } finally {
    w.cleanup();
  }
});
