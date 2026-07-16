import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { Group, SavedLogin, StoredAccount } from "./types.js";
import { CredentialLaneRegistry, type CredentialLane } from "./lanes.js";
import { laneStatePath, migrateLegacyLaneState } from "./rotation.js";

const ATM_DEFAULTS_VERSION = 1;
const MULTI_LOGIN_VERSION = 1;
const CREDENTIAL_LANE_VERSION = 1;
export const PRIMARY_LOGIN_ID = "primary-tradovate";
const PRIMARY_LOGIN_NAME = "Primary Tradovate";
const PRIMARY_FIRM = "Primary prop firm";

function primaryLogin(): SavedLogin {
  return {
    id: PRIMARY_LOGIN_ID,
    name: PRIMARY_LOGIN_NAME,
    firm: PRIMARY_FIRM,
    platform: "tradovate",
    sessionDir: ".tradovate-session",
    enabled: true,
    autoConnect: true,
  };
}

export function defaultAtmPreset(group: Group): string {
  return group === "evals" ? "25" : "funded";
}

const AccountSchema = z.object({
  tradovateLabel: z.string().min(1),
  name: z.string().min(1),
  group: z.enum(["evals", "funded"]),
  enabled: z.boolean().default(true),
  /** "active" = trades; "passed" = hit the eval target, retired from rotation. */
  status: z.enum(["active", "passed"]).default("active"),
  /** Name of the saved Tradovate ATM preset to use for this account (e.g. "25").
   *  The bot selects it from the ATM dropdown at arm time so the exchange holds
   *  the stop/target. "" = leave whatever ATM is on the ticket. */
  atmPreset: z.string().default(""),
  loginId: z.string().min(1).default(PRIMARY_LOGIN_ID),
  firm: z.string().min(1).default(PRIMARY_FIRM),
});

const SavedLoginSchema = z.object({
  id: z.string().min(1).regex(/^[a-z0-9][a-z0-9_-]*$/i),
  name: z.string().min(1),
  firm: z.string().min(1),
  platform: z.literal("tradovate").default("tradovate"),
  sessionDir: z.string().min(1),
  enabled: z.boolean().default(true),
  autoConnect: z.boolean().default(false),
});

const SettingsSchema = z.object({
  /** When false the bot ignores incoming alerts (paused). */
  running: z.boolean().default(true),
  /** practice = log only, never touches the broker. live = clicks real buttons. */
  mode: z.enum(["practice", "live"]).default("practice"),
  /** Eval profit target ($) — an eval at/above this is cut and retired. */
  evalTarget: z.number().positive().default(53_000),
  accounts: z.array(AccountSchema).default([]),
  logins: z.array(SavedLoginSchema).default([]),
  atmDefaultsVersion: z.number().int().nonnegative().default(0),
  multiLoginVersion: z.number().int().nonnegative().default(0),
  credentialLaneVersion: z.number().int().nonnegative().default(0),
});

export type Settings = z.infer<typeof SettingsSchema>;
export type Mode = Settings["mode"];

/**
 * All dashboard-editable state (accounts, run/pause, practice/live), persisted
 * to data/settings.json. The user never edits this file by hand — the UI does.
 */
export class SettingsStore {
  private settings: Settings;

  constructor(private readonly path: string) {
    this.settings = this.load();
  }

