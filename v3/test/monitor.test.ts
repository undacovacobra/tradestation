import assert from "node:assert/strict";
import test from "node:test";
import { Monitor } from "../src/monitor.js";

test("monitor reports tick failures instead of swallowing them", async () => {
  const seen: string[] = [];
  let release!: () => void;
  const reported = new Promise<void>((resolve) => { release = resolve; });
  const monitor = new Monitor(async () => { throw new Error("reader failed"); }, {
    activeMs: 1,
    isActive: () => true,
    onError: (error) => {
      seen.push(error instanceof Error ? error.message : String(error));
      release();
    },
  });
  monitor.start();
  await reported;
  monitor.stop();
  assert.deepEqual(seen, ["reader failed"]);
});
