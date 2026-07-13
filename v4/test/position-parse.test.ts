import assert from "node:assert/strict";
import test from "node:test";
import { extractPosition } from "../src/positionParse.js";

test("extractPosition returns signed broker position and flat zero", () => {
  assert.equal(extractPosition("POSITION -3 USD"), -3);
  assert.equal(extractPosition("POSITION 0"), 0);
  assert.equal(extractPosition("no position here"), null);
});
