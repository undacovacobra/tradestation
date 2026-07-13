import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { PoolRotation } from "../src/poolRotation.js";
import type { AccountDefinition, V4Alert } from "../src/models.js";

const accounts: AccountDefinition[] = [
  { id: "a1", name: "Eval 1", firm: "Firm", stage: "eval", connectionId: "c1", platformLabel: "ANY-LABEL-1", enabled: true, status: "active", tags: [] },
  { id: "a2", name: "Funded 1", firm: "Other Firm", stage: "funded", connectionId: "c2", platformLabel: "NO_PREFIX_REQUIRED", enabled: true, status: "active", tags: [] },
];
const entry: V4Alert = { action: "buy", symbol: "MNQ", quantity: 1, test: false };

test("rotation uses explicit account ids and does not depend on account letters", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "v4-rotation-"));
  const rotation = new PoolRotation("mixed", resolve(dir, "state.json"), true, () => "2026-07-10");
  const first = rotation.select(accounts, new Set());
  assert.equal(first.id, "a1");
  rotation.recordOpen(first, entry, true);
  rotation.recordClose(accounts, true);
  const second = rotation.select(accounts, new Set());
  assert.equal(second.id, "a2");
});

test("rotation skips accounts already reserved by another pool", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "v4-lock-"));
  const rotation = new PoolRotation("pool", resolve(dir, "state.json"), false, () => "2026-07-10");
  assert.equal(rotation.select(accounts, new Set(["a1"])).id, "a2");
});

test("account can be skipped for today, resumed, and automatically returns next trading day", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "v4-daily-skip-"));
  let day = "2026-07-10";
  const statePath = resolve(dir, "state.json");
  const rotation = new PoolRotation("pool", statePath, false, () => day);
  rotation.skipToday("a1", accounts);
  assert.equal(rotation.isSkippedToday("a1"), true);
  assert.equal(rotation.select(accounts, new Set()).id, "a2");

  rotation.resumeToday("a1");
  assert.equal(rotation.isSkippedToday("a1"), false);
  assert.equal(rotation.select(accounts, new Set()).id, "a1");

  rotation.skipToday("a1", accounts);
  day = "2026-07-11";
  assert.equal(rotation.isSkippedToday("a1"), false);
  assert.equal(new PoolRotation("pool", statePath, false, () => day).select(accounts, new Set()).id, "a1");
});

test("a skipped account cannot be manually selected as next", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "v4-skipped-next-"));
  const rotation = new PoolRotation("pool", resolve(dir, "state.json"), false, () => "2026-07-10");
  rotation.skipToday("a1", accounts);
  assert.throws(() => rotation.setNext("a1", accounts), /skipped for today/i);
});
