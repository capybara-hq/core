import { describe, expect, it } from "vitest";
import { WakeDetector } from "../src/wake.js";

function clocks() {
  let wall = Date.UTC(2026, 10, 19, 10, 0, 0);
  let mono = 1000;
  return {
    tick: (ms: number) => {
      wall += ms;
      mono += ms;
    },
    sleep: (ms: number) => {
      wall += ms; // the monotonic clock stops while the computer sleeps
    },
    now: () => wall,
    monotonic: () => mono,
  };
}

describe("WakeDetector", () => {
  it("a wall-clock jump over 30 s is a wake", () => {
    const c = clocks();
    const d = new WakeDetector({ now: c.now, monotonic: c.monotonic });
    c.tick(2000);
    expect(d.check()).toBeUndefined();
    c.sleep(45_000);
    c.tick(1000);
    expect(d.check()).toBe(new Date(c.now()).toISOString());
    // reported once
    c.tick(2000);
    expect(d.check()).toBeUndefined();
  });

  it("a small drift is not", () => {
    const c = clocks();
    const d = new WakeDetector({ now: c.now, monotonic: c.monotonic });
    c.sleep(29_000);
    expect(d.check()).toBeUndefined();
    c.sleep(30_000);
    expect(d.check()).toBeUndefined();
    c.sleep(30_001);
    expect(d.check()).toBeDefined();
  });
});
