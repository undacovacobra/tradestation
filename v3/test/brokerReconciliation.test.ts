import assert from "node:assert/strict";
import test from "node:test";

import {
  brokerStatusLabel,
  decideCloseAction,
  tradeFingerprint,
} from "../src/brokerTradePolicy.js";

test("only a verified nonzero broker position requests an Exit click", () => {
  assert.equal(decideCloseAction({ status: "open", netPosition: 2, checkedAt: "now" }, false), "request-exit");
  assert.equal(decideCloseAction({ status: "flat", checkedAt: "now" }, false), "wait-for-confirmation");
  assert.equal(decideCloseAction({ status: "unknown", reason: "missing", checkedAt: "now" }, false), "wait-for-confirmation");
  assert.equal(decideCloseAction({ status: "open", netPosition: 2, checkedAt: "now" }, true), "already-requested");
});

test("trade fingerprints distinguish successive trades on the same account", () => {
  const base = {
    tradovateLabel: "E1",
    accountName: "Eval 1",
    symbol: "MNQ",
    action: "buy" as const,
    openedAt: "2026-07-15T13:00:00.000Z",
  };
  assert.equal(tradeFingerprint(base), "E1|MNQ|2026-07-15T13:00:00.000Z");
  assert.notEqual(tradeFingerprint(base), tradeFingerprint({ ...base, openedAt: "2026-07-15T14:00:00.000Z" }));
});

test("broker status labels expose signed positions without guessing unknown state", () => {
  assert.equal(brokerStatusLabel({ status: "open", netPosition: 3, checkedAt: "now" }), "OPEN +3");
  assert.equal(brokerStatusLabel({ status: "open", netPosition: -2, checkedAt: "now" }), "OPEN -2");
  assert.equal(brokerStatusLabel({ status: "flat", checkedAt: "now" }, 1), "FLAT CHECK 1/2");
  assert.equal(brokerStatusLabel({ status: "flat", checkedAt: "now" }, 2), "FLAT");
  assert.equal(brokerStatusLabel({ status: "unknown", reason: "missing", checkedAt: "now" }), "UNKNOWN");
});
