import { describe, expect, it } from "vitest";
import { TokenBucketLimiter } from "../src/limiter/tokenBucket.js";
import type { Clock } from "../src/limiter/tokenBucket.js";

function fakeClock(start = 0): { clock: Clock; advance: (ms: number) => void } {
  let now = start;
  return {
    clock: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("TokenBucketLimiter", () => {
  it("allows up to capacity requests from a full bucket, then blocks", () => {
    const { clock } = fakeClock();
    const limiter = new TokenBucketLimiter(
      { capacity: 5, refillPerSec: 1 },
      clock,
    );

    for (let i = 0; i < 5; i++) {
      expect(limiter.allow("k").allowed).toBe(true);
    }
    expect(limiter.allow("k").allowed).toBe(false);
  });

  it("reports decreasing remaining tokens as requests are admitted", () => {
    const { clock } = fakeClock();
    const limiter = new TokenBucketLimiter(
      { capacity: 3, refillPerSec: 1 },
      clock,
    );

    expect(limiter.allow("k").remaining).toBe(2);
    expect(limiter.allow("k").remaining).toBe(1);
    expect(limiter.allow("k").remaining).toBe(0);
  });

  it("refills tokens based on elapsed time after a pause", () => {
    const { clock, advance } = fakeClock();
    const limiter = new TokenBucketLimiter(
      { capacity: 10, refillPerSec: 10 },
      clock,
    );

    for (let i = 0; i < 10; i++) limiter.allow("k");
    expect(limiter.allow("k").allowed).toBe(false);

    advance(500); // half a second at 10/sec => 5 tokens back
    const decision = limiter.allow("k");
    expect(decision.allowed).toBe(true);
    expect(decision.remaining).toBe(4);
  });

  it("never refills past capacity even after a long pause", () => {
    const { clock, advance } = fakeClock();
    const limiter = new TokenBucketLimiter(
      { capacity: 5, refillPerSec: 10 },
      clock,
    );

    limiter.allow("k"); // spend one, 4 left
    advance(60_000); // way more than enough to refill fully
    const decision = limiter.allow("k");
    expect(decision.allowed).toBe(true);
    expect(decision.remaining).toBe(4); // capacity(5) - 1 just spent
  });

  it("computes retryAfterMs for a blocked request", () => {
    const { clock } = fakeClock();
    const limiter = new TokenBucketLimiter(
      { capacity: 1, refillPerSec: 2 },
      clock,
    );

    limiter.allow("k"); // bucket now empty
    const decision = limiter.allow("k");
    expect(decision.allowed).toBe(false);
    expect(decision.remaining).toBe(0);
    // need 1 token at 2/sec => 500ms
    expect(decision.retryAfterMs).toBe(500);
  });

  it("gives each key its own independent bucket", () => {
    const { clock } = fakeClock();
    const limiter = new TokenBucketLimiter(
      { capacity: 1, refillPerSec: 1 },
      clock,
    );

    expect(limiter.allow("a").allowed).toBe(true);
    expect(limiter.allow("a").allowed).toBe(false);
    expect(limiter.allow("b").allowed).toBe(true);
  });

  it("throws if cost is greater than capacity", () => {
    const { clock } = fakeClock();
    const limiter = new TokenBucketLimiter(
      { capacity: 5, refillPerSec: 1 },
      clock,
    );

    expect(() => limiter.allow("k", 6)).toThrow();
  });

  it("supports spending more than one token per request", () => {
    const { clock } = fakeClock();
    const limiter = new TokenBucketLimiter(
      { capacity: 10, refillPerSec: 1 },
      clock,
    );

    const decision = limiter.allow("k", 4);
    expect(decision.allowed).toBe(true);
    expect(decision.remaining).toBe(6);
  });
});

describe("TokenBucketLimiter.take", () => {
  it("grants the full amount when the bucket has enough tokens", () => {
    const { clock } = fakeClock();
    const limiter = new TokenBucketLimiter(
      { capacity: 100, refillPerSec: 1 },
      clock,
    );

    expect(limiter.take("k", 10)).toEqual({ granted: 10, retryAfterMs: 0 });
    expect(limiter.allow("k").remaining).toBe(89);
  });

  it("grants only the whole tokens left when the bucket is low", () => {
    const { clock } = fakeClock();
    const limiter = new TokenBucketLimiter(
      { capacity: 10, refillPerSec: 1 },
      clock,
    );

    limiter.allow("k", 6); // 4 left
    expect(limiter.take("k", 10)).toEqual({ granted: 4, retryAfterMs: 0 });
    expect(limiter.allow("k").allowed).toBe(false);
  });

  it("grants nothing from an empty bucket and says when a token returns", () => {
    const { clock, advance } = fakeClock();
    const limiter = new TokenBucketLimiter(
      { capacity: 2, refillPerSec: 4 },
      clock,
    );

    limiter.allow("k", 2);
    advance(100); // 0.4 of a token back
    // 0.6 of a token still missing at 4/sec => 150ms
    expect(limiter.take("k", 5)).toEqual({ granted: 0, retryAfterMs: 150 });
  });

  it("refills lazily before granting", () => {
    const { clock, advance } = fakeClock();
    const limiter = new TokenBucketLimiter(
      { capacity: 10, refillPerSec: 10 },
      clock,
    );

    limiter.allow("k", 10);
    advance(300); // 3 tokens back
    expect(limiter.take("k", 10).granted).toBe(3);
  });
});

describe("TokenBucketLimiter.sweep", () => {
  it("deletes buckets that have refilled to full and keeps the rest", () => {
    const { clock, advance } = fakeClock();
    const limiter = new TokenBucketLimiter(
      { capacity: 10, refillPerSec: 10 },
      clock,
    );

    limiter.allow("idle", 10);
    advance(500);
    limiter.allow("busy", 10);
    advance(500); // "idle" is full again after 1s; "busy" has 5 tokens back

    expect(limiter.sweep()).toBe(1);
    expect(limiter.sweep()).toBe(0);
  });

  it("keeps a partly used bucket's state after a sweep", () => {
    const { clock, advance } = fakeClock();
    const limiter = new TokenBucketLimiter(
      { capacity: 10, refillPerSec: 10 },
      clock,
    );

    limiter.allow("k", 10);
    advance(300); // 3 tokens back
    limiter.sweep();
    expect(limiter.allow("k", 3).allowed).toBe(true);
    expect(limiter.allow("k").allowed).toBe(false);
  });

  it("a swept key behaves exactly like a fresh full bucket", () => {
    const { clock, advance } = fakeClock();
    const limiter = new TokenBucketLimiter(
      { capacity: 10, refillPerSec: 10 },
      clock,
    );

    limiter.allow("k", 10);
    advance(1000);
    expect(limiter.sweep()).toBe(1);
    expect(limiter.allow("k", 10)).toEqual({
      allowed: true,
      remaining: 0,
      retryAfterMs: 0,
    });
    expect(limiter.allow("k").allowed).toBe(false);
  });
});
