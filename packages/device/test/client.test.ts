import { describe, expect, it } from "vitest";
import { backoffMs } from "../src/client.js";

describe("backoff", () => {
  it("doubles from 1 s to 60 s with jitter", () => {
    expect(backoffMs(0, () => 1)).toBe(1000);
    expect(backoffMs(3, () => 1)).toBe(8000);
    expect(backoffMs(10, () => 1)).toBe(60_000);
    expect(backoffMs(0, () => 0)).toBe(500);
  });

  it("keeps growing exponentially, caps at 60 s, and stays within the jitter range", () => {
    for (let attempt = 0; attempt <= 20; attempt++) {
      const ceiling = Math.min(60_000, 1000 * 2 ** attempt);
      expect(backoffMs(attempt, () => 1)).toBe(ceiling);
      expect(backoffMs(attempt, () => 0)).toBe(Math.round(ceiling / 2));
      const mid = backoffMs(attempt, () => 0.5);
      expect(mid).toBeGreaterThanOrEqual(Math.round(ceiling / 2));
      expect(mid).toBeLessThanOrEqual(ceiling);
      if (attempt > 0) expect(ceiling).toBeGreaterThanOrEqual(1000);
    }
    // A very long outage never overflows or exceeds the cap.
    expect(backoffMs(1000, () => 1)).toBe(60_000);
    expect(backoffMs(1000, () => 0)).toBe(30_000);
  });
});
