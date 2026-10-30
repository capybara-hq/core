import { EventEmitter } from "node:events";
import { NestFactory } from "@nestjs/core";
import type { Redis } from "ioredis";
import type { Kysely } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveConfig } from "../../src/config/load.js";
import { ConfigModule } from "../../src/infra/config/config.module.js";
import { DatabaseModule, PoolLifecycle } from "../../src/infra/database/database.module.js";
import { GracefulShutdownModule } from "../../src/infra/lifecycle/graceful-shutdown.module.js";
import {
  GracefulShutdown,
  STOP_TIMEOUT_MS,
} from "../../src/infra/lifecycle/graceful-shutdown.service.js";
import { handleShutdownSignals } from "../../src/infra/lifecycle/shutdown-signals.js";
import { LoggingModule } from "../../src/infra/logging/logging.module.js";
import { RedisLifecycle, RedisModule } from "../../src/infra/redis/redis.module.js";
import { KERNEL_POOL, REDIS_SUBSCRIBER } from "../../src/infra/tokens.js";
import { createLogger, type KernelLogger } from "../../src/log.js";

function recordingLogger(): { log: KernelLogger; lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  return { log: createLogger("info", { write: (l) => lines.push(JSON.parse(l)) }), lines };
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const never = () => new Promise<never>(() => {});

afterEach(() => {
  vi.useRealTimers();
});

describe("GracefulShutdown", () => {
  it("begin flips the state once, aborts the signal and starts the 30 s deadline", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const s = new GracefulShutdown(recordingLogger().log);
    expect(s.isShuttingDown()).toBe(false);
    expect(s.signal.aborted).toBe(false);
    expect(s.remainingMs()).toBe(STOP_TIMEOUT_MS);
    s.begin();
    expect(s.isShuttingDown()).toBe(true);
    expect(s.signal.aborted).toBe(true);
    vi.setSystemTime(Date.now() + 12_000);
    expect(s.remainingMs()).toBe(STOP_TIMEOUT_MS - 12_000);
    // idempotent: the deadline does not move
    s.begin();
    expect(s.remainingMs()).toBe(STOP_TIMEOUT_MS - 12_000);
    vi.setSystemTime(Date.now() + 60_000);
    expect(s.remainingMs()).toBe(0);
  });

  it("drain waits for tracked work, including work tracked while draining", async () => {
    const s = new GracefulShutdown(recordingLogger().log);
    const first = deferred();
    const second = deferred();
    s.trackInFlight(first.promise);
    let drained = false;
    const draining = s.drain(5_000).then((ok) => {
      drained = ok;
    });
    // Tracked work starts more work before it settles
    s.trackInFlight(second.promise);
    first.resolve();
    await new Promise((r) => setTimeout(r, 20));
    expect(drained).toBe(false);
    second.resolve();
    await draining;
    expect(drained).toBe(true);
    expect(s.inFlightCount).toBe(0);
  });

  it("a rejected tracked promise counts as settled; trackInFlight returns the promise itself", async () => {
    const s = new GracefulShutdown(recordingLogger().log);
    const p = Promise.reject(new Error("boom"));
    expect(s.trackInFlight(p)).toBe(p);
    await expect(p).rejects.toThrow("boom");
    expect(await s.drain(1_000)).toBe(true);
  });

  it("drain gives up at its budget, logs and abandons what is left (a later drain does not wait)", async () => {
    const { log, lines } = recordingLogger();
    const s = new GracefulShutdown(log);
    s.trackInFlight(never());
    const t0 = Date.now();
    expect(await s.drain(100)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(
      lines.some((l) => l.msg === "shutdown: in-flight work did not finish in time; abandoned"),
    ).toBe(true);
    const t1 = Date.now();
    await s.beforeApplicationShutdown();
    expect(Date.now() - t1).toBeLessThan(100);
  });

  it("once the shutdown began, drain never waits past the total deadline", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const s = new GracefulShutdown(recordingLogger().log);
    s.begin();
    vi.setSystemTime(Date.now() + STOP_TIMEOUT_MS - 50);
    s.trackInFlight(never());
    let result: boolean | undefined;
    const draining = s.drain(10_000).then((ok) => {
      result = ok;
    });
    await vi.advanceTimersByTimeAsync(49);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await draining;
    expect(result).toBe(false);
  });

  it("beforeApplicationShutdown begins the shutdown", async () => {
    const s = new GracefulShutdown(recordingLogger().log);
    await s.beforeApplicationShutdown();
    expect(s.isShuttingDown()).toBe(true);
  });
});

