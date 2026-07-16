import type { Group } from "./types.js";

export interface LoginPositionCycleTarget {
  loginId: string;
  stage: Group;
}

/** Inspect one Tradovate login serially because it has one selected-account
 * screen. Independent logins may overlap. Funded always goes first per login. */
export async function runLoginPositionCycles<T extends LoginPositionCycleTarget, R>(
  targets: readonly T[],
  inspect: (target: T) => Promise<R>,
): Promise<R[]> {
  const byLogin = new Map<string, T[]>();
  for (const target of targets) {
    const loginTargets = byLogin.get(target.loginId) ?? [];
    loginTargets.push(target);
    byLogin.set(target.loginId, loginTargets);
  }

  const groupedResults = await Promise.all([...byLogin.values()].map(async (loginTargets) => {
    const ordered = [...loginTargets].sort((a, b) => {
      const priority = (stage: Group) => stage === "funded" ? 0 : 1;
      return priority(a.stage) - priority(b.stage);
    });
    const results: R[] = [];
    for (const target of ordered) results.push(await inspect(target));
    return results;
  }));
  return groupedResults.flat();
}
