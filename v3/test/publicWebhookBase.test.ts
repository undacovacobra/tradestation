import assert from "node:assert/strict";
import test from "node:test";

import { normalizePublicWebhookBase } from "../src/publicWebhookBase.js";

test("normalizePublicWebhookBase accepts an HTTP(S) origin and removes its trailing slash", () => {
  assert.equal(normalizePublicWebhookBase(undefined), null);
  assert.equal(normalizePublicWebhookBase("   "), null);
  assert.equal(
    normalizePublicWebhookBase("https://antennae-compress-panning.ngrok-free.dev/"),
    "https://antennae-compress-panning.ngrok-free.dev",
  );
  assert.equal(normalizePublicWebhookBase("http://localhost:3400/"), "http://localhost:3400");
});

test("normalizePublicWebhookBase rejects non-absolute, non-HTTP, or non-origin values", () => {
  assert.throws(() => normalizePublicWebhookBase("localhost:3400"), /absolute HTTP or HTTPS/i);
  assert.throws(() => normalizePublicWebhookBase("ftp://example.com"), /HTTP or HTTPS/i);
  assert.throws(() => normalizePublicWebhookBase("https://example.com/path"), /only an origin/i);
  assert.throws(() => normalizePublicWebhookBase("https://example.com/?q=1"), /only an origin/i);
  assert.throws(() => normalizePublicWebhookBase("https://user:secret@example.com"), /only an origin/i);
});
