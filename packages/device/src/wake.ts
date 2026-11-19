/** Wall-clock time that passed beyond the monotonic clock's before a check counts as a wake. */
export const WAKE_THRESHOLD_MS = 30_000;

export interface WakeDetectorOptions {
  /** Wall clock, ms since the epoch (default `Date.now`). */
  now?: () => number;
  /** A clock that stops while the computer sleeps (default `performance.now`). */
  monotonic?: () => number;
  thresholdMs?: number;
}

/**
 * Notices the computer woke from sleep: the monotonic clock does not advance while it sleeps, the
 * wall clock does, so a wall-clock advance well beyond the monotonic one between two checks is a
 * wake. Call {@link check} regularly; it answers the wake time (ISO 8601) once per wake.
 */
export class WakeDetector {
  private readonly now: () => number;
  private readonly monotonic: () => number;
  private readonly thresholdMs: number;
  private lastWall: number;
  private lastMono: number;

  constructor(o: WakeDetectorOptions = {}) {
    this.now = o.now ?? Date.now;
    this.monotonic = o.monotonic ?? (() => performance.now());
    this.thresholdMs = o.thresholdMs ?? WAKE_THRESHOLD_MS;
    this.lastWall = this.now();
    this.lastMono = this.monotonic();
  }

  check(): string | undefined {
    const wall = this.now();
    const mono = this.monotonic();
    const slept = wall - this.lastWall - (mono - this.lastMono);
    this.lastWall = wall;
    this.lastMono = mono;
    return slept > this.thresholdMs ? new Date(wall).toISOString() : undefined;
  }
}
