import { EventEmitter } from "node:events";
import {
  createDualReplicaHarness,
  type Harness,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { NestFactory } from "@nestjs/core";
import { Redis } from "ioredis";
import type { Kysely } from "kysely";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ChannelSupervisor } from "../../src/channels/supervisor.js";
import { resolveConfig } from "../../src/config/load.js";
import type { KernelConfig } from "../../src/config/schema.js";
import { ConfigModule } from "../../src/infra/config/config.module.js";
import { DatabaseModule, PoolLifecycle } from "../../src/infra/database/database.module.js";
import { GracefulShutdownModule } from "../../src/infra/lifecycle/graceful-shutdown.module.js";
import {
  GracefulShutdown,
  STOP_TIMEOUT_MS,
} from "../../src/infra/lifecycle/graceful-shutdown.service.js";
import { handleShutdownSignals } from "../../src/infra/lifecycle/shutdown-signals.js";
import { LoggingModule } from "../../src/infra/logging/logging.module.js";
import {
  PRESENCE_DEFAULT_INTERVAL_MS,
  PRESENCE_INTERVAL_MS,
  REPLICAS_KEY,
  ReplicaPresence,
  readLiveReplicas,
  replicaKey,
} from "../../src/infra/presence/replica-presence.js";
import { RedisLifecycle, RedisModule } from "../../src/infra/redis/redis.module.js";
import { KERNEL_POOL, REDIS_SUBSCRIBER } from "../../src/infra/tokens.js";
import { LocalDeviceGateway } from "../../src/local-devices/local-device-gateway.js";
import { createLogger, type KernelLogger } from "../../src/log.js";
import type { KernelOverride } from "../../src/overrides.js";
import { KERNEL_VERSION } from "../../src/version.js";
import { runConfig, sleep, startKernel, type TestKernel, waitFor } from "../helpers/runs.js";

/**
 * Process lifecycle: the shutdown state (its drains, the shared stop budget, the infra closes it
 * runs and the signal handler), and replica presence (a process's beat in Redis, its TTL, the
 * removal on a graceful stop and the ageing out of a process that stopped beating).
 */

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
    // Nothing-happened window: the drain must not finish while the second promise is pending
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

const WINDOW = PRESENCE_DEFAULT_INTERVAL_MS * 3;

describe("replica presence (dual replica, separate processes)", () => {
  let pgc: TestContainer;
  let rdc: TestContainer;
  let h: Harness;
  let redis: Redis;

  beforeAll(async () => {
    [pgc, rdc] = await Promise.all([startTestPostgres(), startTestRedis()]);
    redis = new Redis(rdc.url);
    h = await createDualReplicaHarness({
      extensions: [],
      pgUrl: pgc.url,
      redisUrl: rdc.url,
      roles: [["api"], ["worker", "gateway"]],
    });
  });

  afterAll(async () => {
    await h?.stop();
    redis?.disconnect();
    await Promise.all([pgc?.stop(), rdc?.stop()]);
  });

  it("lists both processes with their roles, version and start, keys with a TTL; a graceful stop removes its entry at once", async () => {
    // the first beat runs at the end of each start, so both are there once both are ready
    const live = await waitFor(async () => {
      const l = await readLiveReplicas(redis, WINDOW);
      return l.length === 2 ? l : undefined;
    });
    const byHttp = new Map(live.map((r) => [r.httpReplicaId, r]));
    expect(byHttp.get("0")).toMatchObject({ roles: ["api"], version: KERNEL_VERSION });
    expect(byHttp.get("1")).toMatchObject({
      roles: ["worker", "gateway"],
      version: KERNEL_VERSION,
      channelsHeld: 0,
      devicesConnected: 0,
    });
    for (const r of live) {
      expect(Number.isNaN(Date.parse(r.startedAt))).toBe(false);
      // the process id, not the configured http.replicaId
      expect(r.id).not.toBe(r.httpReplicaId);
      const ttl = await redis.pttl(replicaKey(r.id));
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(WINDOW);
    }
    const zttl = await redis.pttl(REPLICAS_KEY);
    expect(zttl).toBeGreaterThan(0);
    expect(zttl).toBeLessThanOrEqual(WINDOW);

    const a = byHttp.get("0")?.id as string;
    const b = byHttp.get("1")?.id as string;
    // a crash leaves the entry behind (no cleanup), bounded by its TTL
    await h.kill(1);
    expect(await redis.zscore(REPLICAS_KEY, b)).not.toBeNull();
    expect(await redis.pttl(replicaKey(b))).toBeGreaterThan(0);
    // the graceful stop of replica 0 removes its entry right away, long before the TTL
    await h.stop();
    expect(await redis.zscore(REPLICAS_KEY, a)).toBeNull();
    expect(await redis.exists(replicaKey(a))).toBe(0);
    expect((await readLiveReplicas(redis, WINDOW)).map((r) => r.id)).toEqual([b]);
  });
});

