import {
  createDualReplicaHarness,
  type Harness,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ChannelSupervisor } from "../../src/channels/supervisor.js";
import type { KernelConfig } from "../../src/config/schema.js";
import {
  PRESENCE_DEFAULT_INTERVAL_MS,
  PRESENCE_INTERVAL_MS,
  REPLICAS_KEY,
  ReplicaPresence,
  readLiveReplicas,
  replicaKey,
} from "../../src/infra/presence/replica-presence.js";
import { LocalDeviceGateway } from "../../src/local-devices/local-device-gateway.js";
import type { KernelOverride } from "../../src/overrides.js";
import { KERNEL_VERSION } from "../../src/version.js";
import { runConfig, sleep, startKernel, type TestKernel, waitFor } from "../helpers/runs.js";

/**
 * Replica presence (admin overview spec §5.1, §11 presence.test): every process reports itself in
 * Redis with its roles and version, both keys carry a TTL, a graceful stop removes the entry at
 * once and a process that stops beating ages out after the window.
 */

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
  }, 180_000);

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
  }, 120_000);
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
  }, 180_000);

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
  }, 60_000);
});

describe("replica presence (one process, Redis delays and failures)", () => {
  let rdc: TestContainer;
  const clients: Redis[] = [];

  beforeAll(async () => {
    rdc = await startTestRedis();
  }, 60_000);

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
