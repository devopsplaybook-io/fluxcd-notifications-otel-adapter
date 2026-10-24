export const DEFAULT_RATE_LIMIT_PER_MINUTE = 600;
export const RATE_LIMIT_WINDOW_MS = 60_000;
export const MAX_TRACKED_CLIENTS = 10_000;

export function resolveRateLimitPerMinute(value: unknown): number {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(numeric) || numeric < 0) {
    return DEFAULT_RATE_LIMIT_PER_MINUTE;
  }
  return Math.floor(numeric);
}

interface ClientWindow {
  windowStart: number;
  count: number;
}

export interface RateLimiterOptions {
  limitPerMinute: number;
  windowMs?: number;
  maxTrackedClients?: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

// Lightweight in-process fixed-window limiter. This is one in-cluster layer:
// network policies and ingress rate limiting are the complementary controls.
export class RateLimiter {
  private readonly limitPerMinute: number;
  private readonly windowMs: number;
  private readonly maxTrackedClients: number;
  private readonly windows = new Map<string, ClientWindow>();

  constructor({
    limitPerMinute,
    windowMs = RATE_LIMIT_WINDOW_MS,
    maxTrackedClients = MAX_TRACKED_CLIENTS,
  }: RateLimiterOptions) {
    this.limitPerMinute = limitPerMinute;
    this.windowMs = windowMs;
    this.maxTrackedClients = maxTrackedClients;
  }

  public get trackedClients(): number {
    return this.windows.size;
  }

  public allow(
    clientKey: string,
    now: number = Date.now(),
  ): RateLimitDecision {
    if (this.limitPerMinute === 0) {
      return { allowed: true, retryAfterSeconds: 0 };
    }

    let window = this.windows.get(clientKey);
    if (window && now - window.windowStart >= this.windowMs) {
      this.windows.delete(clientKey);
      window = undefined;
    }
    if (!window) {
      this.makeRoom(now);
      window = { windowStart: now, count: 0 };
      this.windows.set(clientKey, window);
    }

    if (window.count >= this.limitPerMinute) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((window.windowStart + this.windowMs - now) / 1000),
        ),
      };
    }

    window.count += 1;
    return { allowed: true, retryAfterSeconds: 0 };
  }

  private makeRoom(now: number): void {
    if (this.windows.size < this.maxTrackedClients) {
      return;
    }
    for (const [key, window] of this.windows) {
      if (now - window.windowStart >= this.windowMs) {
        this.windows.delete(key);
      }
    }
    while (this.windows.size >= this.maxTrackedClients) {
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
