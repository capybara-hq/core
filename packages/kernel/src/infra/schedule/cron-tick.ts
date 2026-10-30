import { CronTime } from "cron";

/** Timers may fire a little early; a call this close before a tick still belongs to it. */
const EARLY_TOLERANCE_MS = 50;

export interface CronTick {
  /** The scheduled fire time (epoch ms) of the tick a call at `now` belongs to. */
  tick: number;
  /** The gap between that tick and the next scheduled one, ms. */
  periodMs: number;
}

/**
 * The scheduled tick a cron callback invoked at `now` belongs to: the latest scheduled time at or
 * before `now` (plus a small early-fire tolerance). It comes from the expression, not from the
 * clock, so replicas whose callbacks run a few ms apart agree on it.
 */
export function scheduledTick(expression: string, now: number, timeZone?: string): CronTick {
  const time = new CronTime(expression, timeZone);
  const ref = now + EARLY_TOLERANCE_MS;
  let window = 1000;
  for (;;) {
    let t = time.getNextDateFrom(new Date(ref - window), timeZone).toMillis();
    if (t <= ref) {
      for (;;) {
        const next = time.getNextDateFrom(new Date(t), timeZone).toMillis();
        if (next > ref) return { tick: t, periodMs: next - t };
        t = next;
      }
    }
    window *= 2;
  }
}
