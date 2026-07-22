export type CredentialTaskKind =
  | "close"
  | "funded-entry"
  | "eval-entry"
  | "winning-entry"
  | "funded-maintenance"
  | "winning-maintenance"
  | "eval-maintenance"
  | "diagnostic";

export interface SchedulerSnapshot {
  running: boolean;
  totalPending: number;
  pending: Partial<Record<CredentialTaskKind, number>>;
}

interface ScheduledTask<T> {
  sequence: number;
  kind: CredentialTaskKind;
  readyAt: number;
  run: () => Promise<T> | T;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

// eval-maintenance sorts AFTER the other maintenance kinds on purpose: whatever
// is prepared last is the account the browser rests on, and the bot is meant to
// come to rest armed on the next eval account.
const PRIORITY: Record<CredentialTaskKind, number> = {
  close: 0,
  "funded-entry": 1,
  "eval-entry": 2,
  "winning-entry": 3,
  "funded-maintenance": 4,
  "winning-maintenance": 5,
  "eval-maintenance": 6,
  diagnostic: 7,
};

export class CredentialPriorityScheduler {
  private readonly fundedWindowMs: number;
  private readonly now: () => number;
  // The public promise preserves T; the internal queue intentionally erases it
  // because tasks of different result types share one credential scheduler.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private queue: ScheduledTask<any>[] = [];
  private running = false;
  private sequence = 0;
  private wakeTimer: NodeJS.Timeout | undefined;

  constructor(options: { fundedWindowMs?: number; now?: () => number } = {}) {
    // Guard against a non-finite window (e.g. a bad env value): a NaN readyAt
    // would make eval-entry tasks never become eligible and silently stall.
    this.fundedWindowMs = Number.isFinite(options.fundedWindowMs) ? Math.max(0, options.fundedWindowMs!) : 75;
    this.now = options.now ?? Date.now;
  }

  enqueue<T>(
    kind: CredentialTaskKind,
    run: () => Promise<T> | T,
    options: { skipFundedWindow?: boolean } = {},
  ): Promise<T> {
    const windowMs = kind === "eval-entry" && !options.skipFundedWindow
      ? this.fundedWindowMs
      : 0;
    const promise = new Promise<T>((resolve, reject) => {
      this.queue.push({
        sequence: this.sequence++,
        kind,
        readyAt: this.now() + windowMs,
        run,
        resolve,
        reject,
      });
    });
    this.wake();
    return promise;
  }

  snapshot(): SchedulerSnapshot {
    const pending: Partial<Record<CredentialTaskKind, number>> = {};
    for (const item of this.queue) pending[item.kind] = (pending[item.kind] ?? 0) + 1;
    return { running: this.running, totalPending: this.queue.length, pending };
  }

  cancel(kind: CredentialTaskKind, reason: Error): number {
    const cancelled = this.queue.filter((item) => item.kind === kind);
    if (cancelled.length === 0) return 0;
    this.queue = this.queue.filter((item) => item.kind !== kind);
    for (const item of cancelled) item.reject(reason);
    this.wake();
    return cancelled.length;
  }

  private wake(): void {
    if (this.running) return;
    if (this.wakeTimer) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = undefined;
    }
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    const now = this.now();
    const eligible = this.queue
      .filter((item) => item.readyAt <= now)
      .sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind] || a.sequence - b.sequence);

    const next = eligible[0];
    if (!next) {
      if (this.queue.length > 0 && !this.wakeTimer) {
        const waitMs = Math.max(0, Math.min(...this.queue.map((item) => item.readyAt)) - now);
        this.wakeTimer = setTimeout(() => {
          this.wakeTimer = undefined;
          void this.drain();
        }, waitMs);
      }
      return;
    }

    this.queue = this.queue.filter((item) => item !== next);
    this.running = true;
    try {
      next.resolve(await next.run());
    } catch (error) {
      next.reject(error);
    } finally {
      this.running = false;
      this.wake();
    }
  }
}
