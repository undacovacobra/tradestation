import type { Router } from "express";
import type { EventKind } from "./events.js";
import type { Group, SavedLogin, StoredAccount } from "./types.js";

interface RouteWorker {
  connect(): Promise<unknown>;
  status(): unknown;
  discoverAccounts(): Promise<string[]>;
  invalidateReady(): void;
}

interface RouteManager {
  add(login: SavedLogin): RouteWorker;
  get(id: string): RouteWorker | undefined;
  remove(id: string): Promise<void>;
}

interface RouteStore {
  readonly logins: readonly SavedLogin[];
  readonly accounts: readonly StoredAccount[];
  addLogin(name: string, firm: string): SavedLogin;
  removeLogin(id: string): boolean;
  login(id: string): SavedLogin | undefined;
  find(label: string): StoredAccount | undefined;
  assignAccountLogin(label: string, loginId: string): boolean;
}

interface LoginRouteDependencies {
  store: RouteStore;
  manager: RouteManager;
  hasOpenTradeForLogin(loginId: string): boolean;
  hasOpenTradeForAccount(label: string): boolean;
  armLogin(loginId: string): Promise<void>;
  reconcileLogin?(loginId: string): Promise<void>;
  armNext(group: Group, options?: { force?: boolean }): void;
  pushEvent(kind: EventKind, message: string, group?: Group): unknown;
}

export function registerLoginRoutes(api: Router, deps: LoginRouteDependencies): void {
  api.post("/logins", (req, res) => {
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const firm = typeof req.body?.firm === "string" ? req.body.firm.trim() : "";
    if (!name || !firm) return res.status(400).json({ ok: false, error: "Login name and firm name are required." });
    let login: SavedLogin | undefined;
    try {
      login = deps.store.addLogin(name, firm);
      deps.manager.add(login);
      deps.pushEvent("info", `Added Tradovate login ${login.name} for ${login.firm}.`);
      return res.status(201).json({ ok: true, login });
    } catch (error) {
      if (login) {
        try { deps.store.removeLogin(login.id); } catch { /* keep the original failure */ }
      }
      return res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  api.post("/logins/:id/connect", async (req, res) => {
    const worker = deps.manager.get(req.params.id);
    if (!worker) return res.status(404).json({ ok: false, error: "Unknown login" });
    try {
      const ownsRecordedTrade = deps.hasOpenTradeForLogin(req.params.id);
      await worker.connect();
      if (ownsRecordedTrade) await deps.reconcileLogin?.(req.params.id);
      else await deps.armLogin(req.params.id);
      return res.json({ ok: true, status: worker.status() });
    } catch (error) {
      return res.status(503).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  api.get("/logins/:id/accounts", async (req, res) => {
    const worker = deps.manager.get(req.params.id);
    if (!worker) return res.status(404).json({ ok: false, error: "Unknown login" });
    try {
      const labels = await worker.discoverAccounts();
      const known = deps.store.accounts.filter((account) => account.loginId === req.params.id).map((account) => account.tradovateLabel);
      return res.json({
        ok: true,
        loginId: req.params.id,
        labels,
        unknown: labels.filter((label) => !known.includes(label)),
        missing: known.filter((label) => !labels.includes(label)),
      });
    } catch (error) {
      return res.status(503).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  api.delete("/logins/:id", async (req, res) => {
    const id = req.params.id;
    try {
      if (deps.hasOpenTradeForLogin(id)) throw new Error("This login has an open trade.");
      if (deps.store.accounts.some((account) => account.loginId === id)) {
        throw new Error("This login still has accounts. Reassign or remove them first.");
      }
      await deps.manager.remove(id);
      deps.store.removeLogin(id);
      deps.pushEvent("info", `Removed Tradovate login ${id}.`);
      return res.json({ ok: true });
    } catch (error) {
      return res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  api.post("/accounts/login", (req, res) => {
    const label = typeof req.body?.label === "string" ? req.body.label.trim() : "";
    const loginId = typeof req.body?.loginId === "string" ? req.body.loginId.trim() : "";
    const account = deps.store.find(label);
    if (!account) return res.status(404).json({ ok: false, error: "Unknown account" });
    if (!deps.store.login(loginId)) return res.status(400).json({ ok: false, error: "Unknown login" });
    if (deps.hasOpenTradeForAccount(label)) return res.status(400).json({ ok: false, error: "This account has an open trade." });
    const previousLoginId = account.loginId;
    try {
      const ok = deps.store.assignAccountLogin(label, loginId);
      deps.manager.get(previousLoginId)?.invalidateReady();
      deps.manager.get(loginId)?.invalidateReady();
      deps.armNext(account.group, { force: true });
      deps.pushEvent("info", `${account.name} assigned to ${deps.store.login(loginId)?.name}.`, account.group);
      return res.json({ ok, account: deps.store.find(label) });
    } catch (error) {
      return res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
}
