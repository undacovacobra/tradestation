import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SignalLedger } from "../src/signalLedger.js";

test("completed webhook signals remain idempotent after restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "atlas-signals-"));
  const path = join(dir, "signals.json");
  try {
    const first = new SignalLedger(path);
    first.mark("apex:evals:trade-7:entry", 60_000, 1_000);
    const second = new SignalLedger(path);
    assert.equal(second.has("apex:evals:trade-7:entry", 2_000), true);
    assert.equal(second.has("apex:evals:trade-7:entry", 62_000), false);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {});
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("corrupt signal state fails closed instead of forgetting duplicate protection", () => {
  const dir = mkdtempSync(join(tmpdir(), "atlas-signals-"));
  const path = join(dir, "signals.json");
  try {
    writeFileSync(path, "not json");
    assert.throws(() => new SignalLedger(path), /could not be read safely/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