  private load(): Settings {
    const currentSettings = (): Settings => SettingsSchema.parse({
      logins: [primaryLogin()],
      atmDefaultsVersion: ATM_DEFAULTS_VERSION,
      multiLoginVersion: MULTI_LOGIN_VERSION,
      credentialLaneVersion: CREDENTIAL_LANE_VERSION,
    });
    if (!existsSync(this.path)) return currentSettings();

    let settings: Settings;
    try {
      settings = SettingsSchema.parse(JSON.parse(readFileSync(this.path, "utf8")));
    } catch {
      return currentSettings();
    }

    let changed = false;
    for (const login of settings.logins) {
      if (login.id !== "evals" && login.id !== "funded") continue;
      const previous = login.id;
      const ids = new Set(settings.logins.map((candidate) => candidate.id));
      let next = `${previous}-credential`;
      let suffix = 2;
      while (ids.has(next)) next = `${previous}-credential-${suffix++}`;
      login.id = next;
      for (const account of settings.accounts) if (account.loginId === previous) account.loginId = next;
      for (const stage of ["evals", "funded"] as const) {
        migrateLegacyLaneState(
          laneStatePath(dirname(this.path), `${previous}:${stage}`),
          laneStatePath(dirname(this.path), `${next}:${stage}`),
        );
      }
      changed = true;
    }
    if (settings.atmDefaultsVersion < ATM_DEFAULTS_VERSION) {
      for (const account of settings.accounts) {
        if (!account.atmPreset.trim()) account.atmPreset = defaultAtmPreset(account.group);
      }
      settings.atmDefaultsVersion = ATM_DEFAULTS_VERSION;
      changed = true;
    }

    if (settings.multiLoginVersion < MULTI_LOGIN_VERSION) {
      if (!settings.logins.some((login) => login.id === PRIMARY_LOGIN_ID)) {
        settings.logins.unshift(primaryLogin());
      }
      const loginIds = new Set(settings.logins.map((login) => login.id));
      for (const account of settings.accounts) {
        if (!loginIds.has(account.loginId)) account.loginId = PRIMARY_LOGIN_ID;
        account.firm = settings.logins.find((login) => login.id === account.loginId)?.firm ?? PRIMARY_FIRM;
      }
      settings.multiLoginVersion = MULTI_LOGIN_VERSION;
      changed = true;
    }

    if (settings.credentialLaneVersion < CREDENTIAL_LANE_VERSION) {
      // First launch after the credential-lane upgrade must be no-order. The
      // operator can explicitly start and enable LIVE again after inspection.
      settings.mode = "practice";
      settings.running = false;
      settings.credentialLaneVersion = CREDENTIAL_LANE_VERSION;
      changed = true;
    }

    this.validateLogins(settings);
    if (changed) this.save(settings);

    return settings;
  }

  private validateLogins(settings: Settings = this.settings): void {
    const ids = new Set<string>();
    const sessions = new Set<string>();
    for (const login of settings.logins) {
      const session = login.sessionDir.trim().toLowerCase();
      if (ids.has(login.id)) throw new Error(`Duplicate login id: ${login.id}`);
      if (sessions.has(session)) throw new Error(`Session directory already belongs to another login: ${login.sessionDir}`);
      ids.add(login.id);
      sessions.add(session);
    }
    for (const account of settings.accounts) {
      if (!ids.has(account.loginId)) throw new Error(`Account ${account.tradovateLabel} references missing login ${account.loginId}`);
    }
  }