describe("infra closes share the rest of the stop budget", () => {
  /** A shutdown that began 29.9 s ago: 100 ms of the 30 s are left. */
  function lateShutdown(): GracefulShutdown {
    vi.useFakeTimers({ toFake: ["Date"] });
    const s = new GracefulShutdown(recordingLogger().log);
    s.begin();
    vi.setSystemTime(Date.now() + STOP_TIMEOUT_MS - 100);
    return s;
  }

  it("a hanging bus close, QUIT and pool close end together at the 30 s deadline", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const shutdown = new GracefulShutdown(recordingLogger().log);
    shutdown.begin();
    // The stop phases used 29.9 s: 100 ms are left for every infra close together
    vi.setSystemTime(Date.now() + STOP_TIMEOUT_MS - 100);
    const { log } = recordingLogger();
    const disconnect = vi.fn();
    // each registers its close with the shutdown
    new RedisLifecycle(
      { status: "ready", quit: vi.fn(never), disconnect } as unknown as Redis,
      { close: never } as unknown as ConstructorParameters<typeof RedisLifecycle>[1],
      log,
      shutdown,
    );
    // biome-ignore lint/suspicious/noExplicitAny: a fake pool
    new PoolLifecycle({ destroy: never } as unknown as Kysely<any>, log, shutdown);
    let done = false;
    const closing = (async () => {
      // the shutdown's last hook runs every registered close together
      await shutdown.onApplicationShutdown();
      done = true;
    })();
    await vi.advanceTimersByTimeAsync(99);
    expect(done).toBe(false);
    // At the deadline the bus and pool closes are abandoned, and QUIT gets the 0 ms left
    await vi.advanceTimersByTimeAsync(1);
    // The closes after it time out at once (0 ms left; a timer fires 1 ms later at the earliest)
    for (let i = 0; i < 10 && !done; i++) await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
    await closing;
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("with the deadline passed, each close gets 0 ms and the connection is dropped", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const shutdown = new GracefulShutdown(recordingLogger().log);
    shutdown.begin();
    vi.setSystemTime(Date.now() + STOP_TIMEOUT_MS + 1);
    const quit = vi.fn(never);
    const disconnect = vi.fn();
    const life = new RedisLifecycle(
      { status: "ready", quit, disconnect } as unknown as Redis,
      { close: never } as unknown as ConstructorParameters<typeof RedisLifecycle>[1],
      recordingLogger().log,
      shutdown,
    );
    const t0 = performance.now();
    await life.close();
    expect(performance.now() - t0).toBeLessThan(200);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("a connection that is not ready is dropped without QUIT", async () => {
    const shutdown = new GracefulShutdown(recordingLogger().log);
    const quit = vi.fn(async () => "OK");
    const disconnect = vi.fn();
    const life = new RedisLifecycle(
      { status: "reconnecting", quit, disconnect } as unknown as Redis,
      { close: async () => {} } as unknown as ConstructorParameters<typeof RedisLifecycle>[1],
      recordingLogger().log,
      shutdown,
    );
    await life.close();
    expect(quit).not.toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});

describe("infra closes run together", () => {
  it("a hanging bus close does not delay the pool close: both start when the infra closes begin", async () => {
    const config = resolveConfig(
      {
        db: { url: "postgres://u:p@127.0.0.1:1/db" },
        redis: { url: "redis://127.0.0.1:1" },
        masterKey: Buffer.alloc(32, 1).toString("base64"),
      },
      {},
    );
    class Root {}
    const app = await NestFactory.createApplicationContext(
      {
        module: Root,
        imports: [
          LoggingModule.forRoot(config, { logger: createLogger("error", { write: () => {} }) }),
          ConfigModule.forRoot(config),
          GracefulShutdownModule,
          // the kernel's order (KernelModule): the pool's module before Redis'
          DatabaseModule.forRoot(),
          RedisModule,
        ],
      },
      { logger: false, abortOnError: false },
    );
    // Redis is unreachable: the bus close hangs until the deadline
    (app.get(REDIS_SUBSCRIBER) as { close: () => Promise<void> }).close = never;
    const pool = app.get(KERNEL_POOL) as { destroy: () => Promise<void> };
    const destroy = pool.destroy.bind(pool);
    let poolCloseAt: number | undefined;
    pool.destroy = () => {
      poolCloseAt = performance.now();
      return destroy();
    };
    // 300 ms of the stop budget are left (the clock stands still, so every close may take them)
    vi.useFakeTimers({ toFake: ["Date"] });
    const shutdown = app.get(GracefulShutdown);
    shutdown.begin();
    vi.setSystemTime(Date.now() + STOP_TIMEOUT_MS - 300);
    const t0 = performance.now();
    await app.close();
    expect(poolCloseAt).toBeDefined();
    expect((poolCloseAt as number) - t0).toBeLessThan(150);
  });
});

describe("handleShutdownSignals", () => {
  function setup(close: () => Promise<void>) {
    const signals = new EventEmitter();
    const exits: number[] = [];
    const { log, lines } = recordingLogger();
    const flush = vi.spyOn(log, "flush");
    const handle = handleShutdownSignals(close, log, { signals, exit: (c) => exits.push(c) });
    return { signals, exits, lines, flush, handle };
  }

  it("the first signal closes, flushes the logs and exits 0, then removes its listeners", async () => {
    const close = vi.fn(async () => {});
    const { signals, exits, flush, handle } = setup(close);
    expect(handle.exiting()).toBeUndefined();
    signals.emit("SIGINT", "SIGINT");
    expect(close).toHaveBeenCalledTimes(1);
    await handle.exiting();
    expect(flush).toHaveBeenCalled();
    expect(exits).toEqual([0]);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
    expect(signals.listenerCount("SIGINT")).toBe(0);
  });

  it("a failed close is logged and exits 1", async () => {
    const { signals, exits, lines, handle } = setup(async () => {
      throw new Error("stuck");
    });
    signals.emit("SIGTERM", "SIGTERM");
    await handle.exiting();
    expect(exits).toEqual([1]);
    expect(lines.some((l) => l.msg === "shutdown failed")).toBe(true);
  });

  it("a second signal while the close runs exits 1 at once and does not close twice", async () => {
    const gate = deferred();
    const close = vi.fn(() => gate.promise);
    const { signals, exits, lines, handle } = setup(close);
    signals.emit("SIGTERM", "SIGTERM");
    signals.emit("SIGTERM", "SIGTERM");
    expect(exits).toEqual([1]);
    expect(close).toHaveBeenCalledTimes(1);
    expect(lines.some((l) => l.msg === "second signal received; exiting immediately")).toBe(true);
    gate.resolve();
    await handle.exiting();
    // The first path's end() does not exit again: the forced exit stays 1
    expect(exits).toEqual([1]);
  });

  it("dispose removes the listeners", () => {
    const { signals, handle } = setup(async () => {});
    expect(signals.listenerCount("SIGTERM")).toBe(1);
    handle.dispose();
    expect(signals.listenerCount("SIGTERM")).toBe(0);
    expect(signals.listenerCount("SIGINT")).toBe(0);
  });
});
