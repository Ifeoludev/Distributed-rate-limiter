import { describe, expect, it } from "vitest";
import { PeerHealth } from "../src/node/peers.js";

describe("PeerHealth", () => {
  it("removes a peer only after the configured number of misses in a row", () => {
    const health = new PeerHealth(3);
    expect(health.record("b", false)).toBeNull();
    expect(health.record("b", false)).toBeNull();
    expect(health.record("b", false)).toBe("removed");
  });

  it("resets the miss count after a successful check", () => {
    const health = new PeerHealth(3);
    health.record("b", false);
    health.record("b", false);
    expect(health.record("b", true)).toBeNull();
    expect(health.record("b", false)).toBeNull();
    expect(health.record("b", false)).toBeNull();
    expect(health.record("b", false)).toBe("removed");
  });

  it("reports removal once while the peer stays dead", () => {
    const health = new PeerHealth(2);
    health.record("b", false);
    expect(health.record("b", false)).toBe("removed");
    expect(health.record("b", false)).toBeNull();
    expect(health.record("b", false)).toBeNull();
  });

  it("rejoins a removed peer on its first successful check", () => {
    const health = new PeerHealth(2);
    health.record("b", false);
    health.record("b", false);
    expect(health.record("b", true)).toBe("rejoined");
    expect(health.record("b", true)).toBeNull();
  });

  it("tracks each peer separately", () => {
    const health = new PeerHealth(2);
    health.record("b", false);
    expect(health.record("c", false)).toBeNull();
    expect(health.record("b", false)).toBe("removed");
  });
});
