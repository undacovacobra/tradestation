import assert from "node:assert/strict";
import test from "node:test";

test("a failed optional-module load is retried and only success is cached", async () => {
  let loaderModule: typeof import("../src/retryableModule.js");
  try {
    loaderModule = await import("../src/retryableModule.js");
  } catch {
    assert.fail("retryable optional-module loader is missing");
  }

  let attempts = 0;
  const expected = { forward: true };
  const load = loaderModule.createRetryableModuleLoader(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("temporary module load failure");
    return expected;
  });

  assert.equal(await load(), null);
  assert.equal(await load(), expected);
  assert.equal(await load(), expected);
  assert.equal(attempts, 2);
});
