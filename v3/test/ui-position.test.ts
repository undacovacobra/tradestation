import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const app = readFileSync(resolve("public", "app.js"), "utf8");
const server = readFileSync(resolve("src", "server.ts"), "utf8");

test("dashboard exposes broker position state and a no-order position check", () => {
  assert.match(app, /brokerPosition/);
  assert.match(app, /Broker:/);
  assert.match(app, /credential-position-check/);
  assert.match(app, /\/browser\/position/);
  const index = readFileSync(resolve("public", "index.html"), "utf8");
  assert.match(index, /btn-test-position-reader/);
  assert.match(app, /\/test-position-reader/);
  assert.match(app, /No order is placed/);
});

test("status and diagnostic route expose read-only broker position evidence", () => {
  assert.match(server, /brokerPosition:/);
  assert.match(server, /api\.post\("\/browser\/position"/);
  assert.match(server, /readLanePosition/);
});

test("per-account flatten is shown only for fresh broker-open account evidence", () => {
  assert.match(app, /account\.brokerPosition\?\.status === "open"/);
  assert.match(app, /credential-flatten-position/);
  assert.match(app, /\/positions\/flatten-one/);
  assert.match(app, /confirm:\s*"FLATTEN ONE"/);
  assert.match(server, /brokerAccountStatus/);
  assert.match(server, /rememberBrokerPosition/);
});
