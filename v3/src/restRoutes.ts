import type { Router } from "express";

import type { EventKind } from "./events.js";
import type { Group, StoredAccount } from "./types.js";

interface RestRouteDependencies {
  findAccount(label: string): StoredAccount | undefined;
  hasOpenTrade(label: string): boolean;
  hasActiveWork?(loginId: string): boolean;
  markRest(loginId: string, group: Group, label: string): boolean;
  clearRest(loginId: string, group: Group, label: string): boolean;
  rearm(loginId: string, group: Group): void;
  pushEvent(kind: EventKind, message: string, group?: Group): unknown;
}

function requestIdentity(body: unknown): { loginId: string; group: string; label: string } {
  const value = body && typeof body === "object" ? body as Record<string, unknown> : {};
  return {
    loginId: typeof value.loginId === "string" ? value.loginId.trim() : "",
    group: typeof value.group === "string" ? value.group.trim() : "",
    label: typeof value.label === "string" ? value.label.trim() : "",
  };
}

export function registerRestRoutes(api: Router, deps: RestRouteDependencies): void {
  api.post("/accounts/rest", (req, res) => {
    const { loginId, group, label } = requestIdentity(req.body);
    if (group !== "evals") {
      return res.status(400).json({ ok: false, error: "Only evaluation accounts use the won-today rest policy." });
    }
    const account = deps.findAccount(label);
    if (!account || account.loginId !== loginId || account.group !== group) {
      return res.status(404).json({ ok: false, error: "This evaluation is not assigned to that Tradovate login." });
    }
    if (deps.hasOpenTrade(label)) {
      return res.status(409).json({ ok: false, error: "This evaluation has an open trade and cannot rest until the broker confirms it is flat." });
    }
    if (deps.hasActiveWork?.(loginId)) {
      return res.status(409).json({ ok: false, error: "This Tradovate login is handling broker work. Mark the evaluation won again after it finishes." });
    }
    const changed = deps.markRest(loginId, group, label);
    if (changed) {
      deps.pushEvent("info", `${account.name} was manually marked WON TODAY and will rest until 6:00 PM ET.`, group);
      deps.rearm(loginId, group);
    }
    return res.json({ ok: true, restingToday: true, changed });
  });

  api.post("/accounts/unrest", (req, res) => {
    const { loginId, group, label } = requestIdentity(req.body);
    if (group !== "evals") {
      return res.status(400).json({ ok: false, error: "Only evaluation accounts use the won-today rest policy." });
    }
    const account = deps.findAccount(label);
    if (!account || account.loginId !== loginId || account.group !== group) {
      return res.status(404).json({ ok: false, error: "This evaluation is not assigned to that Tradovate login." });
    }
    if (deps.hasActiveWork?.(loginId)) {
      return res.status(409).json({ ok: false, error: "This Tradovate login is handling broker work. Put the evaluation back after it finishes." });
    }
    const changed = deps.clearRest(loginId, group, label);
    if (changed) {
      deps.pushEvent("info", `${account.name} was put back into today's evaluation rotation.`, group);
      deps.rearm(loginId, group);
    }
    return res.json({ ok: true, restingToday: false, changed });
  });
}
