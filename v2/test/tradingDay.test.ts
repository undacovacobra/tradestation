import { test } from "node:test";
import assert from "node:assert/strict";
import { tradingDayKey } from "../src/tradingDay.js";

const ET = "America/New_York";

test("6pm ET is the boundary: 5:59pm is today, 6:00pm is the next trading day", () => {
  // January -> EST (UTC-5). 22:59 UTC = 17:59 ET (5:59pm).
  assert.equal(tradingDayKey(new Date("2026-01-15T22:59:00Z"), ET, 18), "2026-01-15");
  // 23:00 UTC = 18:00 ET (6:00pm) -> rolls to the next trading day.
  assert.equal(tradingDayKey(new Date("2026-01-15T23:00:00Z"), ET, 18), "2026-01-16");
});

test("morning and early afternoon belong to the day that started at 6pm prior", () => {
  // 2026-01-16 14:00 UTC = 09:00 ET -> still the 16th trading day.
  assert.equal(tradingDayKey(new Date("2026-01-16T14:00:00Z"), ET, 18), "2026-01-16");
  // 2026-01-16 21:00 UTC = 16:00 ET (4pm) -> still the 16th.
  assert.equal(tradingDayKey(new Date("2026-01-16T21:00:00Z"), ET, 18), "2026-01-16");
});

test("honors daylight time (EDT, UTC-4) — 6pm still boundary", () => {
  // July -> EDT (UTC-4). 21:59 UTC = 17:59 EDT (5:59pm) -> same day.
  assert.equal(tradingDayKey(new Date("2026-07-15T21:59:00Z"), ET, 18), "2026-07-15");
  // 22:00 UTC = 18:00 EDT (6:00pm) -> next trading day.
  assert.equal(tradingDayKey(new Date("2026-07-15T22:00:00Z"), ET, 18), "2026-07-16");
});

test("Central option rolls an hour later in UTC terms", () => {
  const CT = "America/Chicago";
  // 2026-01-15 23:59 UTC = 17:59 CT -> same day; 00:00 UTC (6:00pm CT) -> next.
  assert.equal(tradingDayKey(new Date("2026-01-15T23:59:00Z"), CT, 18), "2026-01-15");
  assert.equal(tradingDayKey(new Date("2026-01-16T00:00:00Z"), CT, 18), "2026-01-16");
});
