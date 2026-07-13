import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GroupRotation } from "../src/rotation.js";
import type { OrderRequest, StoredAccount } from "../src/types.js";

const order: OrderRequest = { action: "buy", symbol: "MNQ1!" };

function acct(label: string): StoredAccount {
  return { tradovateLabel: label, name: label, group: "evals", enabled: true, status: "active", targetPerContract: 0, stopPerContract: 0 };
}

/** A rotation with a FIXED trading day so win-bench tests are deterministic. */
function makeRot(path: string, bench = false, group: "evals" | "funded" = "evals", day = "2026-07-04"): GroupRotation {
  return new GroupRotation(group, path, bench, () => day);
}

function tempPath(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "rotation-"));
  return { path: join(dir, "state.json"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("cycles accounts in order and wraps around", () => {
  const { path, cleanup } = tempPath();
  try {
    const rot = makeRot(path);
    const accounts = [acct("A"), acct("B"), acct("C")];
    for (const expected of ["A", "B", "C", "A"]) {
      const choice = rot.selectAccountForEntry(accounts);
      assert.ok("account" in choice);
      assert.equal(choice.account.tradovateLabel, expected);
      rot.recordOpen(choice.account, order);
      rot.recordClose(accounts);
    }
  } finally {
    cleanup();
  }
});

test("refuses a second entry while a trade is open", () => {
  const { path, cleanup } = tempPath();
  try {
    const rot = makeRot(path);
    const accounts = [acct("A"), acct("B")];
    const first = rot.selectAccountForEntry(accounts);
    assert.ok("account" in first);
    rot.recordOpen(first.account, order);
    const second = rot.selectAccountForEntry(accounts);
    assert.ok("error" in second, "second entry must be rejected while open");
  } finally {
    cleanup();
  }
});

test("state survives a restart (persisted to disk)", () => {
  const { path, cleanup } = tempPath();
  try {
    const rot1 = makeRot(path);
    const accounts = [acct("A"), acct("B")];
    const c1 = rot1.selectAccountForEntry(accounts);
    assert.ok("account" in c1);
    rot1.recordOpen(c1.account, order);
    rot1.recordClose(accounts);

    const rot2 = makeRot(path); // "restart"
    const c2 = rot2.selectAccountForEntry(accounts);
    assert.ok("account" in c2);
    assert.equal(c2.account.tradovateLabel, "B");
  } finally {
    cleanup();
  }
});

test("handles the next account being removed", () => {
  const { path, cleanup } = tempPath();
  try {
    const rot = makeRot(path);
    let accounts = [acct("A"), acct("B"), acct("C")];
    const c1 = rot.selectAccountForEntry(accounts);
    assert.ok("account" in c1);
    rot.recordOpen(c1.account, order);
    rot.recordClose(accounts); // next would be B

    accounts = [acct("A"), acct("C")]; // user removed B on the dashboard
    const c2 = rot.selectAccountForEntry(accounts);
    assert.ok("account" in c2);
    assert.equal(c2.account.tradovateLabel, "A", "falls back to top of list when next was removed");
  } finally {
    cleanup();
  }
});

test("closing works even if the traded account was removed mid-trade", () => {
  const { path, cleanup } = tempPath();
  try {
    const rot = makeRot(path);
    const accounts = [acct("A"), acct("B")];
    const c1 = rot.selectAccountForEntry(accounts);
    assert.ok("account" in c1);
    rot.recordOpen(c1.account, order);

    const after = [acct("B")]; // A was removed while its trade was open
    const { closed, next } = rot.recordClose(after);
    assert.equal(closed.tradovateLabel, "A");
    assert.equal(next?.tradovateLabel, "B");
  } finally {
    cleanup();
  }
});

test("empty group gives a friendly error", () => {
  const { path, cleanup } = tempPath();
  try {
    const rot = makeRot(path, false, "funded");
    const choice = rot.selectAccountForEntry([]);
    assert.ok("error" in choice);
    assert.match(choice.error, /no accounts/i);
  } finally {
    cleanup();
  }
});

test("setNext manually chooses the next account (only when flat)", () => {
  const { path, cleanup } = tempPath();
  try {
    const rot = makeRot(path);
    const accounts = [acct("A"), acct("B"), acct("C")];
    assert.equal(rot.setNext("C", accounts), true);
    const c = rot.selectAccountForEntry(accounts);
    assert.ok("account" in c);
    assert.equal(c.account.tradovateLabel, "C");

    rot.recordOpen(c.account, order);
    assert.equal(rot.setNext("A", accounts), false, "can't change next while a trade is open");
  } finally {
    cleanup();
  }
});

test("a winner (exit balance above entry) is benched for the rest of the day", () => {
  const { path, cleanup } = tempPath();
  try {
    const rot = makeRot(path, true); // bench winners
    const accounts = [acct("A"), acct("B")];

    // A wins (50000 -> 50500) -> benched for the day.
    const c1 = rot.selectAccountForEntry(accounts);
    assert.ok("account" in c1 && c1.account.tradovateLabel === "A");
    rot.recordOpen(c1.account, order, 50_000);
    const r1 = rot.recordClose(accounts, { exitBalance: 50_500 });
    assert.equal(r1.won, true);
    assert.equal(rot.isBenchedToday("A"), true);

    // Next entry must skip A and land on B.
    const c2 = rot.selectAccountForEntry(accounts);
    assert.ok("account" in c2);
    assert.equal(c2.account.tradovateLabel, "B", "benched winner A is skipped");
  } finally {
    cleanup();
  }
});

test("a loser keeps cycling (not benched)", () => {
  const { path, cleanup } = tempPath();
  try {
    const rot = makeRot(path, true);
    const accounts = [acct("A"), acct("B")];
    const c1 = rot.selectAccountForEntry(accounts);
    assert.ok("account" in c1);
    rot.recordOpen(c1.account, order, 50_000);
    const r1 = rot.recordClose(accounts, { exitBalance: 49_800 }); // lost
    assert.equal(r1.won, false);
    assert.equal(rot.isBenchedToday("A"), false, "a loser is not benched");
  } finally {
    cleanup();
  }
});

test("when every account has won today, entry returns a resting error", () => {
  const { path, cleanup } = tempPath();
  try {
    const rot = makeRot(path, true);
    const accounts = [acct("A"), acct("B")];
    for (const _ of accounts) {
      const c = rot.selectAccountForEntry(accounts);
      assert.ok("account" in c);
      rot.recordOpen(c.account, order, 50_000);
      rot.recordClose(accounts, { exitBalance: 50_100 }); // both win
    }
    const blocked = rot.selectAccountForEntry(accounts);
    assert.ok("error" in blocked);
    assert.match(blocked.error, /rest/i);
  } finally {
    cleanup();
  }
});

test("resetOpenTrade clears a stuck trade and advances, without logging it", () => {
  const { path, cleanup } = tempPath();
  try {
    const rot = makeRot(path);
    const accounts = [acct("A"), acct("B"), acct("C")];
    const c1 = rot.selectAccountForEntry(accounts);
    assert.ok("account" in c1 && c1.account.tradovateLabel === "A");
    rot.recordOpen(c1.account, order);
    assert.equal(rot.isFlat, false);

    const { was, next } = rot.resetOpenTrade(accounts);
    assert.equal(was?.tradovateLabel, "A");
    assert.equal(next?.tradovateLabel, "B", "advances to the next account");
    assert.equal(rot.isFlat, true, "no longer thinks a trade is open");
    assert.equal(rot.todaysHistory().length, 0, "a manual reset is not logged as a trade");

    // And the next real entry goes to B.
    const c2 = rot.selectAccountForEntry(accounts);
    assert.ok("account" in c2);
    assert.equal(c2.account.tradovateLabel, "B");
  } finally {
    cleanup();
  }
});

test("logs contracts + result per trade in today's history", () => {
  const { path, cleanup } = tempPath();
  try {
    const rot = makeRot(path);
    const accounts = [acct("A"), acct("B")];

    const c1 = rot.selectAccountForEntry(accounts);
    assert.ok("account" in c1);
    rot.recordOpen(c1.account, { action: "buy", symbol: "MNQ1!", quantity: 3 }, 50_000);
    rot.recordClose(accounts, { exitBalance: 50_400 }); // win, +400

    const c2 = rot.selectAccountForEntry(accounts);
    assert.ok("account" in c2);
    rot.recordOpen(c2.account, { action: "sell", symbol: "MNQ1!", quantity: 2 }, 50_000);
    rot.recordClose(accounts, { exitBalance: 49_800 }); // loss, -200

    const log = rot.todaysHistory();
    assert.equal(log.length, 2);
    // newest first: the 2-contract loss, then the 3-contract win
    const [loss, win] = log;
    assert.equal(loss!.quantity, 2);
    assert.equal(loss!.won, false);
    assert.equal(loss!.pnl, -200);
    assert.equal(win!.quantity, 3);
    assert.equal(win!.won, true);
    assert.equal(win!.pnl, 400);
  } finally {
    cleanup();
  }
});

test("clearRest takes a benched winner off rest so it can trade again today", () => {
  const { path, cleanup } = tempPath();
  try {
    const rot = makeRot(path, true);
    const accounts = [acct("A"), acct("B")];
    const c1 = rot.selectAccountForEntry(accounts);
    assert.ok("account" in c1 && c1.account.tradovateLabel === "A");
    rot.recordOpen(c1.account, order, 50_000);
    rot.recordClose(accounts, { exitBalance: 50_500 }); // A wins -> benched
    assert.equal(rot.isBenchedToday("A"), true);

    assert.equal(rot.clearRest("A"), true, "un-rest reports success");
    assert.equal(rot.isBenchedToday("A"), false, "A is no longer resting");
    assert.equal(rot.clearRest("A"), false, "un-resting an account that isn't resting is a no-op");
  } finally {
    cleanup();
  }
});

test("bench is ignored when benchWinnersForDay is off", () => {
  const { path, cleanup } = tempPath();
  try {
    const rot = makeRot(path, false); // OFF
    const accounts = [acct("A"), acct("B")];
    const c1 = rot.selectAccountForEntry(accounts);
    assert.ok("account" in c1);
    rot.recordOpen(c1.account, order, 50_000);
    rot.recordClose(accounts, { exitBalance: 99_000 }); // big win
    assert.equal(rot.isBenchedToday("A"), false, "no benching when the feature is off");
  } finally {
    cleanup();
  }
});
