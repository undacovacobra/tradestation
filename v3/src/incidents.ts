export interface IncidentSnapshot {
  message: string;
  openedAt: string;
  healthyReads: number;
}

/** Deduplicates noisy operational faults until evidence is stably healthy. */
export class IncidentRegistry {
  private readonly incidents = new Map<string, IncidentSnapshot>();
  private readonly healthyReadsToResolve: number;

  constructor(options: { healthyReadsToResolve?: number } = {}) {
    this.healthyReadsToResolve = Math.max(1, options.healthyReadsToResolve ?? 2);
  }

  /** Returns true only when this is a newly opened incident and should alert. */
  raise(key: string, message: string, at: Date = new Date()): boolean {
    const existing = this.incidents.get(key);
    if (existing) {
      existing.message = message;
      existing.healthyReads = 0;
      return false;
    }
    this.incidents.set(key, { message, openedAt: at.toISOString(), healthyReads: 0 });
    return true;
  }

  /** Returns true when the required consecutive healthy evidence resolved it. */
  healthy(key: string): boolean {
    const existing = this.incidents.get(key);
    if (!existing) return false;
    existing.healthyReads++;
    if (existing.healthyReads < this.healthyReadsToResolve) return false;
    this.incidents.delete(key);
    return true;
  }

  clear(key: string): boolean { return this.incidents.delete(key); }
  get(key: string): IncidentSnapshot | undefined {
    const value = this.incidents.get(key);
    return value ? { ...value } : undefined;
  }
  snapshot(): Record<string, IncidentSnapshot> {
    return Object.fromEntries([...this.incidents].map(([key, value]) => [key, { ...value }]));
  }
}
