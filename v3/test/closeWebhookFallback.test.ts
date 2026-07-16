import assert from "node:assert/strict";
import test from "node:test";

import { CloseWebhookFallback } from "../src/closeWebhookFallback.js";

const unknown = () => ({ status: "unknown" as const, reason: "reader unavailable", checkedAt: "now" });
const open = () => ({ status: "open" as const, netPosition: 1, checkedAt: "now" });
const flat = () => ({ status: "flat" as const, checkedAt: "now" });

test("close webhook fallback requires matching fingerprint, five seconds, and two unknown reads", () => {
  const fallback = new CloseWebhookFallback({ graceMs: 5_000, minUnknownReads: 2 });
  fallback.record("primary:evals", "trade-1", 1_000);

  assert.equal(fallback.observe("primary:evals", "trade-2", unknown(), 3, 7_000), "none");
  assert.equal(fallback.observe("primary:evals", "trade-1", unknown(), 1, 7_000), "waiting");
  assert.equal(fallback.observe("primary:evals", "trade-1", unknown(), 2, 5_999), "waiting");
  assert.equal(fallback.observe("primary:evals", "trade-1", unknown(), 2, 6_000), "eligible");
});

test("explicit broker-open evidence vetoes fallback and starts a fresh grace window", () => {
  const fallback = new CloseWebhookFallback({ graceMs: 5_000, minUnknownReads: 2 });
  fallback.record("primary:funded", "trade", 1_000);

  assert.equal(fallback.observe("primary:funded", "trade", open(), 0, 7_000), "vetoed");
  assert.equal(fallback.observe("primary:funded", "trade", unknown(), 2, 11_999), "waiting");
  assert.equal(fallback.observe("primary:funded", "trade", unknown(), 2, 12_000), "eligible");
  assert.equal(fallback.observe("primary:funded", "trade", flat(), 0, 12_000), "waiting");
});

test("new close evidence replaces old fingerprints and clear removes eligibility", () => {
  const fallback = new CloseWebhookFallback({ graceMs: 5_000, minUnknownReads: 2 });
  fallback.record("primary:evals", "trade-1", 1_000);
  fallback.record("primary:evals", "trade-2", 2_000);

  assert.equal(fallback.observe("primary:evals", "trade-1", unknown(), 4, 9_000), "none");
  assert.equal(fallback.observe("primary:evals", "trade-2", unknown(), 2, 7_000), "eligible");
  fallback.clear("primary:evals");
  assert.equal(fallback.observe("primary:evals", "trade-2", unknown(), 3, 8_000), "none");
});
