import assert from "node:assert/strict";
import test from "node:test";

import { runLoginPositionCycles } from "../src/loginPositionCycle.js";

test("one login inspects funded before evaluations while different logins overlap", async () => {
  const calls: string[] = [];
  let active = 0;
  let maxActive = 0;
  const targets = [
    { loginId: "primary", stage: "evals" as const, label: "E1" },
    { loginId: "second", stage: "evals" as const, label: "E2" },
    { loginId: "primary", stage: "funded" as const, label: "F1" },
  ];

  const results = await runLoginPositionCycles(targets, async (target) => {
    calls.push(`start:${target.loginId}:${target.stage}`);
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 15));
    active--;
    calls.push(`end:${target.loginId}:${target.stage}`);
    return target.label;
  });

  const primaryCalls = calls.filter((call) => call.includes(":primary:"));
  assert.deepEqual(primaryCalls, [
    "start:primary:funded",
    "end:primary:funded",
    "start:primary:evals",
    "end:primary:evals",
  ]);
  assert.equal(maxActive, 2);
  assert.deepEqual(new Set(results), new Set(["F1", "E1", "E2"]));
});

test("an empty login cycle performs no inspection", async () => {
  let calls = 0;
  const results = await runLoginPositionCycles([], async () => {
    calls++;
    return "unexpected";
  });
  assert.equal(calls, 0);
  assert.deepEqual(results, []);
});
