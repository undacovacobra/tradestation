import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareNextAccount, type ArmingBrowser } from "../src/arming.js";
import type { StoredAccount } from "../src/types.js";

function account(atmPreset: string): StoredAccount {
  return {
    tradovateLabel: "LFE1",
    name: "Evaluation 1",
    group: "evals",
    enabled: true,
    status: "active",
    atmPreset,
    loginId: "primary-tradovate",
    firm: "Primary prop firm",
  };
}

function fakeBrowser(calls: string[], presetError?: unknown): ArmingBrowser {
  return {
    async armFor(label) {
      calls.push(`armFor:${label}`);
    },
    async readSelectedEquity() {
      calls.push("readSelectedEquity");
      return 50_000;
    },
    async selectAtmPreset(name) {
      calls.push(`selectAtmPreset:${name}`);
      if (presetError !== undefined) throw presetError;
    },
  };
}

test("prepares the Next account before entry", async () => {
  const calls: string[] = [];

  await prepareNextAccount(fakeBrowser(calls), account("25"), {
    onBalance(label, equity) {
      calls.push(`balance:${label}:${equity}`);
    },
    onPresetError(error) {
      assert.fail(`unexpected preset error: ${error.message}`);
    },
  });

  assert.deepEqual(calls, [
    "armFor:LFE1",
    "readSelectedEquity",
    "balance:LFE1:50000",
    "selectAtmPreset:25",
  ]);
});

test("a blank preset leaves the current ATM unchanged", async () => {
  const calls: string[] = [];

  await prepareNextAccount(fakeBrowser(calls), account(""), {
    onBalance(label, equity) {
      calls.push(`balance:${label}:${equity}`);
    },
    onPresetError(error) {
      assert.fail(`unexpected preset error: ${error.message}`);
    },
  });

  assert.deepEqual(calls, [
    "armFor:LFE1",
    "readSelectedEquity",
    "balance:LFE1:50000",
  ]);
});

test("preset selection errors warn once without aborting arming", async () => {
  const calls: string[] = [];
  const errors: Error[] = [];

  await prepareNextAccount(fakeBrowser(calls, "preset unavailable"), account("25"), {
    onBalance(label, equity) {
      calls.push(`balance:${label}:${equity}`);
    },
    onPresetError(error) {
      errors.push(error);
    },
  });

  assert.deepEqual(calls, [
    "armFor:LFE1",
    "readSelectedEquity",
    "balance:LFE1:50000",
    "selectAtmPreset:25",
  ]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.message, "preset unavailable");
});
