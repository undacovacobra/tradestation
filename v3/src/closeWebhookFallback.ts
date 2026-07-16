import type { BrokerPosition } from "./brokerPosition.js";

export type CloseFallbackDecision = "none" | "waiting" | "eligible" | "vetoed";

interface CloseEvidence {
  fingerprint: string;
  receivedAtMs: number;
  notBeforeMs: number;
}

/** Tracks close-webhook evidence without timers or broker mutations. The server
 * asks for a decision only after each fresh broker observation. */
export class CloseWebhookFallback {
  private readonly evidence = new Map<string, CloseEvidence>();
  private readonly graceMs: number;
  private readonly minUnknownReads: number;

  constructor(options: { graceMs?: number; minUnknownReads?: number } = {}) {
    this.graceMs = Math.max(0, Math.floor(options.graceMs ?? 5_000));
    this.minUnknownReads = Math.max(1, Math.floor(options.minUnknownReads ?? 2));
  }

  record(laneKey: string, fingerprint: string, receivedAtMs = Date.now()): void {
    if (this.evidence.get(laneKey)?.fingerprint === fingerprint) return;
    this.evidence.set(laneKey, {
      fingerprint,
      receivedAtMs,
      notBeforeMs: receivedAtMs + this.graceMs,
    });
  }

  observe(
    laneKey: string,
    fingerprint: string,
    position: BrokerPosition,
    unknownReads: number,
    nowMs = Date.now(),
  ): CloseFallbackDecision {
    const evidence = this.evidence.get(laneKey);
    if (!evidence || evidence.fingerprint !== fingerprint) return "none";
    if (position.status === "open") {
      evidence.notBeforeMs = nowMs + this.graceMs;
      return "vetoed";
    }
    if (position.status === "flat") return "waiting";
    return nowMs >= evidence.notBeforeMs && unknownReads >= this.minUnknownReads
      ? "eligible"
      : "waiting";
  }

  clear(laneKey: string): void {
    this.evidence.delete(laneKey);
  }

  has(laneKey: string, fingerprint: string): boolean {
    return this.evidence.get(laneKey)?.fingerprint === fingerprint;
  }
}
