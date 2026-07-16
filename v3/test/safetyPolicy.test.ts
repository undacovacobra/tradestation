import test from "node:test";
import assert from "node:assert/strict";

import { assertSafeBrowserDisconnect, assertSafeModeTransition, assertSafeManualReset } from "../src/safetyPolicy.js";

test("live exposure blocks switching to practice and disconnecting the owning browser", () => {
  assert.throws(() => assertSafeModeTransition("live", "practice", true), /open live trade/i);
  assert.throws(() => assertSafeBrowserDisconnect(true), /open live trade/i);
});

test("flat sessions may change mode or disconnect", () => {
  assert.doesNotThrow(() => assertSafeModeTransition("live", "practice", false));
  assert.doesNotThrow(() => assertSafeModeTransition("practice", "live", false));
  assert.doesNotThrow(() => assertSafeBrowserDisconnect(false));
});

test("manual reset requires broker-flat proof", () => {
  assert.throws(() => assertSafeManualReset("open"), /broker.*open/i);
  assert.throws(() => assertSafeManualReset("unknown"), /cannot verify/i);
  assert.doesNotThrow(() => assertSafeManualReset("flat"));
});
