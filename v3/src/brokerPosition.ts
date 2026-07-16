export type BrokerPosition =
  | { status: "open"; netPosition: number; checkedAt: string }
  | { status: "flat"; checkedAt: string }
  | { status: "unknown"; reason: string; checkedAt: string };

/** Parse only an explicit signed whole-contract quantity. Currency, P/L, and
 * surrounding labels are deliberately rejected so they can never imply flat. */
export function parseNetPosition(raw: string): number | null {
  const value = raw.trim();
  if (!/^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(value)) return null;
  const parsed = Number(value.replaceAll(",", ""));
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** Classify the explicit value candidates found beside Tradovate's POSITION
 * label. Exactly one parseable value is required; every uncertainty fails safe. */
export function classifyBrokerPosition(
  candidates: readonly string[],
  checkedAt = new Date().toISOString(),
): BrokerPosition {
  if (candidates.length === 0) {
    return { status: "unknown", reason: "The Tradovate POSITION value is missing.", checkedAt };
  }
  if (candidates.length !== 1) {
    return { status: "unknown", reason: "The Tradovate POSITION value is ambiguous.", checkedAt };
  }
  const netPosition = parseNetPosition(candidates[0]!);
  if (netPosition == null) {
    return { status: "unknown", reason: "The Tradovate POSITION value could not be parsed.", checkedAt };
  }
  return netPosition === 0
    ? { status: "flat", checkedAt }
    : { status: "open", netPosition, checkedAt };
}

/** Classify Tradovate's selected-account summary, rendered as
 * `Positions: + N/- N`. Both sides being nonzero is deliberately treated as
 * ambiguous because it does not prove a single net direction. */
export function classifyTopPositionSummary(
  candidates: readonly string[],
  checkedAt = new Date().toISOString(),
): BrokerPosition {
  if (candidates.length === 0) {
    return { status: "unknown", reason: "The Tradovate Positions summary is missing.", checkedAt };
  }
  if (candidates.length !== 1) {
    return { status: "unknown", reason: "The Tradovate Positions summary is ambiguous.", checkedAt };
  }

  const normalized = candidates[0]!.replace(/\s+/g, " ").trim();
  const match = /^Positions:\s*\+\s*(\d+)\s*\/\s*-\s*(\d+)$/i.exec(normalized);
  if (!match) {
    return { status: "unknown", reason: "The Tradovate Positions summary could not be parsed.", checkedAt };
  }

  const longCount = Number(match[1]);
  const shortCount = Number(match[2]);
  if (!Number.isSafeInteger(longCount) || !Number.isSafeInteger(shortCount)) {
    return { status: "unknown", reason: "The Tradovate Positions summary is outside the safe range.", checkedAt };
  }
  if (longCount > 0 && shortCount > 0) {
    return { status: "unknown", reason: "The Tradovate Positions summary has both long and short positions.", checkedAt };
  }
  if (longCount > 0) return { status: "open", netPosition: longCount, checkedAt };
  if (shortCount > 0) return { status: "open", netPosition: -shortCount, checkedAt };
  return { status: "flat", checkedAt };
}

/** Combine the order-ticket quantity with the selected-account top summary.
 * One definite source can recover from the other being unavailable. If both
 * are definite they must agree on flat/open and, when open, on direction. */
export function combineBrokerPositionSources(
  ticket: BrokerPosition,
  summary: BrokerPosition,
): BrokerPosition {
  if (ticket.status === "unknown" && summary.status === "unknown") {
    return {
      status: "unknown",
      reason: `${ticket.reason} ${summary.reason}`,
      checkedAt: ticket.checkedAt,
    };
  }
  if (ticket.status === "unknown") return summary;
  if (summary.status === "unknown") return ticket;

  if (ticket.status !== summary.status) {
    return {
      status: "unknown",
      reason: "The order-ticket position and top Positions summary disagree.",
      checkedAt: ticket.checkedAt,
    };
  }
  if (ticket.status === "flat" && summary.status === "flat") return ticket;
  if (ticket.status === "open" && summary.status === "open") {
    if (Math.sign(ticket.netPosition) === Math.sign(summary.netPosition)) return ticket;
    return {
      status: "unknown",
      reason: "The order-ticket position and top Positions summary disagree on direction.",
      checkedAt: ticket.checkedAt,
    };
  }

  return {
    status: "unknown",
    reason: "The Tradovate position evidence could not be reconciled.",
    checkedAt: ticket.checkedAt,
  };
}
