import assert from "node:assert/strict";
import test from "node:test";
import { planOcoPrices } from "../src/ocoPlan.js";

test("OCO price planning converts per-contract dollars for supported instruments", () => {
  assert.deepEqual(planOcoPrices("MNQ", "buy", 20_000, 1_520, 1_000), {
    symbol: "MNQ", tickSize: 0.25, pointValue: 2, side: "long", takeProfitPrice: 20_760, stopLossPrice: 19_500,
  });
  assert.deepEqual(planOcoPrices("MNQ1!", "buy", 20_000, 1_520, 1_000), planOcoPrices("MNQ", "buy", 20_000, 1_520, 1_000));
  assert.equal(planOcoPrices("NQ", "buy", 20_000, 1_520, 1_000).takeProfitPrice, 20_076);
  assert.equal(planOcoPrices("MES", "buy", 5_000, 1_520, 1_000).takeProfitPrice, 5_304);
  assert.equal(planOcoPrices("ES", "buy", 5_000, 1_520, 1_000).takeProfitPrice, 5_030.5);
});

test("OCO price planning reverses short prices and rounds protection outward to a tick", () => {
  const long = planOcoPrices("MNQ", "buy", 100, 1.1, 1.1);
  assert.equal(long.takeProfitPrice, 100.75);
  assert.equal(long.stopLossPrice, 99.25);
  const short = planOcoPrices("MNQ", "sell", 100, 1.1, 1.1);
  assert.equal(short.takeProfitPrice, 99.25);
  assert.equal(short.stopLossPrice, 100.75);
});

test("OCO price planning blocks unsupported symbols before entry", () => {
  assert.throws(() => planOcoPrices("YM", "buy", 40_000, 1_520, 1_000), /unsupported.*YM/i);
});
