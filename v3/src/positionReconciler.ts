import type { BrokerPosition } from "./brokerPosition.js";

export interface PositionReconcilerOptions {
  unknownAlertAfter?: number;
  unknownAlertEvery?: number;
}

interface LaneEvidence {
  fingerprint: string;
  flatReads: number;
  unknownReads: number;
  unknownAlerted: boolean;
  completed: boolean;
  position: BrokerPosition;
}

interface ObservationBase {
  flatReads: number;
  unknownReads: number;
  position: BrokerPosition;
}

export type PositionObservation =
  | (ObservationBase & { kind: "open" | "flat-candidate" | "confirmed-flat" | "noop" })
  | (ObservationBase & { kind: "unknown"; shouldAlert: boolean });

/** Pure per-lane evidence tracker. It never mutates rotations or clicks the
 * broker; it only decides when two consecutive explicit zeros confirm flat. */
export class PositionReconciler {
  private readonly lanes = new Map<string, LaneEvidence>();
  private readonly unknownAlertAfter: number;

  constructor(options: PositionReconcilerOptions = {}) {
    this.unknownAlertAfter = Math.max(1, Math.floor(options.unknownAlertAfter ?? 3));
  }

  observe(laneKey: string, fingerprint: string, position: BrokerPosition): PositionObservation {
    let evidence = this.lanes.get(laneKey);
    if (!evidence || evidence.fingerprint !== fingerprint) {
      evidence = { fingerprint, flatReads: 0, unknownReads: 0, unknownAlerted: false, completed: false, position };
      this.lanes.set(laneKey, evidence);
    }
    evidence.position = position;

    if (evidence.completed) {
      return { kind: "noop", flatReads: evidence.flatReads, unknownReads: evidence.unknownReads, position };
    }

    if (position.status === "open") {
      evidence.flatReads = 0;
      evidence.unknownReads = 0;
      evidence.unknownAlerted = false;
      return { kind: "open", flatReads: 0, unknownReads: 0, position };
    }

    if (position.status === "flat") {
      evidence.unknownReads = 0;
      evidence.unknownAlerted = false;
      evidence.flatReads += 1;
      if (evidence.flatReads >= 2) {
        evidence.completed = true;
        return { kind: "confirmed-flat", flatReads: evidence.flatReads, unknownReads: 0, position };
      }
      return { kind: "flat-candidate", flatReads: evidence.flatReads, unknownReads: 0, position };
    }

    evidence.flatReads = 0;
    evidence.unknownReads += 1;
    const shouldAlert = evidence.unknownReads >= this.unknownAlertAfter && !evidence.unknownAlerted;
    if (shouldAlert) evidence.unknownAlerted = true;
    return {
      kind: "unknown",
      flatReads: 0,
      unknownReads: evidence.unknownReads,
      shouldAlert,
      position,
    };
  }

  snapshot(laneKey: string): Readonly<LaneEvidence> | undefined {
    const evidence = this.lanes.get(laneKey);
    return evidence ? { ...evidence } : undefined;
  }

  clear(laneKey: string): void {
    this.lanes.delete(laneKey);
  }
}
