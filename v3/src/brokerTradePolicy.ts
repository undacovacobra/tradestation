import type { BrokerPosition } from "./brokerPosition.js";
import type { OpenTrade } from "./rotation.js";

export type CloseAction = "request-exit" | "wait-for-confirmation" | "already-requested";

/** Webhooks are commands, not broker truth. Only explicit nonzero position
 * evidence may cause a fresh Exit click. */
export function decideCloseAction(position: BrokerPosition, alreadyRequested: boolean): CloseAction {
  if (alreadyRequested) return "already-requested";
  return position.status === "open" ? "request-exit" : "wait-for-confirmation";
}

export function tradeFingerprint(trade: Pick<OpenTrade, "tradovateLabel" | "symbol" | "openedAt">): string {
  return `${trade.tradovateLabel}|${trade.symbol}|${trade.openedAt}`;
}

/** Protect a newer/different open trade from a delayed close webhook. */
export function closeIdentityError(
  open: Pick<OpenTrade, "symbol" | "tradeId">,
  close: { symbol: string; tradeId?: string },
): string | null {
  if (open.symbol.trim().toUpperCase() !== close.symbol.trim().toUpperCase()) {
    return `Close symbol ${close.symbol} does not match the recorded open symbol ${open.symbol}.`;
  }
  if (open.tradeId && close.tradeId && open.tradeId !== close.tradeId) {
    return `Close trade id ${close.tradeId} does not match the recorded open trade id ${open.tradeId}.`;
  }
  return null;
}

export function brokerStatusLabel(position: BrokerPosition, flatReads = 0): string {
  if (position.status === "unknown") return "UNKNOWN";
  if (position.status === "flat") return flatReads >= 2 ? "FLAT" : `FLAT CHECK ${Math.max(1, flatReads)}/2`;
  return `OPEN ${position.netPosition >= 0 ? "+" : ""}${position.netPosition}`;
}
