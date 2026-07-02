import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GroupRotation } from "../src/rotation.js";
import type { OrderRequest, StoredAccount } from "../src/types.js";

const order: OrderRequest = { action: "buy", symbol: "MNQ1!", quantity: 1, orderType: "market" };

function acct(label: string): StoredAccount {
  return { tradovateLabel: label, name: label, group: "evals", enabled: true, status: "active" };
}

function tempPath(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "rotation-"));
  return { path: join(dir, "state.json"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("cycles accounts in order and wraps around", () => {
  const { path, cleanup } = tempPath();
  try {
    const rot = new GroupRotation("evals", path, false);
    const accounts = [acct("A"), acct("B"), acct("C")];
    for (const expected of ["A", "B", "C", "A"]) {
      const choice = rot.selectAccountForEntry(accounts);
      assert.ok("account" in choice, "should pick an account");
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
    const rot = new GroupRotation("evals", path, false);
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

test("accounts that all won today have none available", () => {
  const { path, cleanup } = tempPath();
  try {
    const rot = new GroupRotation("evals", path, true, () => "2026-01-01");
    const accounts = [acct("A"), acct("B")];
    // Both accounts WIN their first trade -> both benched for the day.
    for (const expected of ["A", "B"]) {
      const choice = rot.selectAccountForEntry(accounts);
      assert.ok("account" in choice);
      assert.equal(choice.account.tradovateLabel, expected);
      rot.recordOpen(choice.account, order, 50_000);
      rot.recordClose(accounts, { exitBalance: 50_250 }); // +250 = win
    }
    const third = rot.selectAccountForEntry(accounts);
    assert.ok("error" in third, "both accounts won today -> none available");
  } finally {
    cleanup();
  }
});

test("a LOSING account stays in the cycle; a WINNER is benched for the day", () => {
  const { path, cleanup } = tempPath();
  try {
    const rot = new GroupRotation("evals", path, true, () => "2026-01-01");
    const accounts = [acct("A"), acct("B")];

    // A trades and LOSES -> stays available.
    let choice = rot.selectAccountForEntry(accounts);
    assert.ok("account" in choice && choice.account.tradovateLabel === "A");
    rot.recordOpen(choice.account, order, 50_000);
    const r1 = rot.recordClose(accounts, { exitBalance: 49_800 }); // -200 = loss
    assert.equal(r1.won, false);

    // B trades and WINS -> benched.
    choice = rot.selectAccountForEntry(accounts);
    assert.ok("account" in choice && choice.account.tradovateLabel === "B");
    rot.recordOpen(choice.account, order, 50_000);
    const r2 = rot.recordClose(accounts, { exitBalance: 50_400 }); // +400 = win
    assert.equal(r2.won, true);

    // Next selection: B is resting, so it must be A again (the loser cycles on).
    const next = rot.selectAccountForEntry(accounts);
    assert.ok("account" in next);
    assert.equal(next.account.tradovateLabel, "A", "loser A keeps cycling; winner B rests");
    assert.equal(rot.isBenchedToday("B"), true);
    assert.equal(rot.isBenchedToday("A"), false);
  } finally {
    cleanup();
  }
});

test("an explicit won flag benches even without balance numbers", () => {
  const { path, cleanup } = tempPath();
  try {
    const rot = new GroupRotation("evals", path, true, () => "2026-01-01");
    const accounts = [acct("A"), acct("B")];
    const choice = rot.selectAccountForEntry(accounts);
    assert.ok("account" in choice);
    rot.recordOpen(choice.account, order);
    rot.recordClose(accounts, { won: true }); // e.g. profit-target force close
    assert.equal(rot.isBenchedToday("A"), true);
  } finally {
    cleanup();
  }
});

test("state survives a restart (persisted to disk)", () => {
  const { path, cleanup } = tempPath();
  try {
    const rot1 = new GroupRotation("evals", path, false);
    const accounts = [acct("A"), acct("B")];
    const c1 = rot1.selectAccountForEntry(accounts);
    assert.ok("account" in c1);
    rot1.recordOpen(c1.account, order);
    rot1.recordClose(accounts);

    const rot2 = new GroupRotation("evals", path, false); // "restart"
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
    const rot = new GroupRotation("evals", path, false);
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
    const rot = new GroupRotation("evals", path, false);
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
    const rot = new GroupRotation("funded", path, false);
    const choice = rot.selectAccountForEntry([]);
    assert.ok("error" in choice);
    assert.match(choice.error, /no accounts/i);
  } finally {
    cleanup();
  }
});
