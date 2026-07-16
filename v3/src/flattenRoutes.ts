import type { Router } from "express";

import type { FlattenResult } from "./flattenPositions.js";
import { isGroup, type Group } from "./types.js";

export interface FlattenOneRequest {
  loginId: string;
  group: Group;
  label: string;
}

export interface FlattenRouteDependencies {
  getRunning(): boolean;
  flattenAll(): Promise<FlattenResult[]>;
  flattenOne(target: FlattenOneRequest): Promise<FlattenResult>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function registerFlattenRoutes(api: Router, deps: FlattenRouteDependencies): void {
  api.post("/positions/flatten-all", async (req, res) => {
    if (req.body?.confirm !== "FLATTEN ALL") {
      return res.status(400).json({ ok: false, error: "Explicit FLATTEN ALL confirmation is required." });
    }

    try {
      const results = await deps.flattenAll();
      const failed = results.some((result) => result.outcome === "failed");
      return res.status(failed ? 207 : 200).json({
        ok: !failed,
        running: deps.getRunning(),
        results,
      });
    } catch (error) {
      return res.status(500).json({ ok: false, running: deps.getRunning(), error: errorMessage(error) });
    }
  });

  api.post("/positions/flatten-one", async (req, res) => {
    if (req.body?.confirm !== "FLATTEN ONE") {
      return res.status(400).json({ ok: false, error: "Explicit FLATTEN ONE confirmation is required." });
    }

    const loginId = typeof req.body?.loginId === "string" ? req.body.loginId.trim() : "";
    const rawGroup = typeof req.body?.group === "string" ? req.body.group.trim() : "";
    const label = typeof req.body?.label === "string" ? req.body.label.trim() : "";
    if (!loginId || !isGroup(rawGroup) || !label) {
      return res.status(400).json({ ok: false, error: "A valid login, account group, and account label are required." });
    }

    try {
      const result = await deps.flattenOne({ loginId, group: rawGroup, label });
      const failed = result.outcome === "failed";
      return res.status(failed ? 409 : 200).json({
        ok: !failed,
        running: deps.getRunning(),
        result,
      });
    } catch (error) {
      return res.status(409).json({ ok: false, running: deps.getRunning(), error: errorMessage(error) });
    }
  });
}
