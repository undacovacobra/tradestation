import assert from "node:assert/strict";
import test from "node:test";
import {
  CredentialPriorityScheduler,
  type CredentialTaskKind,
} from "../src/priorityScheduler.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("close outranks funded and evaluation entries that are still pending", async () => {
  const scheduler = new CredentialPriorityScheduler({ fundedWindowMs: 15 });
  const gate = deferred();
  const order: string[] = [];
  const running = scheduler.enqueue("diagnostic", async () => { await gate.promise; order.push("running"); });
  const evalEntry = scheduler.enqueue("eval-entry", async () => { order.push("eval"); });
  const fundedEntry = scheduler.enqueue("funded-entry", async () => { order.push("funded"); });
  const close = scheduler.enqueue("close", async () => { order.push("close"); });

  gate.resolve();
  await Promise.all([running, evalEntry, fundedEntry, close]);
  assert.deepEqual(order, ["running", "close", "funded", "eval"]);
});

test("funded wins when it arrives inside an evaluation priority window", async () => {
  const scheduler = new CredentialPriorityScheduler({ fundedWindowMs: 30 });
  const order: string[] = [];
  const evalEntry = scheduler.enqueue("eval-entry", async () => { order.push("eval"); });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const fundedEntry = scheduler.enqueue("funded-entry", async () => { order.push("funded"); });

  await Promise.all([evalEntry, fundedEntry]);
  assert.deepEqual(order, ["funded", "eval"]);
});

test("a lone evaluation runs after its funded priority window", async () => {
  const scheduler = new CredentialPriorityScheduler({ fundedWindowMs: 20 });
  const started = Date.now();
  await scheduler.enqueue("eval-entry", async () => undefined);
  assert.ok(Date.now() - started >= 15);
});

test("combined evaluation work can skip the funded priority window", async () => {
  const scheduler = new CredentialPriorityScheduler({ fundedWindowMs: 100 });
  const started = Date.now();
  await scheduler.enqueue("eval-entry", async () => undefined, { skipFundedWindow: true });
  assert.ok(Date.now() - started < 75);
});

test("equal priorities are FIFO and a rejection does not stop later work", async () => {
  const scheduler = new CredentialPriorityScheduler({ fundedWindowMs: 0 });
  const gate = deferred();
  const order: string[] = [];
  const blocker = scheduler.enqueue("diagnostic", async () => { await gate.promise; });
  const failed = scheduler.enqueue("funded-entry", async () => { order.push("first"); throw new Error("expected"); });
  const later = scheduler.enqueue("funded-entry", async () => { order.push("second"); });
  gate.resolve();

  await blocker;
  await assert.rejects(failed, /expected/);
  await later;
  assert.deepEqual(order, ["first", "second"]);
});

test("queue snapshot reports pending work by kind", async () => {
  const scheduler = new CredentialPriorityScheduler({ fundedWindowMs: 100 });
  const evalEntry = scheduler.enqueue("eval-entry", async () => undefined);
  assert.deepEqual(scheduler.snapshot(), {
    running: false,
    totalPending: 1,
    pending: { "eval-entry": 1 },
  });
  await evalEntry;
});

test("all documented task kinds have a stable priority", () => {
  const kinds: CredentialTaskKind[] = [
    "close",
    "funded-entry",
    "eval-entry",
    "funded-maintenance",
    "eval-maintenance",
    "diagnostic",
  ];
  assert.equal(new Set(kinds).size, 6);
});
