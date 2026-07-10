import assert from "node:assert/strict";
import test from "node:test";
import { ConnectionManager } from "../src/connectionManager.js";

const definition = { id: "login-1", name: "Login 1", firm: "Firm", adapter: "simulated" as const, url: "https://example.com", sessionDir: ".s1", accountPattern: ".+", enabled: true, autoConnect: false };

test("connection manager adds a worker without restart", () => {
  const manager = new ConnectionManager([]);
  manager.add(definition);
  assert.equal(manager.get("login-1")?.definition.name, "Login 1");
  assert.equal(manager.values().length, 1);
});
