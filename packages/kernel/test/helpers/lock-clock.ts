import { expect, vi } from "vitest";

/**
 * The fake clock for a lock watchdog: timers and `Date` only, so Redis I/O and `setImmediate`
 * still run in real time. Install it before taking the lease, so the watchdog's timers are fake.
 */
export const LOCK_FAKE_CLOCK = {
  toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  now: 0,
} satisfies Parameters<typeof vi.useFakeTimers>[0];

/**
 * Moves a lock watchdog through `periods` renewal periods of `intervalMs` on the fake clock
 * ({@link LOCK_FAKE_CLOCK}), against real Redis: after each tick, waits in real time for the one
 * renewal it sent (an `eval` on `spy`'s client), then lets the watchdog take the answer before the
 * next tick. The watchdog's clock moves only when the test moves it, so a slow event loop or a busy
 * shared Redis cannot push a renewal past the loss deadline (TTL - TTL/3 after the last success,
 * by design: a stalled holder gives the lock up). Returns the answers.
 */
export async function renewalPeriods(
  spy: { mock: { calls: unknown[]; results: { value: unknown }[] } },
  intervalMs: number,
  periods: number,
): Promise<unknown[]> {
  const answers: unknown[] = [];
  for (let i = 0; i < periods; i++) {
    const before = spy.mock.calls.length;
    await vi.advanceTimersByTimeAsync(intervalMs);
    expect(spy.mock.calls.length).toBe(before + 1);
    answers.push(await spy.mock.results[before]?.value);
    // setImmediate is not faked: it runs after the watchdog's continuation took the answer
    await new Promise((r) => setImmediate(r));
  }
  return answers;
}
