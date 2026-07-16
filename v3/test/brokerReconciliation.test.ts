import assert from "node:assert/strict";
import test from "node:test";

import {
  brokerStatusLabel,
  closeIdentityError,
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

test("close identity rejects stale trade ids and different symbols", () => {
  const open = {
    tradovateLabel: "E1",
    accountName: "Eval 1",
    symbol: "MNQ1!",
    action: "buy" as const,
    tradeId: "trade-7",
    openedAt: "2026-07-15T13:00:00.000Z",
  };
  assert.equal(closeIdentityError(open, { symbol: " mnq1! ", tradeId: "trade-7" }), null);
  assert.match(closeIdentityError(open, { symbol: "MES1!", tradeId: "trade-7" }) ?? "", /symbol/i);
  assert.match(closeIdentityError(open, { symbol: "MNQ1!", tradeId: "older" }) ?? "", /trade id/i);
  assert.equal(closeIdentityError(open, { symbol: "MNQ1!" }), null, "legacy alerts without a trade id remain compatible");
});
