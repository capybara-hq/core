import { expect, it, vi } from "vitest";
import { oneAtATime } from "../src/staged-connect.js";

it("skips a call while the previous run is pending, and runs again once it settled", async () => {
  let release!: () => void;
  const task = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const tick = oneAtATime(task);
  tick();
  tick();
  tick();
  expect(task).toHaveBeenCalledTimes(1);
  release();
  await vi.waitFor(() => {
    tick();
    expect(task).toHaveBeenCalledTimes(2);
  });
});

it("a failed run does not block the next one", async () => {
  const task = vi.fn(() => Promise.reject(new Error("boom")));
  const tick = oneAtATime(task);
  tick();
  await vi.waitFor(() => {
    tick();
    expect(task).toHaveBeenCalledTimes(2);
  });
});
