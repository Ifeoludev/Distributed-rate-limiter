import type { Clock, Grant } from "../limiter/tokenBucket.js";

export type LeaseGrant = Grant & { durationMs: number };

type Lease = { tokens: number; expiresAtMs: number };

// Tokens this instance has leased from other owners, so most requests for
// keys it doesn't own are decided without a network hop.
export class LeaseStore {
  private readonly leases = new Map<string, Lease>();
  private readonly inFlight = new Map<string, Promise<LeaseGrant>>();
  private readonly lowAt: number;

  constructor(
    private readonly requestLease: (key: string) => Promise<LeaseGrant>,
    leaseSize: number,
    prefetch: number,
    private readonly clock: Clock,
  ) {
    this.lowAt = leaseSize * prefetch;
  }

  // Returns the tokens left after spending, or null if the lease can't cover cost.
  spend(key: string, cost: number): number | null {
    const lease = this.live(key);
    if (!lease || lease.tokens < cost) return null;
    lease.tokens -= cost;
    return lease.tokens;
  }

  isLow(key: string): boolean {
    const lease = this.live(key);
    return !lease || lease.tokens <= this.lowAt;
  }

  // Concurrent callers share one request, or a burst on an empty lease would
  // send the owner one lease request per client request.
  refill(key: string): Promise<LeaseGrant> {
    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const request = this.requestLease(key)
      .then((grant) => {
        this.add(key, grant);
        return grant;
      })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, request);
    return request;
  }

  private add(key: string, grant: LeaseGrant): void {
    if (grant.granted === 0) return;
    // Leftovers merge into the new lease and live until its expiry: slight
    // over-admit, traded for not wasting tokens already taken from the owner.
    const tokens = (this.live(key)?.tokens ?? 0) + grant.granted;
    // The duration starts when the reply arrives, so network delay makes a
    // lease outlive what the owner assumed (a known over-admit source).
    this.leases.set(key, {
      tokens,
      expiresAtMs: this.clock() + grant.durationMs,
    });
  }

  private live(key: string): Lease | undefined {
    const lease = this.leases.get(key);
    if (lease && this.clock() >= lease.expiresAtMs) {
      this.leases.delete(key);
      return undefined;
    }
    return lease;
  }
}
