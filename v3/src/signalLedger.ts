import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Small durable completed-signal ledger. In-flight coalescing remains in the
 * webhook router; this closes the restart/retry duplicate-entry gap. */
export class SignalLedger {
  private entries: Record<string, number>;

  constructor(private readonly path: string, private readonly maxEntries = 5_000) {
    if (!existsSync(path)) {
      this.entries = {};
      return;
    }
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("expected an object");
      this.entries = Object.fromEntries(
        Object.entries(parsed).filter((entry): entry is [string, number] => typeof entry[1] === "number"),
      );
    } catch (error) {
      throw new Error(
        `Signal ledger ${path} could not be read safely; refusing to forget completed webhooks. `
        + `(${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.tmp`;
    writeFileSync(temp, JSON.stringify(this.entries, null, 2));
    renameSync(temp, this.path);
  }

  has(key: string, now = Date.now()): boolean {
    const expiresAt = this.entries[key];
    if (expiresAt == null) return false;
    if (expiresAt > now) return true;
    delete this.entries[key];
    this.save();
    return false;
  }

  mark(key: string, ttlMs: number, now = Date.now()): void {
    this.entries[key] = now + ttlMs;
    const keys = Object.keys(this.entries);
    if (keys.length > this.maxEntries) {
      keys.sort((a, b) => this.entries[a]! - this.entries[b]!);
      for (const stale of keys.slice(0, keys.length - this.maxEntries)) delete this.entries[stale];
    }
    this.save();
  }
}
