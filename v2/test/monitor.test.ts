import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractEquity } from "../src/balanceParse.js";
import { Monitor } from "../src/monitor.js";
import { SettingsStore } from "../src/store.js";
import { GroupRotation } from "../src/rotation.js";
import type { Group } from "../src/types.js";

// ---------------------------------------------------------------------------
// Balance parsing
// ---------------------------------------------------------------------------

test("extractEquity reads the top-bar EQUITY, not the account id or OPEN P/L", () => {
  // The real top bar, as seen on the user's screen.
  assert.equal(
    extractEquity("ACCOUNT LFE05079261220007 EQUITY 50,320.00 USD OPEN P/L 0.00 USD"),
    50320,
  );
  assert.equal(extractEquity("ACCOUNT LFE05079261220006 EQUITY 49,502.50 USD OPEN P/L 0.00 USD"), 49502.5);
  assert.equal(extractEquity("EQUITY $53,105.75 USD"), 53105.75);
  assert.equal(extractEquity("EQUITY -120.50 USD"), -120.5);
  assert.equal(extractEquity("no numbers here"), null);
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
  let selected: { label: string; balance: number | null } | null = null;
  const monitor = new Monitor({
    store,
    rotations,
    isBrowserReady: () => true,
    readSelected: async () => selected,
    readAccount: async (label) => (selected && selected.label === label ? selected : { label, balance: null }),
    readAll: async () => [],
    forceClose: async (group, reason) => {
      closed.push(`${group}:${reason}`);
      // Mirror what the real forceClose does to rotation state.
      if (!rotations[group].isFlat) rotations[group].recordClose(store.accountsIn(group));
    },
    balancesPath: join(dir, "balances.json"),
    intervalSeconds: 3600,
    activeIntervalSeconds: 5,
  });
  return {
    dir,
    store,
    rotations,
    monitor,
    closed,
    setSelected: (r: { label: string; balance: number | null } | null) => (selected = r),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
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

test("live sweep reads the selected account and force-closes at the target", async () => {
  const w = makeWorld();
  try {
    w.store.upsertAccount("LFE111111", "evals");
    const choice = w.rotations.evals.selectAccountForEntry(w.store.accountsIn("evals"));
    assert.ok("account" in choice);
    w.rotations.evals.recordOpen(choice.account, { action: "buy", symbol: "MNQ1!", quantity: 1, orderType: "market" });

    // Top bar now shows this account over target; a live sweep should act.
    w.setSelected({ label: "LFE111111", balance: 53_010.25 });
    await w.monitor.sweep(); // anyTradeOpen -> sweepLiveAccount -> readSelected

    assert.equal(w.closed.length, 1, "the live trade must be force-closed");
    assert.equal(w.rotations.evals.isFlat, true);
    assert.equal(w.store.find("LFE111111")?.status, "passed");
    assert.equal(w.monitor.balanceOf("LFE111111"), 53_010.25);
  } finally {
    w.cleanup();
  }
});

test("live sweep leaves an under-target open trade alone", async () => {
  const w = makeWorld();
  try {
    w.store.upsertAccount("LFE111111", "evals");
    const choice = w.rotations.evals.selectAccountForEntry(w.store.accountsIn("evals"));
    assert.ok("account" in choice);
    w.rotations.evals.recordOpen(choice.account, { action: "buy", symbol: "MNQ1!", quantity: 1, orderType: "market" });

    w.setSelected({ label: "LFE111111", balance: 52_400 });
    await w.monitor.sweep();

    assert.equal(w.closed.length, 0, "under target -> trade stays open");
    assert.equal(w.rotations.evals.isFlat, false);
    assert.equal(w.store.find("LFE111111")?.status, "active");
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

test("scanIngest records balances immediately without touching rotation/target", async () => {
  const w = makeWorld();
  try {
    w.store.upsertAccount("LFE111111", "evals");
    // A scan of an account already over target should still just record the
    // balance — retiring is the periodic sweep's job, not the scan's.
    w.monitor.scanIngest([{ label: "LFE111111", balance: 53_500 }]);
    assert.equal(w.monitor.balanceOf("LFE111111"), 53_500);
    assert.equal(w.store.find("LFE111111")?.status, "active");
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
