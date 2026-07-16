import test from "node:test";
import assert from "node:assert/strict";
import express from "express";

import { registerRestRoutes } from "../src/restRoutes.js";

async function fixture() {
  const app = express();
  app.use(express.json());
  const resting = new Set<string>();
  const arms: string[] = [];
  let open = false;
  registerRestRoutes(app, {
    findAccount: (label) => label === "E1"
      ? { tradovateLabel: "E1", name: "Eval One", group: "evals", enabled: true, status: "active", atmPreset: "25", loginId: "login-a", firm: "Firm" }
      : label === "F1"
        ? { tradovateLabel: "F1", name: "Funded One", group: "funded", enabled: true, status: "active", atmPreset: "funded", loginId: "login-a", firm: "Firm" }
        : undefined,
    hasOpenTrade: () => open,
    markRest: (_loginId, _group, label) => {
      if (resting.has(label)) return false;
      resting.add(label);
      return true;
    },
    clearRest: (_loginId, _group, label) => resting.delete(label),
    rearm: (loginId, group) => arms.push(`${loginId}:${group}`),
    pushEvent: () => undefined,
  });
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing port");
  const post = async (path: string, body: unknown) => {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as { ok: boolean; error?: string } };
  };
  return { post, arms, setOpen: (value: boolean) => { open = value; }, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test("manual won/rest is evaluation-only, credential-scoped, and re-arms the lane", async () => {
  const f = await fixture();
  try {
    const wrongLogin = await f.post("/accounts/rest", { loginId: "other", group: "evals", label: "E1" });
    assert.equal(wrongLogin.status, 404);
    const funded = await f.post("/accounts/rest", { loginId: "login-a", group: "funded", label: "F1" });
    assert.equal(funded.status, 400);
    const marked = await f.post("/accounts/rest", { loginId: "login-a", group: "evals", label: "E1" });
    assert.equal(marked.status, 200);
    assert.deepEqual(f.arms, ["login-a:evals"]);
  } finally { await f.close(); }
});

test("an open evaluation cannot be manually marked won", async () => {
  const f = await fixture();
  try {
    f.setOpen(true);
    const response = await f.post("/accounts/rest", { loginId: "login-a", group: "evals", label: "E1" });
    assert.equal(response.status, 409);
    assert.match(response.body.error ?? "", /open trade/i);
  } finally { await f.close(); }
});

test("put back in rotation clears today's rest and re-arms the exact lane", async () => {
  const f = await fixture();
  try {
    await f.post("/accounts/rest", { loginId: "login-a", group: "evals", label: "E1" });
    const response = await f.post("/accounts/unrest", { loginId: "login-a", group: "evals", label: "E1" });
    assert.equal(response.status, 200);
    assert.deepEqual(f.arms, ["login-a:evals", "login-a:evals"]);
  } finally { await f.close(); }
});
