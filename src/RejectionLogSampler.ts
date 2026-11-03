export const REJECTION_LOG_WINDOW_MS = 60_000;
// Keys are method/route-template/status/reason combinations, so this cap is a
// safety bound rather than an expected cardinality.
export const MAX_TRACKED_REJECTION_KEYS = 256;

export interface RejectionLogDecision {
  log: boolean;
  suppressed: number;
}

interface SamplerWindow {
  windowStart: number;
  suppressed: number;
}

/**
 * Bounded rolling-window sampler: the first event for a key in each window is
 * logged, later events are counted as suppressed and reported on the first
 * event of the next window. Rejection metrics stay exact: the caller always
 * records the event before consulting the sampler.
 */
export class RejectionLogSampler {
  private readonly windows = new Map<string, SamplerWindow>();

  constructor(
    private readonly windowMs: number = REJECTION_LOG_WINDOW_MS,
    private readonly maxKeys: number = MAX_TRACKED_REJECTION_KEYS,
  ) {}

  public get trackedKeys(): number {
    return this.windows.size;
  }

  public check(key: string, now: number = Date.now()): RejectionLogDecision {
    const existing = this.windows.get(key);
    if (existing && now - existing.windowStart < this.windowMs) {
      existing.suppressed += 1;
      return { log: false, suppressed: 0 };
    }
    const suppressed = existing ? existing.suppressed : 0;
    if (!existing) {
      this.makeRoom(now);
    }
    this.windows.set(key, { windowStart: now, suppressed: 0 });
    return { log: true, suppressed };
  }

  private makeRoom(now: number): void {
    if (this.windows.size < this.maxKeys) {
      return;
    }
    for (const [key, window] of this.windows) {
      if (now - window.windowStart >= this.windowMs) {
        this.windows.delete(key);
      }
    }
    while (this.windows.size >= this.maxKeys) {
      let oldestKey: string | undefined;
      let oldestStart = Number.POSITIVE_INFINITY;
      for (const [key, window] of this.windows) {
        if (window.windowStart < oldestStart) {
          oldestStart = window.windowStart;
          oldestKey = key;
        }
      }
      if (oldestKey === undefined) {
        return;
      }
      this.windows.delete(oldestKey);
    }
  }
}
