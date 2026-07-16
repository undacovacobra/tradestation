import type { Response, Router } from "express";
import type { EventKind } from "./events.js";
import { isGroup, type Group, type StoredAccount } from "./types.js";

interface AccountMutationStore {
  find(label: string): StoredAccount | undefined;
  upsertAccount(label: string, group: Group, name?: string, loginId?: string): StoredAccount;
  removeAccount(label: string): boolean;
  toggleAccount(label: string): boolean;
  moveAccount(label: string, direction: "up" | "down"): boolean;
  reactivate(label: string): boolean;
}

interface AccountMutationRouteDependencies {
  store: AccountMutationStore;
  hasOpenTradeForAccount(label: string): boolean;
  armNext(group: Group, options?: { force?: boolean }): void;
  pushEvent(kind: EventKind, message: string, group?: Group): unknown;
}

export function registerAccountMutationRoutes(
  api: Router,
  { store, hasOpenTradeForAccount, armNext, pushEvent }: AccountMutationRouteDependencies,
): void {
  const blockOpenTradeMutation = (label: string, res: Response): boolean => {
    if (!store.find(label) || !hasOpenTradeForAccount(label)) return false;
    res.status(409).json({ ok: false, error: "This account has an open trade and cannot be changed." });
    return true;
  };

  api.post("/accounts/add", (req, res) => {
    const label = typeof req.body?.label === "string" ? req.body.label.trim() : "";
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const loginId = typeof req.body?.loginId === "string" ? req.body.loginId.trim() : undefined;
    const group = req.body?.group;
    if (!label) return res.status(400).json({ ok: false, error: "Account id is required." });
    if (typeof group !== "string" || !isGroup(group)) {
      return res.status(400).json({ ok: false, error: "group must be 'evals' or 'funded'" });
    }
    if (blockOpenTradeMutation(label, res)) return;
    try {
      const acct = store.upsertAccount(label, group, name || undefined, loginId || undefined);
      pushEvent("info", `Account ${acct.name} (${label}) added to ${group}.`, group);
      // One Tradovate ticket can be armed at a time; a cross-group upsert arms
      // only the chosen destination group because it is the latest user intent.
      armNext(acct.group, { force: true });
      res.json({ ok: true, account: acct });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  api.post("/accounts/remove", (req, res) => {
    const label = typeof req.body?.label === "string" ? req.body.label : "";
    if (blockOpenTradeMutation(label, res)) return;
    const group = store.find(label)?.group;
    const removed = store.removeAccount(label);
    if (removed) {
      pushEvent("info", `Account ${label} removed.`);
      if (group) armNext(group);
    }
    res.json({ ok: removed });
  });

  api.post("/accounts/toggle", (req, res) => {
    const label = typeof req.body?.label === "string" ? req.body.label : "";
    if (blockOpenTradeMutation(label, res)) return;
    const group = store.find(label)?.group;
    const ok = store.toggleAccount(label);
    if (ok && group) armNext(group);
    res.json({ ok });
  });

  api.post("/accounts/move", (req, res) => {
    const label = typeof req.body?.label === "string" ? req.body.label : "";
    if (blockOpenTradeMutation(label, res)) return;
    const direction = req.body?.direction === "up" ? "up" : "down";
    const group = store.find(label)?.group;
    const ok = store.moveAccount(label, direction);
    if (ok && group) armNext(group);
    res.json({ ok });
  });

  api.post("/accounts/reactivate", (req, res) => {
    const label = typeof req.body?.label === "string" ? req.body.label : "";
    if (blockOpenTradeMutation(label, res)) return;
    const group = store.find(label)?.group;
    const ok = store.reactivate(label);
    if (ok) {
      pushEvent("info", `${store.find(label)?.name ?? label} put back into rotation.`);
      if (group) armNext(group);
    }
    res.json({ ok });
  });
}
