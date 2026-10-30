// Ported from octok-platform libs/service-rpc/src/shutdown/graceful-shutdown.service.ts (owner-approved, 2026-10-28).
import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  type OnApplicationShutdown,
} from "@nestjs/common";
import type { KernelLogger } from "../../log.js";
import { waitWithin } from "../close-within.js";
import type { ShutdownState } from "../health/shutdown-state.js";
import { KERNEL_LOGGER } from "../tokens.js";

/**
 * The total stop budget: from the moment the shutdown begins, the stop phases and the infra closes
 * (bus, Redis, pool) share these 30 s; whatever is still open after it is abandoned.
 */
export const STOP_TIMEOUT_MS = 30_000;

/**
 * The process's shutdown state, the one source of "are we stopping" (nest kernel spec §4).
 *
 * {@link begin} (idempotent, synchronous) flips readiness to 503 ({@link isShuttingDown}, read by
 * `/readyz`), aborts {@link signal} (the start sequence stops at its next checkpoint, an extension
 * migration of the start is aborted, the SSE stream registries close and refuse new streams) and
 * starts the {@link STOP_TIMEOUT_MS} deadline that every later stop step takes its share of
 * ({@link remainingMs}).
 *
 * {@link trackInFlight} registers work the stop must let finish before it closes what that work
 * uses; {@link drain} waits for the set to empty, re-reading it each round (work registered by
 * tracked work while draining is waited for too), up to a budget, and reports a timeout instead of
 * hanging. The kernel's stop phases (`KernelLifecycle`) call `begin()` first and drain at their
 * start-work step; components with their own close (the run workers, the extension host, Fastify)
 * keep draining themselves within their phase budgets.
 *
 * `beforeApplicationShutdown` runs `begin()` and a final drain bounded by the remaining budget, so
 * a Nest application without `KernelLifecycle` (or whose stop phases already drained) behaves the
 * same: the readiness flip happens while the port is still open, before `dispose()` closes it.
 *
 * {@link closeLast} registers the close of an infra connection (the bus and Redis, the pool);
 * `onApplicationShutdown` runs them all at once. This is a global module's hook, so it runs after
 * every other module's stop hooks: nothing uses those connections once they start closing, and a
 * close that hangs (Redis down) does not hold back the others, which share what is left of the
 * same budget.
 */
@Injectable()
export class GracefulShutdown
  implements BeforeApplicationShutdown, OnApplicationShutdown, ShutdownState
{
  private shuttingDown = false;
  private deadline: number | undefined;
  private readonly abort = new AbortController();
  private readonly inFlight = new Set<Promise<unknown>>();
  private readonly lastCloses: (() => Promise<void>)[] = [];

  constructor(@Inject(KERNEL_LOGGER) private readonly log: KernelLogger) {}

  /** True from the moment the shutdown began; readiness answers 503 from then on. */
  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  /** Aborted when the shutdown begins. */
  get signal(): AbortSignal {
    return this.abort.signal;
  }

  /** Begins the shutdown (idempotent): readiness 503, {@link signal} aborted, the deadline set. */
  begin(): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.deadline = Date.now() + STOP_TIMEOUT_MS;
    this.abort.abort();
  }

  /** What is left of the total stop budget (the whole budget before the shutdown began). */
  remainingMs(): number {
    return this.deadline === undefined ? STOP_TIMEOUT_MS : Math.max(0, this.deadline - Date.now());
  }

  /** Registers work the stop waits for (see {@link drain}); returns `p`. */
  trackInFlight<T>(p: Promise<T>): Promise<T> {
    this.inFlight.add(p);
    const forget = () => {
      this.inFlight.delete(p);
    };
    p.then(forget, forget);
    return p;
  }

  /** The number of tracked promises not settled yet. */
  get inFlightCount(): number {
    return this.inFlight.size;
  }

  /**
   * Waits until no tracked work is left, at most `budgetMs` (capped by {@link remainingMs} once the
   * shutdown began). Resolves true when everything settled, false on timeout: what is left is
   * logged and abandoned (no later drain waits for it again). Rejections of tracked work are not
   * this wait's business: they only count as settled.
   */
  async drain(budgetMs: number): Promise<boolean> {
    if (this.inFlight.size === 0) return true;
    const waitMs = Math.max(0, Math.min(budgetMs, this.remainingMs()));
    const end = Date.now() + waitMs;
    while (this.inFlight.size > 0) {
      const left = Math.max(0, end - Date.now());
      if (!(await waitWithin(Promise.allSettled([...this.inFlight]), left))) break;
    }
    if (this.inFlight.size > 0) {
      this.log.warn("shutdown: in-flight work did not finish in time; abandoned", {
        inFlight: this.inFlight.size,
        budgetMs: waitMs,
      });
      // Abandoned: a later drain (the final one of beforeApplicationShutdown) does not wait again
      this.inFlight.clear();
      return false;
    }
    return true;
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.begin();
    await this.drain(this.remainingMs());
  }

  /**
   * Registers the close of an infra connection, run at the very end of the shutdown together with
   * the others (see the class comment). `close` bounds itself by {@link remainingMs} and never
   * throws.
   */
  closeLast(close: () => Promise<void>): void {
    this.lastCloses.push(close);
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.all(this.lastCloses.splice(0).map((close) => close()));
  }
}
