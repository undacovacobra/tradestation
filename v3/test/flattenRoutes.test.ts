import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import test from "node:test";

import { registerFlattenRoutes } from "../src/flattenRoutes.js";
import type { FlattenResult } from "../src/flattenPositions.js";

const closed: FlattenResult = {
  loginId: "one",
  group: "funded",
  label: "F1",
  name: "Funded 1",
  recordedOpen: true,
  outcome: "closed",
  message: "closed",
  exitRequested: true,
  netPosition: 1,
};

async function fixture() {
  const app = express();
  app.use(express.json());
  let running = true;
  let allCalls = 0;
  const oneCalls: unknown[] = [];
  registerFlattenRoutes(app, {
    getRunning: () => running,
    flattenAll: async () => { allCalls++; return [closed]; },
    flattenOne: async (target) => { oneCalls.push(target); return closed; },
  });
  const server: Server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test address");
  return {
    get running() { return running; },
    set running(value: boolean) { running = value; },
    get allCalls() { return allCalls; },
    oneCalls,
    post: (path: string, body: unknown) => fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("flatten-all rejects a missing confirmation without invoking broker work", async () => {
  const f = await fixture();
  try {
    const response = await f.post("/positions/flatten-all", { confirm: false });
    assert.equal(response.status, 400);
    assert.equal(f.allCalls, 0);
    assert.equal(f.running, true);
  } finally { await f.close(); }
});

test("flatten-all returns per-account results without changing running state", async () => {
  const f = await fixture();
  try {
    const response = await f.post("/positions/flatten-all", { confirm: "FLATTEN ALL" });
    const body = await response.json() as { ok: boolean; running: boolean; results: FlattenResult[] };
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.running, true);
    assert.equal(f.running, true);
    assert.equal(f.allCalls, 1);
    assert.equal(body.results[0]!.label, "F1");
  } finally { await f.close(); }
});

test("flatten-one validates confirmation and the exact account identity", async () => {
  const f = await fixture();
  try {
    const rejected = await f.post("/positions/flatten-one", { confirm: "FLATTEN ONE", loginId: "one", group: "funded" });
    assert.equal(rejected.status, 400);
    assert.deepEqual(f.oneCalls, []);

    const response = await f.post("/positions/flatten-one", {
      confirm: "FLATTEN ONE",
      loginId: "one",
      group: "funded",
      label: "F1",
    });
    assert.equal(response.status, 200);
    assert.deepEqual(f.oneCalls, [{ loginId: "one", group: "funded", label: "F1" }]);
    assert.equal(f.running, true);
  } finally { await f.close(); }
});

test("flatten endpoint reports partial failure without turning ATLAS off", async () => {
  const app = express();
  app.use(express.json());
  const failed = { ...closed, outcome: "failed" as const, message: "unknown position", exitRequested: false };
  registerFlattenRoutes(app, {
    getRunning: () => false,
    flattenAll: async () => [closed, failed],
    flattenOne: async () => failed,
  });
  const server: Server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test address");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/positions/flatten-all`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: "FLATTEN ALL" }),
    });
    const body = await response.json() as { ok: boolean; running: boolean };
    assert.equal(response.status, 207);
    assert.equal(body.ok, false);
    assert.equal(body.running, false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
