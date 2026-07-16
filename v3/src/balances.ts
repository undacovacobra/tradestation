import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface BalancePoint {
  t: string; // ISO time
  b: number; // dollars
}
export interface BalanceRecord {
  balance: number;
  updatedAt: string;
  history: BalancePoint[];
}

const HISTORY_MAX = 200;
const HISTORY_MIN_GAP_MS = 60 * 1000;

/**
 * A tiny persisted log of each account's last-known balance + a short history.
 * It's read from MEMORY on the entry path (instant — the profit-target guard
 * and the dashboard never touch the browser), and written only when the bot
 * reads a balance at arm time, during a trade, or at exit.
 */
export class BalanceLog {
  private recs: Record<string, BalanceRecord> = {};

  constructor(private readonly path: string) {
    if (existsSync(path)) {
      try {
        this.recs = JSON.parse(readFileSync(path, "utf8"));
      } catch {
        this.recs = {};
      }
    }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.recs, null, 2));
  }

  /** Last known balance for an account, or null (instant, in-memory). */
  get(label: string): number | null {
    return this.recs[label]?.balance ?? null;
  }

  /** Record a fresh balance reading for an account. */
  set(label: string, balance: number): void {
    const now = new Date().toISOString();
    const rec = this.recs[label];
    if (!rec) {
      this.recs[label] = { balance, updatedAt: now, history: [{ t: now, b: balance }] };
    } else {
      rec.balance = balance;
      rec.updatedAt = now;
      const last = rec.history[rec.history.length - 1];
      const gapOk = !last || Date.now() - new Date(last.t).getTime() >= HISTORY_MIN_GAP_MS;
      if (!last || Math.abs(balance - last.b) >= 1 || gapOk) {
        rec.history.push({ t: now, b: balance });
        if (rec.history.length > HISTORY_MAX) rec.history.splice(0, rec.history.length - HISTORY_MAX);
      }
    }
    this.save();
  }

  /** Snapshot for the dashboard, keyed by account label. */
  snapshot(): Record<string, { balance: number; updatedAt: string; history: BalancePoint[] }> {
    const out: Record<string, { balance: number; updatedAt: string; history: BalancePoint[] }> = {};
    for (const [label, rec] of Object.entries(this.recs)) {
      out[label] = { balance: rec.balance, updatedAt: rec.updatedAt, history: rec.history.slice(-60) };
    }
    return out;
  }
}
