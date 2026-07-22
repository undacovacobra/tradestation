import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import test from "node:test";
import { GroupDispatcher } from "../src/groupDispatch.js";
import { registerWebhookRoutes } from "../src/webhookRoutes.js";
import type { Alert, Group } from "../src/types.js";
import { CredentialLaneRegistry, type CredentialLane, type LaneKey } from "../src/lanes.js";

const credentials = [
  { id: "apex", name: "Apex", firm: "Apex", platform: "tradovate" as const, sessionDir: ".sessions/apex", enabled: true, autoConnect: false },
  { id: "other", name: "Other", firm: "Other", platform: "tradovate" as const, sessionDir: ".sessions/other", enabled: true, autoConnect: false },
];
const registry = new CredentialLaneRegistry(credentials, []);

async function fixture(handleLane: (lane: CredentialLane, alert: Alert, options: { skipFundedWindow: boolean }) => Promise<{ message: string }>) {
  const app = express();
  app.use(express.json());
  const events: string[] = [];
  let receivedRequests = 0;
  const requestWaiters: Array<{ count: number; resolve: () => void }> = [];
  app.use((_req, _res, next) => {
    receivedRequests++;
    next();
    for (const waiter of requestWaiters.splice(0)) {
      if (receivedRequests >= waiter.count) waiter.resolve();
      else requestWaiters.push(waiter);
    }
  });
  registerWebhookRoutes(app, {
    webhookSecret: "secret",
    isRunning: () => true,
    dispatcher: new GroupDispatcher<LaneKey>(),
    lanes: () => registry.values(),
    handleLane,
    pushEvent: (_kind, message) => { events.push(message); },
    notifyActionNeeded: (message) => { events.push(`notify:${message}`); },
  });
  const server: Server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test address");
  return {
    events,
    post: (path: string, body: unknown) => fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    waitForRequests: (count: number) => receivedRequests >= count
      ? Promise.resolve()
      : new Promise<void>((resolve) => requestWaiters.push({ count, resolve })),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const alert = { secret: "secret", action: "buy", symbol: "MNQ", quantity: 1 };

test("existing evaluation and funded webhook paths remain compatible", async () => {
  const calls: string[] = [];
  const f = await fixture(async (lane) => { calls.push(lane.key); return { message: `${lane.key} ok` }; });
  try {
    assert.equal((await f.post("/webhook/evals", alert)).status, 200);
    assert.equal((await f.post("/webhook/funded", alert)).status, 200);
    assert.deepEqual(calls, ["apex:evals", "other:evals", "apex:funded", "other:funded"]);
  } finally { await f.close(); }
});

test("broadcast deduplicates and runs evals and funded concurrently", async () => {
  let active = 0;
  let maxActive = 0;
  const calls: string[] = [];
  const f = await fixture(async (lane) => {
    calls.push(lane.key);
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active--;
    return { message: `${lane.key} ok` };
  });
  try {
    const response = await f.post("/webhook", { ...alert, groups: ["evals", "funded", "evals"] });
    const body = await response.json() as { ok: boolean; results: unknown[] };
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.results.length, 4);
    assert.deepEqual(calls.sort(), ["apex:evals", "apex:funded", "other:evals", "other:funded"]);
    assert.ok(maxActive >= 2);
  } finally { await f.close(); }
});

test("combined webhook defaults to all lanes and enqueues funded before eval per credential", async () => {
  const calls: string[] = [];
  const skipWindow: Record<string, boolean> = {};
  const f = await fixture(async (lane, _alert, options) => {
    calls.push(lane.key);
    skipWindow[lane.key] = options.skipFundedWindow;
    return { message: `${lane.key} ok` };
  });
  try {
    const response = await f.post("/webhook", alert);
    assert.equal(response.status, 200);
    assert.ok(calls.indexOf("apex:funded") < calls.indexOf("apex:evals"));
    assert.ok(calls.indexOf("other:funded") < calls.indexOf("other:evals"));
    assert.equal(skipWindow["apex:evals"], true);
  } finally { await f.close(); }
});

test("broadcast reports successful and failed legs independently", async () => {
  const f = await fixture(async (lane) => {
    if (lane.key === "apex:funded") throw new Error("funded not ready");
    return { message: "evals ok" };
  });
  try {
    const response = await f.post("/webhook", { ...alert, groups: ["evals", "funded"] });
    const body = await response.json() as { ok: boolean; results: Array<{ ok: boolean; group: string; error?: string }> };
    assert.equal(response.status, 207);
    assert.equal(body.ok, false);
    assert.equal(body.results.some((result) => result.group === "apex:funded" && !result.ok), true);
    assert.equal(response.status, 207);
  } finally { await f.close(); }
});

test("invalid webhook secrets never dispatch", async () => {
  let calls = 0;
  const f = await fixture(async () => { calls++; return { message: "unexpected" }; });
  try {
    assert.equal((await f.post("/webhook/evals", { ...alert, secret: "wrong" })).status, 401);
    assert.equal((await f.post("/webhook", { ...alert, secret: "wrong", groups: ["evals", "funded"] })).status, 401);
    assert.equal(calls, 0);
  } finally { await f.close(); }
});

test("a webhook at an unrecognized address is logged so a mistyped URL is visible", async () => {
  const f = await fixture(async (lane) => { return { message: `${lane.key} ok` }; });
  try {
    // "/webhook/eval" (singular typo) matches no lane webhook and no credential.
    const res = await f.post("/webhook/eval", alert);
    assert.equal(res.status, 404);
    assert.ok(f.events.some((e) => /doesn't recognize/i.test(e)), "the mistyped address must be surfaced in the activity feed");
  } finally { await f.close(); }
});

test("credential-specific stage and combined webhooks target only that credential", async () => {
  const calls: string[] = [];
  const f = await fixture(async (lane) => { calls.push(lane.key); return { message: "ok" }; });
  try {
    assert.equal((await f.post("/webhook/apex/evals", alert)).status, 200);
    assert.deepEqual(calls, ["apex:evals"]);
    calls.length = 0;
    assert.equal((await f.post("/webhook/other", alert)).status, 200);
    assert.deepEqual(calls, ["other:funded", "other:evals", "other:winning"]);
    assert.equal((await f.post("/webhook/missing/funded", alert)).status, 404);
  } finally { await f.close(); }
});

test("duplicate trade ids are idempotent per lane", async () => {
  let calls = 0;
  const f = await fixture(async () => { calls++; return { message: "ok" }; });
  try {
    const body = { ...alert, tradeId: "signal-123" };
    assert.equal((await f.post("/webhook/apex/funded", body)).status, 200);
    assert.equal((await f.post("/webhook/apex/funded", body)).status, 200);
    assert.equal(calls, 1);
  } finally { await f.close(); }
});

test("a close waits for an in-flight final click and then closes it", async () => {
  let releaseEntry!: () => void;
  const entryGate = new Promise<void>((resolve) => { releaseEntry = resolve; });
  const calls: string[] = [];
  const f = await fixture(async (_lane, incoming) => {
    if (incoming.marketPosition === "flat") {
      calls.push("close");
      return { message: "close handled" };
    }
    calls.push("entry-start");
    await entryGate;
    calls.push("entry-end");
    return { message: "entry handled" };
  });
  try {
    const entryRequest = f.post("/webhook/apex/evals", alert);
    await f.waitForRequests(1);
    const closeRequest = f.post("/webhook/apex/evals", { ...alert, marketPosition: "flat" });
    await f.waitForRequests(2);
    assert.deepEqual(calls, ["entry-start"]);
    releaseEntry();
    const closeResponse = await closeRequest;
    assert.equal(closeResponse.status, 200);
    assert.deepEqual(calls, ["entry-start", "entry-end", "close"]);
    await entryRequest;
  } finally { releaseEntry(); await f.close(); }
});

test("a close cancels an entry backlogged behind older lane work", async () => {
  let releaseEntry!: () => void;
  const entryGate = new Promise<void>((resolve) => { releaseEntry = resolve; });
  let entryCalls = 0;
  const calls: string[] = [];
  const f = await fixture(async (_lane, incoming) => {
    if (incoming.marketPosition === "flat") { calls.push("close"); return { message: "closed" }; }
    entryCalls++;
    calls.push(`entry-${entryCalls}`);
    if (entryCalls === 1) await entryGate;
    return { message: "entered" };
  });
  try {
    const first = f.post("/webhook/apex/evals", alert);
    await f.waitForRequests(1);
    const backlogged = f.post("/webhook/apex/evals", { ...alert, symbol: "MES" });
    await f.waitForRequests(2);
    const close = f.post("/webhook/apex/evals", { ...alert, marketPosition: "flat" });
    await f.waitForRequests(3);
    releaseEntry();
    assert.equal((await first).status, 200);
    assert.equal((await close).status, 200);
    assert.equal((await backlogged).status, 409);
    assert.deepEqual(calls, ["entry-1", "close"]);
  } finally { releaseEntry(); await f.close(); }
});

test("duplicate close alerts serialize so rotation can flatten only once", async () => {
  let open = true;
  let exitClicks = 0;
  let active = 0;
  let maxActive = 0;
  const f = await fixture(async (_lane, incoming) => {
    if (incoming.marketPosition !== "flat") return { message: "entry" };
    active++;
    maxActive = Math.max(maxActive, active);
    try {
      if (!open) return { message: "already flat" };
      exitClicks++;
      await new Promise((resolve) => setTimeout(resolve, 20));
      open = false;
      return { message: "closed" };
    } finally { active--; }
  });
  try {
    const closeBody = { ...alert, marketPosition: "flat" };
    const [first, second] = await Promise.all([
      f.post("/webhook/apex/evals", closeBody),
      f.post("/webhook/apex/evals", closeBody),
    ]);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(exitClicks, 1);
    assert.equal(maxActive, 1);
  } finally { await f.close(); }
});
