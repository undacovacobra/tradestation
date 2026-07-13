import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractEquity } from "../src/balanceParse.js";
import { tradingDayKey } from "../src/tradingDay.js";
import { BalanceLog } from "../src/balances.js";

test("extractEquity reads the number right after EQUITY, not the id or P/L", () => {
  assert.equal(
    extractEquity("ACCOUNT LFE05079261220007 EQUITY 50,320.00 USD OPEN P/L 0.00 USD"),
    50_320,
  );
  assert.equal(extractEquity("EQUITY 53,000.00 USD"), 53_000);
  assert.equal(extractEquity("EQUITY $1,234.56"), 1_234.56);
  assert.equal(extractEquity(""), null);
});

test("extractEquity handles a negative equity", () => {
  assert.equal(extractEquity("EQUITY -1,200.00 USD"), -1_200);
});

test("tradingDayKey rolls the futures day at 6pm ET", () => {
  // 5:59pm ET is still the same trading day; 6:01pm ET belongs to the next.
  const before = tradingDayKey(new Date("2026-07-04T21:59:00Z"), "America/New_York", 18); // 17:59 ET
  const after = tradingDayKey(new Date("2026-07-04T22:01:00Z"), "America/New_York", 18); // 18:01 ET
  assert.equal(before, "2026-07-04");
  assert.equal(after, "2026-07-05");
});

test("BalanceLog stores, reads instantly, and persists", () => {
  const dir = mkdtempSync(join(tmpdir(), "balances-"));
  try {
    const path = join(dir, "balances.json");
    const log = new BalanceLog(path);
    assert.equal(log.get("A"), null);
    log.set("A", 50_000);
    assert.equal(log.get("A"), 50_000);
    log.set("A", 50_250);
    assert.equal(log.get("A"), 50_250);

    const reloaded = new BalanceLog(path); // "restart"
    assert.equal(reloaded.get("A"), 50_250);
    assert.ok((reloaded.snapshot().A?.history.length ?? 0) >= 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("BalanceLog permanently removes an account and its history", () => {
  const dir = mkdtempSync(join(tmpdir(), "balances-remove-"));
  try {
    const path = join(dir, "balances.json");
    const log = new BalanceLog(path);
    log.set("deleted", 50_000);
    log.set("kept", 51_000);
    log.remove("deleted");
    assert.equal(log.get("deleted"), null);
    assert.equal(log.get("kept"), 51_000);
    assert.equal(new BalanceLog(path).snapshot().deleted, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
