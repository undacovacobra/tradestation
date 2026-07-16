import assert from "node:assert/strict";
import test from "node:test";
import { resolveReadinessCredentialIds, runSimultaneousReadinessTest } from "../src/simultaneousReadiness.js";

const account = (label: string, loginId: string, group: "evals" | "funded") => ({
  tradovateLabel: label,
  name: label,
  group,
  loginId,
  firm: "Firm",
  atmPreset: group === "evals" ? "25" : "funded",
  enabled: true,
  status: "active" as const,
});

test("readiness credential selection preserves different evaluation and funded logins", () => {
  assert.deepEqual(resolveReadinessCredentialIds({
    evalCredentialId: "eval-login",
    fundedCredentialId: "funded-login",
  }, "primary"), {
    evalCredentialId: "eval-login",
    fundedCredentialId: "funded-login",
  });
});

test("readiness credential selection keeps the legacy one-credential request compatible", () => {
  assert.deepEqual(resolveReadinessCredentialIds({ credentialId: "legacy" }, "primary"), {
    evalCredentialId: "legacy",
    fundedCredentialId: "legacy",
  });
});

test("simultaneous readiness requires separate workers and never places an order", async () => {
  const evalAccount = account("E1", "eval-login", "evals");
  const fundedAccount = account("F1", "funded-login", "funded");
  let active = 0;
  let maxActive = 0;
  let orderClicks = 0;
  const worker = (id: string) => ({
    definition: { id },
    isReady: () => true,
    async testPreparedQuantity() {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active--;
      return { queueWaitMs: 0, executionMs: 20, totalMs: 20 };
    },
    clickOrder: async () => { orderClicks++; },
  });
  const workers = new Map([["eval-login", worker("eval-login")], ["funded-login", worker("funded-login")]]);

  const result = await runSimultaneousReadinessTest({
    evalAccount,
    fundedAccount,
    evalWorker: workers.get("eval-login")!,
    fundedWorker: workers.get("funded-login")!,
    evalQuantity: 1,
    fundedQuantity: 2,
  });

  assert.equal(result.ok, true);
  assert.equal(result.placedTrade, false);
  assert.equal(maxActive, 2);
  assert.equal(orderClicks, 0);
});

test("simultaneous readiness accepts two lanes sharing one proven dual-ticket session", async () => {
  const calls: string[] = [];
  const shared = {
    definition: { id: "shared" },
    status: () => ({ executionMode: "dual-ticket" as const }),
    isReady: () => true,
    async testPreparedQuantity(group: "evals" | "funded") {
      calls.push(group);
      return { queueWaitMs: 0, executionMs: 1, totalMs: 1 };
    },
  };
  const result = await runSimultaneousReadinessTest({
    evalAccount: account("E1", "shared", "evals"),
    fundedAccount: account("F1", "shared", "funded"),
    evalWorker: shared,
    fundedWorker: shared,
    evalQuantity: 1,
    fundedQuantity: 1,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.sort(), ["evals", "funded"]);
});

test("simultaneous readiness rejects two sequential lanes sharing one session", async () => {
  const shared = {
    definition: { id: "shared" },
    status: () => ({ executionMode: "sequential" as const }),
    isReady: () => true,
    async testPreparedQuantity() { return { queueWaitMs: 0, executionMs: 1, totalMs: 1 }; },
  };
  await assert.rejects(() => runSimultaneousReadinessTest({
    evalAccount: account("E1", "shared", "evals"),
    fundedAccount: account("F1", "shared", "funded"),
    evalWorker: shared,
    fundedWorker: shared,
    evalQuantity: 1,
    fundedQuantity: 1,
  }), /sequential|dual-ticket/i);
});
