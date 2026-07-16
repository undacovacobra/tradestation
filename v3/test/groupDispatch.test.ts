import assert from "node:assert/strict";
import test from "node:test";
import { GroupDispatcher } from "../src/groupDispatch.js";

let active = 0;
let maxActive = 0;

async function tracked<T>(value: T, delayMs = 20): Promise<T> {
  active++;
  maxActive = Math.max(maxActive, active);
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  active--;
  return value;
}

test("tasks within one group serialize", async () => {
  active = 0; maxActive = 0;
  const dispatcher = new GroupDispatcher();
  await Promise.all([
    dispatcher.enqueue("evals", () => tracked("a")),
    dispatcher.enqueue("evals", () => tracked("b")),
  ]);
  assert.equal(maxActive, 1);
});

test("evaluation and funded groups run concurrently", async () => {
  active = 0; maxActive = 0;
  const dispatcher = new GroupDispatcher();
  await Promise.all([
    dispatcher.enqueue("evals", () => tracked("evals")),
    dispatcher.enqueue("funded", () => tracked("funded")),
  ]);
  assert.equal(maxActive, 2);
});

test("broadcast deduplicates groups and preserves partial results", async () => {
  const dispatcher = new GroupDispatcher();
  const calls: string[] = [];
  const results = await dispatcher.dispatchMany(["evals", "funded", "evals"], async (group) => {
    calls.push(group);
    if (group === "funded") throw new Error("funded not ready");
    return `${group} ok`;
  });
  assert.deepEqual(calls.sort(), ["evals", "funded"]);
  assert.deepEqual(results, [
    { ok: true, group: "evals", value: "evals ok" },
    { ok: false, group: "funded", error: "funded not ready" },
  ]);
});

test("credential lanes serialize independently while different lane keys overlap", async () => {
  active = 0; maxActive = 0;
  const dispatcher = new GroupDispatcher<`${string}:${"evals" | "funded"}`>();
  await Promise.all([
    dispatcher.enqueue("apex:evals", () => tracked("apex eval")),
    dispatcher.enqueue("other:evals", () => tracked("other eval")),
  ]);
  assert.equal(maxActive, 2);
});
