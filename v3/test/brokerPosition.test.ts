import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyBrokerPosition,
  classifyTopPositionSummary,
  combineBrokerPositionSources,
  parseNetPosition,
} from "../src/brokerPosition.js";

test("parseNetPosition accepts signed whole contract quantities", () => {
  assert.equal(parseNetPosition("0"), 0);
  assert.equal(parseNetPosition(" 1 "), 1);
  assert.equal(parseNetPosition("+2"), 2);
  assert.equal(parseNetPosition("-3"), -3);
  assert.equal(parseNetPosition("1,000"), 1_000);
  assert.equal(parseNetPosition("-1,250"), -1_250);
});

test("parseNetPosition rejects currency, decimals, malformed text, and blanks", () => {
  assert.equal(parseNetPosition("0.00 USD"), null);
  assert.equal(parseNetPosition("$0"), null);
  assert.equal(parseNetPosition("POSITION 0"), null);
  assert.equal(parseNetPosition("-.-- USD"), null);
  assert.equal(parseNetPosition("1,00"), null);
  assert.equal(parseNetPosition(""), null);
});

test("classifyBrokerPosition treats one explicit zero as flat", () => {
  assert.deepEqual(classifyBrokerPosition(["0"], "2026-07-15T13:27:40.000Z"), {
    status: "flat",
    checkedAt: "2026-07-15T13:27:40.000Z",
  });
});

test("classifyBrokerPosition preserves the signed nonzero quantity", () => {
  assert.deepEqual(classifyBrokerPosition(["-3"], "2026-07-15T13:27:40.000Z"), {
    status: "open",
    netPosition: -3,
    checkedAt: "2026-07-15T13:27:40.000Z",
  });
});

test("classifyBrokerPosition fails safely for missing, malformed, or ambiguous evidence", () => {
  const missing = classifyBrokerPosition([], "now");
  assert.equal(missing.status, "unknown");
  if (missing.status === "unknown") assert.match(missing.reason, /missing/i);

  const malformed = classifyBrokerPosition(["0.00 USD"], "now");
  assert.equal(malformed.status, "unknown");
  if (malformed.status === "unknown") assert.match(malformed.reason, /parse/i);

  const ambiguous = classifyBrokerPosition(["0", "1"], "now");
  assert.equal(ambiguous.status, "unknown");
  if (ambiguous.status === "unknown") assert.match(ambiguous.reason, /ambiguous/i);
});

test("classifyTopPositionSummary reads the selected account long and short counters", () => {
  assert.deepEqual(classifyTopPositionSummary(["Positions: + 0/- 0"], "now"), {
    status: "flat",
    checkedAt: "now",
  });
  assert.deepEqual(classifyTopPositionSummary(["Positions: + 2/- 0"], "now"), {
    status: "open",
    netPosition: 2,
    checkedAt: "now",
  });
  assert.deepEqual(classifyTopPositionSummary(["Positions: + 0/- 3"], "now"), {
    status: "open",
    netPosition: -3,
    checkedAt: "now",
  });
});

test("classifyTopPositionSummary rejects missing, malformed, duplicate, or mixed evidence", () => {
  for (const candidates of [
    [],
    ["Positions: zero"],
    ["Positions: + 0/- 0", "Positions: + 0/- 0"],
    ["Positions: + 1/- 1"],
  ]) {
    assert.equal(classifyTopPositionSummary(candidates, "now").status, "unknown");
  }
});

test("combineBrokerPositionSources uses either definite source and accepts agreement", () => {
  const unknown = { status: "unknown" as const, reason: "missing", checkedAt: "now" };
  const flat = { status: "flat" as const, checkedAt: "now" };
  const long = { status: "open" as const, netPosition: 3, checkedAt: "now" };
  const longSummary = { status: "open" as const, netPosition: 1, checkedAt: "now" };

  assert.equal(combineBrokerPositionSources(unknown, flat).status, "flat");
  assert.equal(combineBrokerPositionSources(unknown, long).status, "open");
  assert.equal(combineBrokerPositionSources(flat, flat).status, "flat");
  assert.deepEqual(combineBrokerPositionSources(long, longSummary), long);
  assert.equal(combineBrokerPositionSources(unknown, unknown).status, "unknown");
});

test("combineBrokerPositionSources fails safely when ticket and top counter conflict", () => {
  const flat = { status: "flat" as const, checkedAt: "now" };
  const long = { status: "open" as const, netPosition: 2, checkedAt: "now" };
  const short = { status: "open" as const, netPosition: -1, checkedAt: "now" };

  assert.equal(combineBrokerPositionSources(flat, long).status, "unknown");
  assert.equal(combineBrokerPositionSources(long, flat).status, "unknown");
  assert.equal(combineBrokerPositionSources(long, short).status, "unknown");
});
