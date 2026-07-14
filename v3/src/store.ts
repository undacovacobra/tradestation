import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { Group, StoredAccount } from "./types.js";

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
});

const SettingsSchema = z.object({
  /** When false the bot ignores incoming alerts (paused). */
  running: z.boolean().default(true),
  /** practice = log only, never touches the broker. live = clicks real buttons. */
  mode: z.enum(["practice", "live"]).default("practice"),
  /** Eval profit target ($) — an eval at/above this is cut and retired. */
  evalTarget: z.number().positive().default(53_000),
  accounts: z.array(AccountSchema).default([]),
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
    if (!existsSync(this.path)) return SettingsSchema.parse({});
    try {
      return SettingsSchema.parse(JSON.parse(readFileSync(this.path, "utf8")));
    } catch {
      return SettingsSchema.parse({});
    }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.settings, null, 2));
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

  get evalTarget(): number {
    return this.settings.evalTarget;
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

  setRunning(running: boolean): void {
    this.settings.running = running;
    this.save();
  }

  setMode(mode: Mode): void {
    this.settings.mode = mode;
    this.save();
  }

  /** Add a new account, or update group/name if the label already exists. */
  upsertAccount(label: string, group: Group, name?: string): StoredAccount {
    const existing = this.find(label);
    if (existing) {
      existing.group = group;
      if (name) existing.name = name;
      this.save();
      return existing;
    }
    const account: StoredAccount = { tradovateLabel: label, name: name?.trim() || label, group, enabled: true, status: "active", atmPreset: "" };
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
    const step = direction === "up" ? -1 : 1;
    for (let i = from + step; i >= 0 && i < list.length; i += step) {
      if (list[i]!.group === group) {
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
