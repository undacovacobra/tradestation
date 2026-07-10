/**
 * The in-trade balance watcher — the thing that cuts a trade at the profit
 * target. It is deliberately tiny and LAZY:
 *
 *  - When NO trade is open it does nothing at all (no browser, no switching).
 *  - When a trade IS open it wakes every `activeMs`, reads ONLY the already-
 *    selected account's balance (the trade account is the selected one), and
 *    lets the injected `tick` decide whether to cut.
 *
 * It never opens the account dropdown and never switches accounts, so it can't
 * interfere with an entry click. All the real work lives in `tick`; this class
 * is just a self-rescheduling timer that gates on `isActive`.
 */
export class Monitor {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(
    private readonly tick: () => Promise<void>,
    private readonly opts: { activeMs: number; isActive: () => boolean },
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
        await this.tick().catch(() => {});
      }
      this.schedule();
    }, this.opts.activeMs);
  }
}
