import assert from "node:assert/strict";
import test from "node:test";
import { IncidentRegistry } from "../src/incidents.js";

test("an unresolved incident alerts once and clears only after stable recovery", () => {
  const incidents = new IncidentRegistry({ healthyReadsToResolve: 2 });
  assert.equal(incidents.raise("lane", "cannot verify"), true);
  assert.equal(incidents.raise("lane", "still cannot verify"), false);
  assert.equal(incidents.healthy("lane"), false);
  assert.equal(incidents.raise("lane", "flapped unknown"), false);
  assert.equal(incidents.healthy("lane"), false);
  assert.equal(incidents.healthy("lane"), true);
  assert.equal(incidents.raise("lane", "new episode"), true);
});

test("incident metadata remains available for the dashboard while unresolved", () => {
  const incidents = new IncidentRegistry();
  incidents.raise("login:primary", "logged out", new Date("2026-07-16T03:00:00Z"));
  assert.deepEqual(incidents.get("login:primary"), {
    message: "logged out",
    openedAt: "2026-07-16T03:00:00.000Z",
    healthyReads: 0,
  });
});
