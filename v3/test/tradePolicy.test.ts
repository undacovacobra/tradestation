import assert from "node:assert/strict";
import test from "node:test";
import { shouldRetireAtBalance, usesEvaluationTarget } from "../src/tradePolicy.js";

test("only evaluation accounts use the evaluation balance target", () => {
  assert.equal(usesEvaluationTarget("evals"), true);
  assert.equal(usesEvaluationTarget("funded"), false);
});

test("arming retires only an evaluation account already at target", () => {
  assert.equal(shouldRetireAtBalance("evals", 53_000, 53_000), true);
  assert.equal(shouldRetireAtBalance("evals", 52_999, 53_000), false);
  assert.equal(shouldRetireAtBalance("funded", 100_000, 53_000), false);
});