describe("replica presence (short interval)", () => {
  const INTERVAL = 200;
  let pgc: TestContainer;
  let rdc: TestContainer;
  let redis: Redis;
  let a: TestKernel;
  let b: TestKernel;

  beforeAll(async () => {
    [pgc, rdc] = await Promise.all([startTestPostgres(), startTestRedis()]);
    redis = new Redis(rdc.url);
    const urls = { pg: pgc.url, redis: rdc.url };
    const overrides: KernelOverride[] = [{ provide: PRESENCE_INTERVAL_MS, useValue: INTERVAL }];
    a = await startKernel(runConfig(urls, { roles: ["api", "gateway"], extensions: [] }), {
      overrides,
    });
    b = await startKernel(runConfig(urls, { roles: ["worker", "gateway"], extensions: [] }), {
      overrides,
    });
  });

  afterAll(async () => {
    await Promise.all([a?.close(), b?.close()]);
    redis?.disconnect();
    await Promise.all([pgc?.stop(), rdc?.stop()]);
  });

  it("reports the connections each process holds, and a process that stops beating ages out", async () => {
    vi.spyOn(a.app.get(ChannelSupervisor), "heldCount").mockReturnValue(1);
    vi.spyOn(a.app.get(LocalDeviceGateway), "connectionCount").mockReturnValue(2);
    vi.spyOn(b.app.get(ChannelSupervisor), "heldCount").mockReturnValue(2);
    vi.spyOn(b.app.get(LocalDeviceGateway), "connectionCount").mockReturnValue(3);
    const pa = a.app.get(ReplicaPresence);
    const pb = b.app.get(ReplicaPresence);
    expect(pa.windowMs).toBe(INTERVAL * 3);

    const live = await waitFor(async () => {
      const l = await pa.live();
      const sum = (k: "channelsHeld" | "devicesConnected") => l.reduce((n, r) => n + r[k], 0);
      return l.length === 2 && sum("channelsHeld") === 3 && sum("devicesConnected") === 5
        ? l
        : undefined;
    });
    const idB = live.find((r) => r.roles.includes("worker"))?.id as string;
    const idA = live.find((r) => r.roles.includes("api"))?.id as string;
    expect(live.find((r) => r.id === idA)?.roles).toEqual(["api", "gateway"]);

    // b stops beating without cleaning up (a crash): gone from the read after the window, its
    // facts expire, and a's next beat trims it from the ZSET
    await pb.halt();
    await waitFor(async () => ((await pa.live()).some((r) => r.id === idB) ? undefined : true));
    await waitFor(async () =>
      (await redis.exists(replicaKey(idB))) === 0 &&
      (await redis.zscore(REPLICAS_KEY, idB)) === null
        ? true
        : undefined,
    );
    expect((await pa.live()).map((r) => r.id)).toEqual([idA]);

    // a graceful close removes a's entry at once
    await a.close();
    expect(await redis.zscore(REPLICAS_KEY, idA)).toBeNull();
    expect(await redis.exists(replicaKey(idA))).toBe(0);
  });
});

describe("replica presence (one process, Redis delays and failures)", () => {
  let rdc: TestContainer;
  const clients: Redis[] = [];

  beforeAll(async () => {
    rdc = await startTestRedis();
  });

  afterAll(async () => {
    for (const c of clients) c.disconnect();
    await rdc?.stop();
  });

  const config = {
    get: () => ({ roles: ["api"], http: {} }) as unknown as KernelConfig,
  };
  const sources = (replicaId: string) => ({
    replicaId,
    channelsHeld: () => 0,
    devicesConnected: () => 0,
  });
  /** A Redis client of its own (its `eval` gets spied on) and one to look with. */
  const clientsFor = () => {
    const r = new Redis(rdc.url);
    const look = new Redis(rdc.url);
    clients.push(r, look);
    return { r, look, evalOf: r.eval.bind(r) as (...a: unknown[]) => Promise<unknown> };
  };

  it("a stop while a beat is in flight waits for it, then removes the entry", async () => {
    const { r, look, evalOf } = clientsFor();
    let entered: () => void = () => {};
    const inFlight = new Promise<void>((res) => {
      entered = res;
    });
    vi.spyOn(r, "eval").mockImplementation((async (...args: unknown[]) => {
      entered();
      // a simulated slow beat: the stop must wait for the eval still in flight
      await sleep(300);
      return evalOf(...args);
    }) as never);
    const p = new ReplicaPresence(r, config, { warn: vi.fn() }, 100);
    p.start(sources("in-flight"));
    await inFlight;
    await p.stop();
    // the beat finished before the cleanup: nothing of it is left behind
    expect(await look.zscore(REPLICAS_KEY, "in-flight")).toBeNull();
    expect(await look.exists(replicaKey("in-flight"))).toBe(0);
    // Nothing-happened window: the stopped beat must not come back
    await sleep(250);
    expect(await look.exists(replicaKey("in-flight"))).toBe(0);
  });

  it("a failing beat is logged at warn, and the next beat still runs", async () => {
    const { r, look, evalOf } = clientsFor();
    const spy = vi.spyOn(r, "eval");
    spy.mockRejectedValueOnce(new Error("redis says no"));
    spy.mockImplementation(((...args: unknown[]) => evalOf(...args)) as never);
    const warn = vi.fn();
    const p = new ReplicaPresence(r, config, { warn }, 100);
    p.start(sources("flaky"));
    await waitFor(async () => (await look.zscore(REPLICAS_KEY, "flaky")) !== null);
    expect(warn).toHaveBeenCalledWith("replica presence beat failed", {
      err: expect.any(Error),
    });
    await p.stop();
    expect(await look.zscore(REPLICAS_KEY, "flaky")).toBeNull();
  });
});
