import {
  MAX_TRACKED_REJECTION_KEYS,
  REJECTION_LOG_WINDOW_MS,
  RejectionLogSampler,
} from "./RejectionLogSampler";

describe("RejectionLogSampler", () => {
  it("logs the first event of a window and suppresses repeats", () => {
    const sampler = new RejectionLogSampler();

    expect(sampler.check("key", 0)).toEqual({ log: true, suppressed: 0 });
    expect(sampler.check("key", 1)).toEqual({ log: false, suppressed: 0 });
    expect(sampler.check("key", 2)).toEqual({ log: false, suppressed: 0 });
  });

  it("logs again in the next window and reports the suppressed count", () => {
    const sampler = new RejectionLogSampler();

    expect(sampler.check("key", 0).log).toBe(true);
    expect(sampler.check("key", 1).log).toBe(false);
    expect(sampler.check("key", 2).log).toBe(false);
    expect(sampler.check("key", REJECTION_LOG_WINDOW_MS)).toEqual({
      log: true,
      suppressed: 2,
    });
  });

  it("keeps independent windows per key", () => {
    const sampler = new RejectionLogSampler();

    expect(sampler.check("a", 0).log).toBe(true);
    expect(sampler.check("b", 0).log).toBe(true);
    expect(sampler.check("a", 0).log).toBe(false);
    expect(sampler.check("b", 0).log).toBe(false);
    expect(sampler.trackedKeys).toBe(2);
  });

  it("purges expired windows before evicting when full", () => {
    const sampler = new RejectionLogSampler(1_000, 2);

    sampler.check("a", 0);
    sampler.check("b", 0);
    expect(sampler.trackedKeys).toBe(2);

    sampler.check("c", 2_000);
    expect(sampler.trackedKeys).toBe(1);
  });

  it("evicts the oldest window when full and nothing is expired", () => {
    const sampler = new RejectionLogSampler(60_000, 2);

    sampler.check("a", 0);
    sampler.check("b", 10);
    sampler.check("c", 20);

    expect(sampler.trackedKeys).toBe(2);
    // "a" was evicted (and its counter reset): its next event opens a fresh
    // window, which evicts "b" as the new oldest entry.
    expect(sampler.check("a", 30)).toEqual({ log: true, suppressed: 0 });
    // "c" is still tracked and suppressed.
    expect(sampler.check("c", 30)).toEqual({ log: false, suppressed: 0 });
  });

  it("keeps the tracked key count bounded", () => {
    const sampler = new RejectionLogSampler();

    for (let i = 0; i < MAX_TRACKED_REJECTION_KEYS * 4; i++) {
      sampler.check(`key-${i}`, i);
      expect(sampler.trackedKeys).toBeLessThanOrEqual(
        MAX_TRACKED_REJECTION_KEYS,
      );
    }
  });
});
