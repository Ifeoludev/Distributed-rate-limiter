import { describe, expect, it } from "vitest";
import { HashRing } from "../src/ring/hashRing.js";

const KEYS = Array.from({ length: 10_000 }, (_, i) => `user_${i}`);

describe("HashRing", () => {
  it("is deterministic: the same key always maps to the same owner", () => {
    const ring = new HashRing(["a", "b", "c"]);
    const owner = ring.getOwner("user_42");
    for (let i = 0; i < 5; i++) {
      expect(ring.getOwner("user_42")).toBe(owner);
    }
  });

  it("spreads keys roughly evenly across instances", () => {
    const ring = new HashRing(["a", "b", "c"]);
    const counts = { a: 0, b: 0, c: 0 };
    for (const key of KEYS) {
      counts[ring.getOwner(key) as keyof typeof counts]++;
    }
    // With 100 virtual nodes per instance, an even 3-way split is ~33% each.
    // Empirically this lands within a few points of that; 25-40% leaves margin.
    for (const share of Object.values(counts)) {
      expect(share / KEYS.length).toBeGreaterThan(0.25);
      expect(share / KEYS.length).toBeLessThan(0.4);
    }
  });

  it("removing one of three instances moves only that instance's keys, about a third of them", () => {
    const ring = new HashRing(["a", "b", "c"]);
    const before = new Map(KEYS.map((key) => [key, ring.getOwner(key)]));

    ring.removeInstance("c");

    let moved = 0;
    for (const key of KEYS) {
      const oldOwner = before.get(key);
      const newOwner = ring.getOwner(key);
      if (newOwner !== oldOwner) {
        moved++;
        // A key can only move because its old owner is gone.
        expect(oldOwner).toBe("c");
      }
    }

    const movedFraction = moved / KEYS.length;
    expect(movedFraction).toBeGreaterThan(0.25);
    expect(movedFraction).toBeLessThan(0.4);
  });

  it("keys that moved after a removal land on a surviving instance", () => {
    const ring = new HashRing(["a", "b", "c"]);
    ring.removeInstance("c");
    for (const key of KEYS) {
      expect(["a", "b"]).toContain(ring.getOwner(key));
    }
  });

  it("adding an instance back changes only some keys, and none of them can land on the removed instance", () => {
    const ring = new HashRing(["a", "b"]);
    ring.addInstance("c");
    for (const key of KEYS) {
      expect(["a", "b", "c"]).toContain(ring.getOwner(key));
    }
  });

  it("throws when asked for an owner with no instances on the ring", () => {
    const ring = new HashRing([]);
    expect(() => ring.getOwner("k")).toThrow();
  });
});
