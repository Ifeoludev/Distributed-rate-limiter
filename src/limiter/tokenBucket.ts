export interface Limiter {
  allow(key: string, cost?: number): Decision;
}

export type Decision = {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number; // 0 when allowed
};

export type Grant = {
  granted: number;
  retryAfterMs: number; // 0 when granted > 0
};

export type Rule = { capacity: number; refillPerSec: number };
export type Clock = () => number; // milliseconds, injected for tests

type Bucket = { tokens: number; lastRefillMs: number };

export class TokenBucketLimiter implements Limiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly refillPerMs: number;

  constructor(
    private readonly rule: Rule,
    private readonly clock: Clock,
  ) {
    this.refillPerMs = rule.refillPerSec / 1000;
  }

  allow(key: string, cost = 1): Decision {
    // Tokens are capped at capacity, so a cost above it could never be
    // reached and would produce a retryAfterMs that never resolves.
    if (cost > this.rule.capacity) {
      throw new Error(
        `cost (${cost}) exceeds bucket capacity (${this.rule.capacity})`,
      );
    }

    const bucket = this.refill(key);

    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      return {
        allowed: true,
        remaining: Math.floor(bucket.tokens),
        retryAfterMs: 0,
      };
    }

    const retryAfterMs = Math.ceil((cost - bucket.tokens) / this.refillPerMs);
    return { allowed: false, remaining: 0, retryAfterMs };
  }

  // Lease grants are partial: an all-or-nothing grant would starve non-owners
  // under load, because the owner's own requests keep the bucket below `max`.
  take(key: string, max: number): Grant {
    const bucket = this.refill(key);
    const granted = Math.min(max, Math.floor(bucket.tokens));
    if (granted > 0) {
      bucket.tokens -= granted;
      return { granted, retryAfterMs: 0 };
    }
    const retryAfterMs = Math.ceil((1 - bucket.tokens) / this.refillPerMs);
    return { granted: 0, retryAfterMs };
  }

  private refill(key: string): Bucket {
    const now = this.clock();
    const bucket = this.buckets.get(key) ?? {
      tokens: this.rule.capacity,
      lastRefillMs: now,
    };

    const elapsed = now - bucket.lastRefillMs;
    bucket.tokens = Math.min(
      this.rule.capacity,
      bucket.tokens + elapsed * this.refillPerMs,
    );
    bucket.lastRefillMs = now;
    this.buckets.set(key, bucket);
    return bucket;
  }
}
