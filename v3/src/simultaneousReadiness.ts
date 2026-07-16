import type { EntryTiming } from "./sessions.js";
import type { Group, StoredAccount } from "./types.js";

interface ReadinessWorker {
  readonly definition: { id: string };
  status?(): { executionMode?: "dual-ticket" | "sequential" };
  isReady(group: Group, account: StoredAccount): boolean;
  testPreparedQuantity(group: Group, account: StoredAccount, quantity: number): Promise<EntryTiming>;
}

interface ReadinessTestInput {
  evalAccount: StoredAccount;
  fundedAccount: StoredAccount;
  evalWorker: ReadinessWorker;
  fundedWorker: ReadinessWorker;
  evalQuantity: number;
  fundedQuantity: number;
}

export interface SimultaneousReadinessResult {
  ok: boolean;
  placedTrade: false;
  totalMs: number;
  results: Array<{ group: Group; ok: boolean; timingMs?: EntryTiming; error?: string }>;
}

export function resolveReadinessCredentialIds(body: unknown, fallbackId: string): {
  evalCredentialId: string;
  fundedCredentialId: string;
} {
  const value = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const legacy = typeof value.credentialId === "string" && value.credentialId.trim()
    ? value.credentialId.trim()
    : fallbackId;
  return {
    evalCredentialId: typeof value.evalCredentialId === "string" && value.evalCredentialId.trim()
      ? value.evalCredentialId.trim()
      : legacy,
    fundedCredentialId: typeof value.fundedCredentialId === "string" && value.fundedCredentialId.trim()
      ? value.fundedCredentialId.trim()
      : legacy,
  };
}

/** Exercises only each prepared ticket's quantity field. It cannot click an order. */
export async function runSimultaneousReadinessTest(input: ReadinessTestInput): Promise<SimultaneousReadinessResult> {
  if (input.evalWorker.definition.id === input.fundedWorker.definition.id) {
    const mode = input.evalWorker.status?.().executionMode;
    if (mode !== "dual-ticket") {
      throw new Error("This credential is in sequential mode; same-session simultaneous readiness requires a proven dual-ticket layout.");
    }
  }
  if (!input.evalWorker.isReady("evals", input.evalAccount)) {
    throw new Error(`${input.evalAccount.name} is not exactly ready with its saved ATM preset.`);
  }
  if (!input.fundedWorker.isReady("funded", input.fundedAccount)) {
    throw new Error(`${input.fundedAccount.name} is not exactly ready with its saved ATM preset.`);
  }

  const started = Date.now();
  const settled = await Promise.allSettled([
    input.evalWorker.testPreparedQuantity("evals", input.evalAccount, input.evalQuantity),
    input.fundedWorker.testPreparedQuantity("funded", input.fundedAccount, input.fundedQuantity),
  ]);
  const groups: Group[] = ["evals", "funded"];
  const results = settled.map((result, index) => result.status === "fulfilled"
    ? { group: groups[index]!, ok: true, timingMs: result.value }
    : { group: groups[index]!, ok: false, error: result.reason instanceof Error ? result.reason.message : String(result.reason) });
  return {
    ok: results.every((result) => result.ok),
    placedTrade: false,
    totalMs: Date.now() - started,
    results,
  };
}
