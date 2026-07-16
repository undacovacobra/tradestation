import type { BrokerPosition } from "./brokerPosition.js";
import type { Group } from "./types.js";

export interface FlattenTarget {
  loginId: string;
  group: Group;
  label: string;
  name: string;
  recordedOpen: boolean;
}

export type FlattenOutcome = "closed" | "already-flat" | "failed";

export interface FlattenResult extends FlattenTarget {
  outcome: FlattenOutcome;
  message: string;
  exitRequested: boolean;
  netPosition?: number;
}

export interface FlattenOperations {
  cancelPending(target: FlattenTarget): void | Promise<void>;
  readPosition(target: FlattenTarget): Promise<BrokerPosition>;
  requestExit(target: FlattenTarget): Promise<void>;
  confirmedFlat(target: FlattenTarget): void | Promise<void>;
  wait?(milliseconds: number): Promise<void>;
}

export interface FlattenOptions {
  flatConfirmDelayMs?: number;
  maxConfirmationReads?: number;
}

function orderedBatches(targets: readonly FlattenTarget[]): FlattenTarget[][] {
  const byLogin = new Map<string, FlattenTarget[]>();
  for (const target of targets) {
    const batch = byLogin.get(target.loginId) ?? [];
    if (!byLogin.has(target.loginId)) byLogin.set(target.loginId, batch);
    if (!batch.some((candidate) => candidate.group === target.group && candidate.label === target.label)) batch.push(target);
  }
  for (const batch of byLogin.values()) {
    batch.sort((left, right) => Number(right.group === "funded") - Number(left.group === "funded"));
  }
  return [...byLogin.values()];
}

const defaultWait = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

async function flattenOne(
  target: FlattenTarget,
  operations: FlattenOperations,
  options: FlattenOptions,
): Promise<FlattenResult> {
  let exitRequested = false;
  let initialNetPosition: number | undefined;
  try {
    await operations.cancelPending(target);
    const initial = await operations.readPosition(target);
    if (initial.status === "unknown") {
      return { ...target, outcome: "failed", message: initial.reason, exitRequested };
    }

    let consecutiveFlatReads = initial.status === "flat" ? 1 : 0;
    if (initial.status === "open") {
      initialNetPosition = initial.netPosition;
      await operations.requestExit(target);
      exitRequested = true;
    }

    const wait = operations.wait ?? defaultWait;
    const delay = Math.max(0, options.flatConfirmDelayMs ?? 500);
    const maxReads = Math.max(1, options.maxConfirmationReads ?? 12);
    for (let attempt = 0; attempt < maxReads && consecutiveFlatReads < 2; attempt++) {
      await wait(delay);
      const position = await operations.readPosition(target);
      consecutiveFlatReads = position.status === "flat" ? consecutiveFlatReads + 1 : 0;
    }

    if (consecutiveFlatReads < 2) {
      return {
        ...target,
        outcome: "failed",
        message: `${target.name} did not produce two consecutive broker-flat confirmations.`,
        exitRequested,
        ...(initialNetPosition == null ? {} : { netPosition: initialNetPosition }),
      };
    }

    await operations.confirmedFlat(target);
    return {
      ...target,
      outcome: exitRequested ? "closed" : "already-flat",
      message: exitRequested ? `${target.name} was flattened and confirmed broker-flat.` : `${target.name} was already broker-flat.`,
      exitRequested,
      ...(initialNetPosition == null ? {} : { netPosition: initialNetPosition }),
    };
  } catch (error) {
    return {
      ...target,
      outcome: "failed",
      message: error instanceof Error ? error.message : String(error),
      exitRequested,
      ...(initialNetPosition == null ? {} : { netPosition: initialNetPosition }),
    };
  }
}

export async function flattenPositions(
  targets: readonly FlattenTarget[],
  operations: FlattenOperations,
  options: FlattenOptions = {},
): Promise<FlattenResult[]> {
  const batches = await Promise.all(orderedBatches(targets).map(async (batch) => {
    const results: FlattenResult[] = [];
    for (const target of batch) results.push(await flattenOne(target, operations, options));
    return results;
  }));
  return batches.flat();
}
