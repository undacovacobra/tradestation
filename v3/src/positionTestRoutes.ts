import type { Router } from "express";

import { runLoginPositionCycles } from "./loginPositionCycle.js";
import type { LaneSnapshot } from "./sessions.js";
import type { Group } from "./types.js";

export interface PositionTestTarget {
  loginId: string;
  stage: Group;
  label: string;
}

export interface PositionTestRouteDependencies {
  isLoginReady(loginId: string): boolean;
  targets(loginId: string): readonly PositionTestTarget[];
  inspect(target: PositionTestTarget): Promise<LaneSnapshot>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Read-only diagnostic: select and verify each lane account, then read its
 * broker position and equity. It has no order dependency by construction. */
export function registerPositionTestRoutes(api: Router, deps: PositionTestRouteDependencies): void {
  api.post("/test-position-reader", async (req, res) => {
    const loginId = typeof req.body?.loginId === "string" ? req.body.loginId.trim() : "";
    if (!loginId) return res.status(400).json({ ok: false, error: "A Tradovate login is required." });
    if (!deps.isLoginReady(loginId)) {
      return res.status(409).json({ ok: false, error: "Connect and log in to this Tradovate login before testing the position reader." });
    }

    const targets = deps.targets(loginId);
    if (targets.length === 0) {
      return res.status(400).json({ ok: false, error: "Assign at least one account to Evaluations or Funded before testing." });
    }

    const results = await runLoginPositionCycles(targets, async (target) => {
      const startedAt = Date.now();
      try {
        const snapshot = await deps.inspect(target);
        return {
          loginId: target.loginId,
          group: target.stage,
          label: target.label,
          ...snapshot,
          elapsedMs: Date.now() - startedAt,
        };
      } catch (error) {
        const checkedAt = new Date().toISOString();
        return {
          loginId: target.loginId,
          group: target.stage,
          label: target.label,
          verifiedAccount: false,
          position: { status: "unknown" as const, reason: errorMessage(error), checkedAt },
          equity: null,
          checkedAt,
          elapsedMs: Date.now() - startedAt,
        };
      }
    });

    return res.json({ ok: true, placedOrder: false, loginId, results });
  });
}
