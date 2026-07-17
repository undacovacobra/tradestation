import test from "node:test";
import assert from "node:assert/strict";
import { readWithFlatConfirmation } from "../src/brokerPositionConfirmation.js";
import { PositionReconciler } from "../src/positionReconciler.js";
import type { BrokerPosition } from "../src/brokerPosition.js";

const flat = (): BrokerPosition => ({ status: "flat", checkedAt: "now" });
const open = (): BrokerPosition => ({ status: "open", netPosition: 1, checkedAt: "now" });
const unknown = (): BrokerPosition => ({ status: "unknown", reason: "missing", checkedAt: "now" });

test("an explicit zero is confirmed by a second immediate broker read", async () => {
  const positions = [flat(), flat()];
  const reconciler = new PositionReconciler();
  let reads = 0;
  const result = await readWithFlatConfirmation(
    async () => positions[reads++]!,
    (position) => reconciler.observe("lane", "trade", position),
    0,
  );

  assert.equal(reads, 2);
  assert.equal(result.position.status, "flat");
  assert.equal(result.observation.kind, "confirmed-flat");
});

test("unknown and open readings do not trigger an unsafe confirmation read", async () => {
  for (const position of [unknown(), open()]) {
    const reconciler = new PositionReconciler();
    let reads = 0;
    const result = await readWithFlatConfirmation(
      async () => { reads++; return position; },
      (value) => reconciler.observe("lane", "trade", value),
      0,
    );
    assert.equal(reads, 1);
    assert.notEqual(result.observation.kind, "confirmed-flat");
  }
});

test("a position that reopens on the confirmation read remains open", async () => {
  const positions = [flat(), open()];
  const reconciler = new PositionReconciler();
  let reads = 0;
  const result = await readWithFlatConfirmation(
    async () => positions[reads++]!,
    (position) => reconciler.observe("lane", "trade", position),
    0,
  );

  assert.equal(reads, 2);
  assert.equal(result.position.status, "open");
  assert.equal(result.observation.kind, "open");
});
