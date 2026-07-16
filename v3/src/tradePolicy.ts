import type { Group } from "./types.js";

/** Funded accounts never inherit the evaluation profit-target policy. */
export function usesEvaluationTarget(group: Group): boolean {
  return group === "evals";
}

export function shouldRetireAtBalance(group: Group, balance: number, target: number): boolean {
  return usesEvaluationTarget(group) && balance >= target;
}
