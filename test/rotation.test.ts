import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountRotation } from "../src/rotation.js";
import type { AccountSpec, OrderRequest } from "../src/types.js";

const accounts: AccountSpec[] = [
  { name: "A1", tradovateLabel: "L1", enabled: true },
  { name: "A2", tradovateLabel: "L2", enabled: true },
  { name: "A3", tradovateLabel: "L3", enabled: true },
];

const order: OrderRequest = { action: "buy", symbol: "MNQ", quantity: 1, orderType: "market" };

function freshStatePath() {
  return join(mkdtempSync(join(tmpdir(), "rot-")), "state.json");
}

function open(r: AccountRotation) {
  const choice = r.selectAccountForEntry();
  if ("error" in choice) {
    assert.fail(`expected an eligible account, got: ${choice.error}`);
  }
  r.recordOpen(choice.index, order);
  return choice.account;
}

test("cycles through accounts after each completed round-trip", () => {
  const r = new AccountRotation(accounts, freshStatePath(), false);
  assert.equal(open(r).name, "A1");
  r.recordClose();
  assert.equal(open(r).name, "A2");
  r.recordClose();
  assert.equal(open(r).name, "A3");
  r.recordClose();
  // wraps back to the first account
  assert.equal(open(r).name, "A1");
});

test("rejects a second entry while a trade is open", () => {
  const r = new AccountRotation(accounts, freshStatePath(), false);
  open(r);
  const second = r.selectAccountForEntry();
  assert.ok("error" in second, "should refuse to open a second concurrent trade");
});

test("oncePerDay skips accounts already traded today, then exhausts", () => {
  let day = "2026-06-28";
  const r = new AccountRotation(accounts, freshStatePath(), true, () => day);

  assert.equal(open(r).name, "A1");
  r.recordClose();
  assert.equal(open(r).name, "A2");
  r.recordClose();
  assert.equal(open(r).name, "A3");
  r.recordClose();

  // all three used today -> no eligible account
  const exhausted = r.selectAccountForEntry();
  assert.ok("error" in exhausted, "all accounts traded today should be rejected");

  // next calendar day -> rotation resumes at A1
  day = "2026-06-29";
  assert.equal(open(r).name, "A1");
});

test("state persists across restarts", () => {
  const path = freshStatePath();
  const r1 = new AccountRotation(accounts, path, false);
  open(r1);
  r1.recordClose(); // now points at A2

  const r2 = new AccountRotation(accounts, path, false);
  assert.equal(open(r2).name, "A2", "restart should resume rotation where it left off");
});
