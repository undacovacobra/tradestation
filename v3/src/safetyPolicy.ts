import type { BrokerPosition } from "./brokerPosition.js";
import type { Mode } from "./store.js";

export function assertSafeModeTransition(current: Mode, requested: Mode, hasOpenLiveTrade: boolean): void {
  if (current === "live" && requested === "practice" && hasOpenLiveTrade) {
    throw new Error("Cannot switch to Practice while an open live trade is recorded. Flatten and confirm broker-flat first.");
  }
}

export function assertSafeBrowserDisconnect(hasOpenLiveTrade: boolean): void {
  if (hasOpenLiveTrade) {
    throw new Error("Cannot disconnect this Tradovate browser while it owns an open live trade.");
  }
}

export function assertSafeManualReset(position: BrokerPosition["status"]): void {
  if (position === "open") {
    throw new Error("The broker position is open. Use Flatten position instead of resetting ATLAS memory.");
  }
  if (position === "unknown") {
    throw new Error("ATLAS cannot verify broker-flat, so the recorded trade cannot be reset safely.");
  }
}
