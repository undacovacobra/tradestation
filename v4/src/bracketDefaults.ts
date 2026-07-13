import type { AccountDefinition, Stage } from "./models.js";

const DEFAULTS: Record<Stage, { targetPerContract: number; stopPerContract: number }> = {
  eval: { targetPerContract: 1520, stopPerContract: 1000 },
  funded: { targetPerContract: 4000, stopPerContract: 1000 },
};

export function bracketDefaults(stage: Stage): { targetPerContract: number; stopPerContract: number } {
  return { ...DEFAULTS[stage] };
}

export function isUnconfiguredBracket(account: Pick<AccountDefinition, "targetPerContract" | "stopPerContract">): boolean {
  return account.targetPerContract === 0 && account.stopPerContract === 0;
}
