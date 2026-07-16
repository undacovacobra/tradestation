import assert from "node:assert/strict";
import test from "node:test";

import { PositionReconciler } from "../src/positionReconciler.js";

const open = (netPosition = 1) => ({ status: "open" as const, netPosition, checkedAt: "now" });
const flat = () => ({ status: "flat" as const, checkedAt: "now" });
const unknown = () => ({ status: "unknown" as const, reason: "ticket unavailable", checkedAt: "now" });

test("two consecutive flat readings are required and completion fires exactly once", () => {
  const reconciler = new PositionReconciler();

  assert.deepEqual(reconciler.observe("primary:evals", "E1|MNQ|t1", flat()), {
    kind: "flat-candidate",
    flatReads: 1,
    unknownReads: 0,
    position: flat(),
  });
  assert.equal(reconciler.observe("primary:evals", "E1|MNQ|t1", flat()).kind, "confirmed-flat");
  assert.equal(reconciler.observe("primary:evals", "E1|MNQ|t1", flat()).kind, "noop");
});

test("a nonzero position resets a pending flat confirmation", () => {
  const reconciler = new PositionReconciler();
  assert.equal(reconciler.observe("primary:evals", "trade", flat()).kind, "flat-candidate");
  const observedOpen = reconciler.observe("primary:evals", "trade", open(-2));
  assert.equal(observedOpen.kind, "open");
  assert.equal(observedOpen.flatReads, 0);
  assert.equal(reconciler.observe("primary:evals", "trade", flat()).kind, "flat-candidate");
});

test("unknown evidence retains the trade and breaks consecutive-flat confirmation", () => {
  const reconciler = new PositionReconciler();
  assert.equal(reconciler.observe("primary:funded", "trade", flat()).kind, "flat-candidate");
  const missed = reconciler.observe("primary:funded", "trade", unknown());
  assert.equal(missed.kind, "unknown");
  assert.equal(missed.flatReads, 0);
  assert.equal(reconciler.observe("primary:funded", "trade", flat()).kind, "flat-candidate");
});

test("a new trade fingerprint cannot inherit prior flat or completed state", () => {
  const reconciler = new PositionReconciler();
  reconciler.observe("primary:evals", "trade-1", flat());
  reconciler.observe("primary:evals", "trade-1", flat());

  assert.equal(reconciler.observe("primary:evals", "trade-2", flat()).kind, "flat-candidate");
  assert.equal(reconciler.observe("primary:evals", "trade-2", open(1)).kind, "open");
});

test("unknown alerts have deterministic threshold and repeat cadence", () => {
  const reconciler = new PositionReconciler({ unknownAlertAfter: 3, unknownAlertEvery: 4 });
  const alerts: number[] = [];
  for (let count = 1; count <= 11; count++) {
    const result = reconciler.observe("primary:evals", "trade", unknown());
    if (result.kind === "unknown" && result.shouldAlert) alerts.push(count);
  }
  assert.deepEqual(alerts, [3, 7, 11]);

  const recovered = reconciler.observe("primary:evals", "trade", open(1));
  assert.equal(recovered.unknownReads, 0);
  const nextUnknown = reconciler.observe("primary:evals", "trade", unknown());
  assert.equal(nextUnknown.kind, "unknown");
  if (nextUnknown.kind === "unknown") assert.equal(nextUnknown.shouldAlert, false);
});
