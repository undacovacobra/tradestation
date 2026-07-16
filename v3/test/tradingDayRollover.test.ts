import assert from "node:assert/strict";
import test from "node:test";
import { TradingDayRollover } from "../src/tradingDayRollover.js";

test("the 6pm futures-day rollover fires exactly once for a changed key", () => {
  let day = "2026-07-16";
  const rollover = new TradingDayRollover(() => day);
  assert.equal(rollover.check(), false);
  day = "2026-07-17";
  assert.equal(rollover.check(), true);
  assert.equal(rollover.check(), false);
  assert.equal(rollover.current, "2026-07-17");
});
