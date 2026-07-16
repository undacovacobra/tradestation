/** Edge-triggered futures trading-day detector. */
export class TradingDayRollover {
  private prior: string;

  constructor(private readonly dayKey: () => string) {
    this.prior = dayKey();
  }

  get current(): string { return this.prior; }

  check(): boolean {
    const next = this.dayKey();
    if (next === this.prior) return false;
    this.prior = next;
    return true;
  }
}
