import assert from "node:assert/strict";
import test from "node:test";

import type { BrokerPosition } from "../src/brokerPosition.js";
import {
  flattenPositions,
  type FlattenOperations,
  type FlattenTarget,
} from "../src/flattenPositions.js";

const open = (netPosition = 1): BrokerPosition => ({ status: "open", netPosition, checkedAt: "now" });
const flat = (): BrokerPosition => ({ status: "flat", checkedAt: "now" });
const unknown = (reason = "missing"): BrokerPosition => ({ status: "unknown", reason, checkedAt: "now" });

function target(loginId: string, group: "evals" | "funded", label: string): FlattenTarget {
  return { loginId, group, label, name: label, recordedOpen: false };
}

test("Funded targets run first per login while different logins overlap", async () => {
  const targets = [target("one", "evals", "E1"), target("one", "funded", "F1"), target("two", "evals", "E2")];
  const reads = new Map<string, number>();
  const started: string[] = [];
  let activeLogins = 0;
  let maxActiveLogins = 0;

  const operations: FlattenOperations = {
    cancelPending(item) { started.push(`${item.loginId}:${item.group}:${item.label}`); },
    async readPosition(item) {
      const count = reads.get(item.label) ?? 0;
      reads.set(item.label, count + 1);
      if (count === 0) {
        activeLogins++;
        maxActiveLogins = Math.max(maxActiveLogins, activeLogins);
        await new Promise((resolve) => setTimeout(resolve, 10));
        activeLogins--;
        return open();
      }
      return flat();
    },
    async requestExit() {},
    async confirmedFlat() {},
    async wait() {},
  };

  const results = await flattenPositions(targets, operations, { flatConfirmDelayMs: 0 });

  assert.deepEqual(started.filter((item) => item.startsWith("one:")), ["one:funded:F1", "one:evals:E1"]);
  assert.ok(maxActiveLogins >= 2, "independent login batches should overlap");
  assert.equal(results.every((item) => item.outcome === "closed"), true);
});

test("flat and unknown evidence never clicks Exit", async () => {
  const targets = [target("one", "funded", "F1"), target("one", "evals", "E1")];
  const positions = new Map<string, BrokerPosition[]>([
    ["F1", [flat(), flat()]],
    ["E1", [unknown("ticket and summary disagree")]],
  ]);
  const exitLabels: string[] = [];
  const confirmed: string[] = [];
  const operations: FlattenOperations = {
    cancelPending() {},
    async readPosition(item) { return positions.get(item.label)!.shift()!; },
    async requestExit(item) { exitLabels.push(item.label); },
    async confirmedFlat(item) { confirmed.push(item.label); },
    async wait() {},
  };

  const results = await flattenPositions(targets, operations, { flatConfirmDelayMs: 0 });

  assert.deepEqual(exitLabels, []);
  assert.deepEqual(confirmed, ["F1"]);
  assert.deepEqual(results.map((item) => item.outcome), ["already-flat", "failed"]);
  assert.match(results[1]!.message, /disagree/i);
});

test("an exit is complete only after two consecutive flat reads", async () => {
  const positions = [open(-2), flat(), open(-1), flat(), flat()];
  let exits = 0;
  let completions = 0;
  const operations: FlattenOperations = {
    cancelPending() {},
    async readPosition() { return positions.shift()!; },
    async requestExit() { exits++; },
    async confirmedFlat() { completions++; },
    async wait() {},
  };

  const [result] = await flattenPositions([target("one", "funded", "F1")], operations, {
    flatConfirmDelayMs: 0,
    maxConfirmationReads: 6,
  });

  assert.equal(exits, 1);
  assert.equal(completions, 1);
  assert.equal(result!.outcome, "closed");
});

test("missing a second flat confirmation fails without claiming completion", async () => {
  const positions = [open(), flat(), unknown("temporarily missing"), flat()];
  let completions = 0;
  const operations: FlattenOperations = {
    cancelPending() {},
    async readPosition() { return positions.shift() ?? unknown("still missing"); },
    async requestExit() {},
    async confirmedFlat() { completions++; },
    async wait() {},
  };

  const [result] = await flattenPositions([target("one", "evals", "E1")], operations, {
    flatConfirmDelayMs: 0,
    maxConfirmationReads: 3,
  });

  assert.equal(completions, 0);
  assert.equal(result!.outcome, "failed");
  assert.match(result!.message, /two consecutive/i);
});
