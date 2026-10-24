import {
  DEFAULT_RATE_LIMIT_PER_MINUTE,
  RATE_LIMIT_WINDOW_MS,
  RateLimiter,
  resolveRateLimitPerMinute,
} from "./RateLimiter";

describe("resolveRateLimitPerMinute", () => {
  it.each([
    [undefined, DEFAULT_RATE_LIMIT_PER_MINUTE],
    [null, DEFAULT_RATE_LIMIT_PER_MINUTE],
    ["abc", DEFAULT_RATE_LIMIT_PER_MINUTE],
    ["", DEFAULT_RATE_LIMIT_PER_MINUTE],
    ["   ", DEFAULT_RATE_LIMIT_PER_MINUTE],
    [-1, DEFAULT_RATE_LIMIT_PER_MINUTE],
    [Number.NaN, DEFAULT_RATE_LIMIT_PER_MINUTE],
    [Number.POSITIVE_INFINITY, DEFAULT_RATE_LIMIT_PER_MINUTE],
    [0, 0],
    ["0", 0],
    [600, 600],
    ["120", 120],
    [42.7, 42],
  ])("resolves %p to %p", (value, expected) => {
    expect(resolveRateLimitPerMinute(value)).toBe(expected);
  });
});

describe("RateLimiter", () => {
  it("allows requests up to the limit and rejects the next one", () => {
    const limiter = new RateLimiter({ limitPerMinute: 2 });

    expect(limiter.allow("client", 0)).toEqual({
      allowed: true,
      retryAfterSeconds: 0,
    });
    expect(limiter.allow("client", 0)).toEqual({
      allowed: true,
      retryAfterSeconds: 0,
    });
    expect(limiter.allow("client", 0)).toEqual({
      allowed: false,
      retryAfterSeconds: 60,
    });
    expect(limiter.allow("client", 0)).toEqual({
      allowed: false,
      retryAfterSeconds: 60,
    });
  });

  it("reports a shrinking retry-after within the window", () => {
    const limiter = new RateLimiter({ limitPerMinute: 1 });

    expect(limiter.allow("client", 0).allowed).toBe(true);
    expect(limiter.allow("client", 1_500)).toEqual({
      allowed: false,
      retryAfterSeconds: 59,
    });
    expect(limiter.allow("client", 59_999)).toEqual({
      allowed: false,
      retryAfterSeconds: 1,
    });
  });

  it("resets the window after exactly one window", () => {
    const limiter = new RateLimiter({ limitPerMinute: 1 });

    expect(limiter.allow("client", 0).allowed).toBe(true);
    expect(limiter.allow("client", RATE_LIMIT_WINDOW_MS - 1).allowed).toBe(
      false,
    );
    expect(limiter.allow("client", RATE_LIMIT_WINDOW_MS).allowed).toBe(true);
  });

  it("tracks clients independently", () => {
    const limiter = new RateLimiter({ limitPerMinute: 1 });

    expect(limiter.allow("a", 0).allowed).toBe(true);
    expect(limiter.allow("b", 0).allowed).toBe(true);
    expect(limiter.allow("a", 0).allowed).toBe(false);
    expect(limiter.trackedClients).toBe(2);
  });

  it("never tracks or rejects when disabled", () => {
    const limiter = new RateLimiter({ limitPerMinute: 0 });

    for (let i = 0; i < 10; i++) {
      expect(limiter.allow("client", 0)).toEqual({
        allowed: true,
        retryAfterSeconds: 0,
      });
    }
    expect(limiter.trackedClients).toBe(0);
  });

  it("purges expired windows before evicting when full", () => {
    const limiter = new RateLimiter({
      limitPerMinute: 1,
      windowMs: 1_000,
      maxTrackedClients: 2,
    });

    expect(limiter.allow("a", 0).allowed).toBe(true);
    expect(limiter.allow("b", 0).allowed).toBe(true);
    expect(limiter.allow("c", 2_000).allowed).toBe(true);
    expect(limiter.trackedClients).toBe(1);
  });

  it("evicts the oldest window when full and nothing is expired", () => {
    const limiter = new RateLimiter({
      limitPerMinute: 1,
      windowMs: 60_000,
      maxTrackedClients: 2,
    });

    expect(limiter.allow("a", 0).allowed).toBe(true);
    expect(limiter.allow("b", 10).allowed).toBe(true);
    expect(limiter.allow("c", 20).allowed).toBe(true);
    expect(limiter.trackedClients).toBe(2);

    // "a" was evicted, "b" is still tracked.
    expect(limiter.allow("b", 30).allowed).toBe(false);
    expect(limiter.allow("a", 40).allowed).toBe(true);
    expect(limiter.trackedClients).toBe(2);
  });

  it("keeps the tracked client count bounded", () => {
    const limiter = new RateLimiter({
      limitPerMinute: 10,
      maxTrackedClients: 3,
    });

    for (let i = 0; i < 100; i++) {
      limiter.allow(`client-${i}`, i * 10);
      expect(limiter.trackedClients).toBeLessThanOrEqual(3);
    }
  });
});
