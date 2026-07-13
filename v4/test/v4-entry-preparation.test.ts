import assert from "node:assert/strict";
import test from "node:test";
import { prepareEntry } from "../src/workers.js";
import type { AccountDefinition, V4Alert } from "../src/models.js";

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
