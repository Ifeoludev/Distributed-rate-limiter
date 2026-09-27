import { describe, expect, it } from "vitest";
import { countPerWindow, percentile } from "../bench/plot.js";

describe("percentile", () => {
  it("returns an observed value by nearest rank", () => {
    const values = [5, 1, 4, 2, 3, 10, 9, 8, 7, 6];
    expect(percentile(values, 50)).toBe(5);
    expect(percentile(values, 99)).toBe(10);
    expect(percentile(values, 10)).toBe(1);
  });

  it("returns NaN when there are no values", () => {
    expect(percentile([], 50)).toBeNaN();
  });
});

describe("countPerWindow", () => {
  it("puts each time in the window that contains it", () => {
    expect(countPerWindow([0, 999.9, 1000, 2500, 2999], 1000, 3000)).toEqual([
      2, 1, 2,
    ]);
  });

  it("ignores times outside the run", () => {
    expect(countPerWindow([-1, 3000], 1000, 3000)).toEqual([0, 0, 0]);
  });
});
