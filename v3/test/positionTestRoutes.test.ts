import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import test from "node:test";

import { registerPositionTestRoutes, type PositionTestTarget } from "../src/positionTestRoutes.js";
import type { LaneSnapshot } from "../src/sessions.js";

async function fixture(connected = true) {
  const app = express();
  app.use(express.json());
  const calls: PositionTestTarget[] = [];
  const targets: PositionTestTarget[] = [
    { loginId: "primary", stage: "evals", label: "LFE1" },
    { loginId: "primary", stage: "funded", label: "LFF1" },
  ];
  registerPositionTestRoutes(app, {
    isLoginReady: () => connected,
    targets: () => targets,
    inspect: async (target): Promise<LaneSnapshot> => {
      calls.push(target);
      if (target.stage === "funded") {
        return {
          verifiedAccount: true,
          position: { status: "open", netPosition: 2, checkedAt: "2026-07-16T12:00:00.000Z" },
          equity: 51_250,
          checkedAt: "2026-07-16T12:00:00.000Z",
        };
      }
      return {
        verifiedAccount: false,
        position: { status: "unknown", reason: "counter was unavailable", checkedAt: "2026-07-16T12:00:01.000Z" },
        equity: null,
        checkedAt: "2026-07-16T12:00:01.000Z",
      };
    },
  });
  const server: Server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test address");
  return {
    calls,
    post: (body: unknown) => fetch(`http://127.0.0.1:${address.port}/test-position-reader`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("position reader diagnostic rejects disconnected logins without inspecting accounts", async () => {
  const f = await fixture(false);
  try {
    const invalid = await f.post({});
    assert.equal(invalid.status, 400);

    const disconnected = await f.post({ loginId: "primary" });
    assert.equal(disconnected.status, 409);
    assert.deepEqual(f.calls, []);
  } finally { await f.close(); }
});

test("position reader diagnostic checks funded before eval and never represents an order", async () => {
  const f = await fixture();
  try {
    const response = await f.post({ loginId: "primary" });
    const body = await response.json() as {
      ok: boolean;
      placedOrder: boolean;
      results: Array<{ group: string; label: string; verifiedAccount: boolean; position: { status: string } }>;
    };
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.placedOrder, false);
    assert.deepEqual(f.calls.map(({ stage, label }) => ({ stage, label })), [
      { stage: "funded", label: "LFF1" },
      { stage: "evals", label: "LFE1" },
    ]);
    assert.deepEqual(body.results.map(({ group, label, position }) => ({ group, label, status: position.status })), [
      { group: "funded", label: "LFF1", status: "open" },
      { group: "evals", label: "LFE1", status: "unknown" },
    ]);
  } finally { await f.close(); }
});