  private save(settings: Settings = this.settings): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.tmp`;
    writeFileSync(temp, JSON.stringify(settings, null, 2));
    renameSync(temp, this.path);
  }

  get running(): boolean {
    return this.settings.running;
  }
  get mode(): Mode {
    return this.settings.mode;
  }
  get accounts(): readonly StoredAccount[] {
    return this.settings.accounts;
  }

  get logins(): readonly SavedLogin[] {
    return this.settings.logins;
  }

  get evalTarget(): number {
    return this.settings.evalTarget;
  }

  get credentialLaneVersion(): number {
    return this.settings.credentialLaneVersion;
  }

  credentialLanes(): CredentialLane[] {
    return new CredentialLaneRegistry(this.settings.logins, this.settings.accounts).values();
  }

  /** Tradeable accounts of one group, in rotation order (enabled + not passed). */
  accountsIn(group: Group): StoredAccount[] {
    return this.settings.accounts.filter((a) => a.group === group && a.enabled && a.status === "active");
  }

  /** All active accounts of one group (including disabled), in rotation order. */
  allAccountsIn(group: Group): StoredAccount[] {
    return this.settings.accounts.filter((a) => a.group === group && a.status === "active");
  }

  /** Retired accounts (hit the eval target), any group. */
  passedAccounts(): StoredAccount[] {
    return this.settings.accounts.filter((a) => a.status === "passed");
  }

  markPassed(label: string): boolean {
    const acct = this.find(label);
    if (!acct || acct.status === "passed") return false;
    acct.status = "passed";
    this.save();
    return true;
  }

  reactivate(label: string): boolean {
    const acct = this.find(label);
    if (!acct || acct.status !== "passed") return false;
    acct.status = "active";
    this.save();
    return true;
  }

  find(label: string): StoredAccount | undefined {
    return this.settings.accounts.find((a) => a.tradovateLabel === label);
  }

  login(id: string): SavedLogin | undefined {
    return this.settings.logins.find((login) => login.id === id);
  }

  addLogin(
    name: string,
    firm: string,
    options: { sessionDir?: string; autoConnect?: boolean } = {},
  ): SavedLogin {
    const cleanName = name.trim();
    const cleanFirm = firm.trim();
    if (!cleanName || !cleanFirm) throw new Error("Login name and firm name are required.");
    const rawBase = cleanName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "login";
    const base = rawBase === "evals" || rawBase === "funded" ? `${rawBase}-credential` : rawBase;
    let id = base;
    let suffix = 2;
    while (this.login(id)) id = `${base}-${suffix++}`;
    const sessionDir = options.sessionDir?.trim() || `.tradovate-sessions/${id}`;
    if (this.settings.logins.some((login) => login.sessionDir.toLowerCase() === sessionDir.toLowerCase())) {
      throw new Error(`Session directory already belongs to another login: ${sessionDir}`);
    }
    const login = SavedLoginSchema.parse({
      id,
      name: cleanName,
      firm: cleanFirm,
      platform: "tradovate",
      sessionDir,
      enabled: true,
      autoConnect: options.autoConnect ?? true,
    });
    this.settings.logins.push(login);
    this.validateLogins();
    this.save();
    return login;
  }

  removeLogin(id: string): boolean {
    if (this.settings.accounts.some((account) => account.loginId === id)) {
      throw new Error(`Login ${id} still has accounts. Reassign or remove them first.`);
    }
    const before = this.settings.logins.length;
    this.settings.logins = this.settings.logins.filter((login) => login.id !== id);
    const removed = this.settings.logins.length < before;
    if (removed) this.save();
    return removed;
  }

  assignAccountLogin(label: string, loginId: string): boolean {
    const account = this.find(label);
    const login = this.login(loginId);
    if (!account) return false;
    if (!login) throw new Error(`Unknown login: ${loginId}`);
    account.loginId = login.id;
    account.firm = login.firm;
    this.save();
    return true;
  }

  setRunning(running: boolean): void {
    this.settings.running = running;
    this.save();
  }

  setMode(mode: Mode): void {
    this.settings.mode = mode;
    this.save();
  }

  /** Add a new account, or update group/name if the label already exists. */
  upsertAccount(label: string, group: Group, name?: string, loginId = PRIMARY_LOGIN_ID): StoredAccount {
    const login = this.login(loginId);
    if (!login) throw new Error(`Unknown login: ${loginId}`);
    const existing = this.find(label);
    if (existing) {
      existing.group = group;
      if (name) existing.name = name;
      existing.loginId = login.id;
      existing.firm = login.firm;
      this.save();
      return existing;
    }
    const account: StoredAccount = {
      tradovateLabel: label,
      name: name?.trim() || label,
      group,
      enabled: true,
      status: "active",
      atmPreset: defaultAtmPreset(group),
      loginId: login.id,
      firm: login.firm,
    };
    this.settings.accounts.push(account);
    this.save();
    return account;
  }

  /** Set which saved ATM preset an account uses ("" = leave the ticket's). */
  setAtmPreset(label: string, preset: string): boolean {
    const acct = this.find(label);
    if (!acct) return false;
    acct.atmPreset = preset.trim();
    this.save();
    return true;
  }

  removeAccount(label: string): boolean {
    const before = this.settings.accounts.length;
    this.settings.accounts = this.settings.accounts.filter((a) => a.tradovateLabel !== label);
    const removed = this.settings.accounts.length < before;
    if (removed) this.save();
    return removed;
  }

  toggleAccount(label: string): boolean {
    const acct = this.find(label);
    if (!acct) return false;
    acct.enabled = !acct.enabled;
    this.save();
    return true;
  }

  /** Move an account up or down WITHIN its group. */
  moveAccount(label: string, direction: "up" | "down"): boolean {
    const list = this.settings.accounts;
    const from = list.findIndex((a) => a.tradovateLabel === label);
    if (from === -1) return false;
    const group = list[from]!.group;
    const loginId = list[from]!.loginId;
    const step = direction === "up" ? -1 : 1;
    for (let i = from + step; i >= 0 && i < list.length; i += step) {
      if (list[i]!.group === group && list[i]!.loginId === loginId) {
        const tmp = list[i]!;
        list[i] = list[from]!;
        list[from] = tmp;
        this.save();
        return true;
      }
    }
    return false;
  }
}
