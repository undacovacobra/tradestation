/**
 * The in-trade balance watcher — the thing that cuts a trade at the profit
 * target. It is deliberately tiny and LAZY:
 *
 *  - When NO trade is open it does nothing at all (no browser, no switching).
 *  - When a trade IS open it wakes every `activeMs` and lets the injected
 *    broker-reconciliation tick inspect every recorded account.
 *
 * All browser work lives in `tick` and is serialized by credential queues;
 * this class is only a self-rescheduling timer that gates on `isActive`.
 */
export class Monitor {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(
    private readonly tick: () => Promise<void>,
    private readonly opts: {
      activeMs: number;
      isActive: () => boolean;
      onError?: (error: unknown) => void;
    },
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    if (!this.running) return;
    this.timer = setTimeout(async () => {
      if (this.opts.isActive()) {
        await this.tick().catch((error) => this.opts.onError?.(error));
      }
      this.schedule();
    }, this.opts.activeMs);
  }
}
