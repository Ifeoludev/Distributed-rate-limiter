import { describe, expect, it } from "vitest";
import type { Clock } from "../src/limiter/tokenBucket.js";
import { LeaseStore, type LeaseGrant } from "../src/node/leases.js";

function fakeClock(start = 0): { clock: Clock; advance: (ms: number) => void } {
  let now = start;
  return {
    clock: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function grant(granted: number, durationMs = 1000, retryAfterMs = 0): LeaseGrant {
  return { granted, durationMs, retryAfterMs };
}

// Lease size 10, prefetch at 20% => low at 2 tokens or fewer.
function store(requestLease: (key: string) => Promise<LeaseGrant>, clock: Clock): LeaseStore {
  return new LeaseStore(requestLease, 10, 0.2, clock);
}

describe("LeaseStore", () => {
  it("cannot spend before any lease is granted", () => {
    const { clock } = fakeClock();
    const leases = store(async () => grant(10), clock);

    expect(leases.spend("k", 1)).toBeNull();
  });

  it("spends a granted lease locally until it runs out", async () => {
    const { clock } = fakeClock();
    const leases = store(async () => grant(3), clock);

    await leases.refill("k");
    expect(leases.spend("k", 1)).toBe(2);
    expect(leases.spend("k", 2)).toBe(0);
    expect(leases.spend("k", 1)).toBeNull();
  });

  it("refuses a cost larger than the tokens left without spending any", async () => {
    const { clock } = fakeClock();
    const leases = store(async () => grant(3), clock);

    await leases.refill("k");
    expect(leases.spend("k", 4)).toBeNull();
    expect(leases.spend("k", 3)).toBe(0);
  });

  it("drops a lease once its duration has passed, counted from when the reply arrived", async () => {
    const { clock, advance } = fakeClock();
    const leases = store(async () => grant(10, 1000), clock);

    advance(500);
    await leases.refill("k");
    advance(999);
    expect(leases.spend("k", 1)).toBe(9);
    advance(1);
    expect(leases.spend("k", 1)).toBeNull();
  });

  it("reports low when there is no lease or it is at the prefetch threshold", async () => {
    const { clock } = fakeClock();
    const leases = store(async () => grant(10), clock);

    expect(leases.isLow("k")).toBe(true);
    await leases.refill("k");
    leases.spend("k", 7); // 3 left
    expect(leases.isLow("k")).toBe(false);
    leases.spend("k", 1); // 2 left
    expect(leases.isLow("k")).toBe(true);
  });

  it("merges leftover tokens into the next lease and uses the new expiry", async () => {
    const { clock, advance } = fakeClock();
    const leases = store(async () => grant(10, 1000), clock);

    await leases.refill("k");
    leases.spend("k", 8); // 2 left
    advance(600);
    await leases.refill("k");
    advance(900); // past the first lease's expiry, inside the second's
    expect(leases.spend("k", 12)).toBe(0);
  });

  it("shares one owner request among concurrent refills of the same key", async () => {
    const { clock } = fakeClock();
    let calls = 0;
    const leases = store(async () => {
      calls++;
      return grant(10);
    }, clock);

    await Promise.all([leases.refill("k"), leases.refill("k"), leases.refill("k")]);
    expect(calls).toBe(1);
    expect(leases.spend("k", 10)).toBe(0);
  });

  it("stores nothing when the owner grants zero tokens", async () => {
    const { clock } = fakeClock();
    const leases = store(async () => grant(0, 1000, 250), clock);

    expect(await leases.refill("k")).toEqual(grant(0, 1000, 250));
    expect(leases.spend("k", 1)).toBeNull();
  });

  it("lets a later refill retry after a failed owner request", async () => {
    const { clock } = fakeClock();
    let fail = true;
    const leases = store(async () => {
      if (fail) throw new Error("owner down");
      return grant(10);
    }, clock);

    await expect(leases.refill("k")).rejects.toThrow("owner down");
    fail = false;
    await leases.refill("k");
    expect(leases.spend("k", 1)).toBe(9);
  });
});
