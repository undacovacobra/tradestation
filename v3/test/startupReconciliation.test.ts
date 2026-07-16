import assert from "node:assert/strict";
import test from "node:test";

import {
  connectedLoginNextStep,
  restorePersistedTradeLeases,
} from "../src/startupPositionRecovery.js";

test("startup restores persisted open trades as worker safety leases", () => {
  const restored: string[] = [];
  const lanes = [
    { key: "primary:evals", credentialId: "primary", stage: "evals" as const },
    { key: "primary:funded", credentialId: "primary", stage: "funded" as const },
  ];

  const count = restorePersistedTradeLeases(
    lanes,
    (lane) => lane.stage === "evals"
      ? { tradovateLabel: "E1", loginId: "primary" }
      : null,
    (loginId) => loginId === "primary"
      ? { restoreOpenTrade: (stage, label) => restored.push(`${stage}:${label}`) }
      : undefined,
  );

  assert.equal(count, 1);
  assert.deepEqual(restored, ["evals:E1"]);
});

test("a connected login with a restored trade reconciles instead of arming next", () => {
  assert.equal(connectedLoginNextStep(true), "reconcile");
  assert.equal(connectedLoginNextStep(false), "arm");
});

test("startup restoration uses lane ownership when legacy trade login metadata is absent", () => {
  const restored: string[] = [];
  restorePersistedTradeLeases(
    [{ key: "legacy:funded", credentialId: "legacy", stage: "funded" as const }],
    () => ({ tradovateLabel: "F1" }),
    (loginId) => ({ restoreOpenTrade: (stage, label) => restored.push(`${loginId}:${stage}:${label}`) }),
  );
  assert.deepEqual(restored, ["legacy:funded:F1"]);
});
