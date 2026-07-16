import type { Group } from "./types.js";

export interface RecoverableLane {
  key: string;
  credentialId: string;
  stage: Group;
}

export interface RecoverableOpenTrade {
  tradovateLabel: string;
  loginId?: string;
}

export interface RecoverableWorker {
  restoreOpenTrade(stage: Group, label: string): void;
}

export function restorePersistedTradeLeases<TLane extends RecoverableLane>(
  lanes: readonly TLane[],
  openForLane: (lane: TLane) => RecoverableOpenTrade | null,
  workerForLogin: (loginId: string) => RecoverableWorker | undefined,
): number {
  let restored = 0;
  for (const lane of lanes) {
    const open = openForLane(lane);
    if (!open) continue;
    const worker = workerForLogin(open.loginId ?? lane.credentialId);
    if (!worker) continue;
    worker.restoreOpenTrade(lane.stage, open.tradovateLabel);
    restored++;
  }
  return restored;
}

export function connectedLoginNextStep(ownsRecordedTrade: boolean): "reconcile" | "arm" {
  return ownsRecordedTrade ? "reconcile" : "arm";
}
