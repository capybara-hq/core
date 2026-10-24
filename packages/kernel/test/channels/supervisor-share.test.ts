import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@capybara-hq/plugin-sdk";
import {
  type FakeChannelServer,
  startFakeChannelServer,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { ChannelConnections } from "../../src/channels/connections.service.js";
import {
  CHANNEL_HANDOFF_TOPIC,
  ChannelSupervisor,
  channelHandoffKey,
  checkGatewayPresence,
  gatewayMissingWarnedKey,
  gatewayReplicasKey,
  shareTarget,
} from "../../src/channels/supervisor.js";
import type { KernelConfig } from "../../src/config/schema.js";
import { kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { AccountsService } from "../../src/identity/accounts.js";
import { createKernel, type Kernel } from "../../src/kernel.js";
import { createLogger } from "../../src/log.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { createAgent, createOrg, PW, runConfig, session, sleep, waitFor } from "../helpers/runs.js";

/**
 * Fair sharing of channel long connections across gateway replicas (E11-B), single process: several
 * ChannelSupervisor instances share one PG / Redis and a fake channel that counts concurrent
 * `connect` calls per connection. The kernel itself runs `api,worker` (no gateway), so it only
 * provides the data and never connects anything.
 */

const CHAN_MINI = fileURLToPath(new URL("../fixtures/plugins/chan-mini/index.ts", import.meta.url));
const TTL = 2000;
const SCAN = 100;
const CONNECTIONS = 6;
const MINI_KEY = gatewayReplicasKey("chan-mini");
const OTHER_KEY = gatewayReplicasKey("chan-other");

let pgc: TestContainer;
let rd: TestContainer;
let im: FakeChannelServer;
let k: Kernel;
let raw: ReturnType<typeof createDb>;
let redis: Redis;
const ids: string[] = [];
const logLines: string[] = [];

const channels: KernelConfig["channels"] = {
  leaseTtlMs: TTL,
  scanIntervalMs: SCAN,
  shareSlack: 0,
  retryBaseMs: 100,
  deliveryConcurrency: 1,
  deliveryIdleMs: 1000,
  webhookMaxBodyBytes: 1_048_576,
};

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  im = await startFakeChannelServer();
  k = await createKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensions: [MODEL_FAKE, CHAN_MINI],
        http: { port: 0, publicUrl: "https://cap.example" },
        auth: { cookieSecure: false },
      },
    ),
    { env: {}, logger: createLogger("info", { write: (l) => logLines.push(l) }) },
  );
  await k.start();
  raw = createDb(pgc.url, 3);
  redis = new Redis(rd.url);
  await new AccountsService(kernelDb(raw)).createLocal({
    login: "owner",
    password: PW,
    displayName: "O",
  });
  const owner = await session(k, "owner");
  const orgId = await createOrg(owner);
  const agentId = await createAgent(owner, orgId);
  const en = await owner({
    method: "PUT",
    url: `/api/v1/orgs/${orgId}/extensions/chan-mini`,
    payload: { enabled: true },
  });
  expect(en.statusCode).toBe(200);
  for (let i = 0; i < CONNECTIONS; i++) {
    const res = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/channels`,
      payload: {
        plugin: "chan-mini",
        name: `share-${i}`,
        agentId,
        config: { platformUrl: im.url, appId: `share-${i}`, appSecret: "app-secret-123456" },
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    ids.push((res.json() as { channel: { id: string } }).channel.id);
  }
}, 120_000);

afterAll(async () => {
  await stopAll();
  await k?.stop();
  await im?.stop();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

/** One connect / disconnect seen by the fake channel. */
interface Ev {
  inst: string;
  id: string;
  kind: "up" | "down";
  at: number;
  /** For `down`: the handoff marker read right after the abort (async, filled in later). */
  marker?: Promise<string | null>;
}

const events: Ev[] = [];
/** Concurrent `connect` calls per connection across all instances, and the peak. */
const active = new Map<string, number>();
const peak = new Map<string, number>();
const running: { name: string; replicaId: string; sup: ChannelSupervisor }[] = [];

/** The fake channel of one supervisor instance: holds until aborted, counting concurrency. */
function fakeChannel(inst: string) {
  return {
    connectionSchema: z.object({}),
    async connect({ connectionId: id, signal }: { connectionId: string; signal: AbortSignal }) {
      const n = (active.get(id) ?? 0) + 1;
      active.set(id, n);
      peak.set(id, Math.max(peak.get(id) ?? 0, n));
      events.push({ inst, id, kind: "up", at: Date.now() });
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
      events.push({
        inst,
        id,
        kind: "down",
        at: Date.now(),
        marker: redis.get(channelHandoffKey(id)),
      });
      active.set(id, (active.get(id) ?? 1) - 1);
    },
  };
}

/** In-process stand-in for the kernel bus, shared by all supervisor instances of this file. */
const topics = new Map<string, Set<(payload: unknown) => void>>();
const bus = {
  async publish(topic: string, payload: unknown) {
    for (const fn of topics.get(topic) ?? []) queueMicrotask(() => fn(payload));
  },
  async subscribe(topic: string, fn: (payload: unknown) => void) {
    const set = topics.get(topic) ?? new Set();
    set.add(fn);
    topics.set(topic, set);
    return async () => {
      set.delete(fn);
    };
  },
} as ExtensionContext["bus"];

async function startSup(
  name: string,
  opts: {
    replicaId?: string;
    plugins?: string[];
    channels?: KernelConfig["channels"];
    onScan?: (claimOnly: boolean) => void;
  } = {},
) {
  const replicaId = opts.replicaId ?? `rep-${name}-${randomUUID()}`;
  const plugins = opts.plugins ?? ["chan-mini"];
  const cfg = opts.channels ?? channels;
  const channel = fakeChannel(name);
  const connections: Pick<ChannelConnections, "runtime"> = {
    runtime: async () =>
      ({ row: { plugin: "chan-mini" }, channel, config: {} }) as unknown as Awaited<
        ReturnType<ChannelConnections["runtime"]>
      >,
  };
  const sup = new ChannelSupervisor({
    db: kernelDb(raw),
    redis,
    bus,
    connections,
    localPlugins: () => plugins,
    onEvent: async () => {},
    config: () => ({ channels: cfg }),
    log: { warn: () => {}, error: () => {} },
    replicaId,
    ...(opts.onScan !== undefined && { onScan: opts.onScan }),
  });
  await sup.start();
  running.push({ name, replicaId, sup });
  return { name, replicaId, sup };
}

async function stopAll(): Promise<void> {
  await Promise.all(running.splice(0).map((r) => r.sup.stop()));
}

/** Connections each instance holds now, from the fake channel's events. */
function holdings(): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  for (const e of events) {
    const s = m.get(e.inst) ?? new Set<string>();
    if (e.kind === "up") s.add(e.id);
    else s.delete(e.id);
    m.set(e.inst, s);
  }
  return m;
}

/** Redis server time in ms (heartbeat scores use it). */
async function serverNow(): Promise<number> {
  const [sec, usec] = await redis.time();
  return Number(sec) * 1000 + Math.floor(Number(usec) / 1000);
}

const countOf = (inst: string) => holdings().get(inst)?.size ?? 0;
const totalHeld = () => [...holdings().values()].reduce((n, s) => n + s.size, 0);

afterEach(async () => {
  await stopAll();
  for (const id of ids) {
    await waitFor(async () => (active.get(id) ?? 0) === 0, 10_000, `connection ${id} idle`);
  }
  for (const id of ids) expect(peak.get(id) ?? 0).toBeLessThanOrEqual(1);
  events.length = 0;
  peak.clear();
});

describe("channel long connections: fair share across gateway replicas", () => {
  it("shareTarget: ceil(runnable / live) + slack, live < 1 treated as 1", () => {
    expect(shareTarget(10, 3, 1)).toBe(5);
    expect(shareTarget(0, 2, 1)).toBe(1);
    expect(shareTarget(5, 0, 0)).toBe(5);
    // Ranked: the remainder goes to the lowest ranks, the targets add up to runnable + live * slack
    expect([0, 1, 2].map((r) => shareTarget(4, 3, 0, r))).toEqual([2, 1, 1]);
    expect([0, 1, 2].map((r) => shareTarget(6, 3, 0, r))).toEqual([2, 2, 2]);
    expect([0, 1, 2].map((r) => shareTarget(10, 3, 1, r))).toEqual([5, 4, 4]);
  });

  it("1 -> 2 -> 3 instances: hand back one per round with a marker, end at 3/3 then 2/2/2", async () => {
    const a = await startSup("a");
    await waitFor(async () => countOf("a") === CONNECTIONS, 10_000, "a holds all");

    const b = await startSup("b");
    await waitFor(
      async () => countOf("a") === 3 && countOf("b") === 3,
      10_000,
      "a and b hold 3 each",
    );
    // a gave back exactly 3, one per scan round, each with its own handoff marker, and b took them
    const aDowns = events.filter((e) => e.inst === "a" && e.kind === "down");
    expect(aDowns).toHaveLength(3);
    for (let i = 1; i < aDowns.length; i++) {
      expect((aDowns[i] as Ev).at - (aDowns[i - 1] as Ev).at).toBeGreaterThanOrEqual(SCAN * 0.8);
    }
    for (const d of aDowns) expect(await d.marker).toBe(a.replicaId);
    const bUps = events.filter((e) => e.inst === "b" && e.kind === "up").map((e) => e.id);
    expect(bUps.sort()).toEqual(aDowns.map((d) => d.id).sort());
    expect(events.filter((e) => e.inst === "b" && e.kind === "down")).toHaveLength(0);

    // A third instance: a and b each give back exactly one (never dropping below their share)
    const phase = events.length;
    let minA = countOf("a");
    let minB = countOf("b");
    const watch = setInterval(() => {
      minA = Math.min(minA, countOf("a"));
      minB = Math.min(minB, countOf("b"));
    }, 5);
    try {
      const c = await startSup("c");
      await waitFor(
        async () => countOf("a") === 2 && countOf("b") === 2 && countOf("c") === 2,
        10_000,
        "2 each",
      );
      // Stable: several more rounds and nothing moves
      await sleep(SCAN * 10);
      const later = events.slice(phase);
      expect(later.filter((e) => e.inst === "a" && e.kind === "down")).toHaveLength(1);
      expect(later.filter((e) => e.inst === "b" && e.kind === "down")).toHaveLength(1);
      expect(later.filter((e) => e.kind === "up").map((e) => e.inst)).toEqual(["c", "c"]);
      expect(later).toHaveLength(4);
      for (const d of later.filter((e) => e.kind === "down")) {
        expect(await d.marker).toBe(d.inst === "a" ? a.replicaId : b.replicaId);
      }
      expect(c.replicaId).not.toBe(a.replicaId);
    } finally {
      clearInterval(watch);
    }
    expect(minA).toBe(2);
    expect(minB).toBe(2);
    expect(totalHeld()).toBe(CONNECTIONS);
  }, 60_000);

  it("the releasing instance does not claim a connection while its handoff marker exists", async () => {
    const [mine, other] = ids as [string, string];
    const replicaId = `rep-solo-${randomUUID()}`;
    await redis.set(channelHandoffKey(mine), replicaId, "PX", 1500);
    await redis.set(channelHandoffKey(other), "someone-else", "PX", 1500);
    const setAt = Date.now();
    await startSup("solo", { replicaId });
    await waitFor(async () => countOf("solo") === CONNECTIONS - 1, 10_000, "all but one");
    // Another replica's marker does not block it; its own does until the marker expires
    expect(holdings().get("solo")?.has(other)).toBe(true);
    expect(holdings().get("solo")?.has(mine)).toBe(false);
    await waitFor(async () => countOf("solo") === CONNECTIONS, 10_000, "claimed after expiry");
    const up = events.find((e) => e.id === mine && e.kind === "up") as Ev;
    expect(up.at - setAt).toBeGreaterThanOrEqual(1400);
  }, 30_000);

  it("a gateway without the plugin does not count: all connections held by the capable ones", async () => {
    // Ruling R3: c has no chan-mini (it only loads another channel plugin), so chan-mini's share
    // is split over a and b only; with one global heartbeat set c would count and 2 stay unheld
    const a = await startSup("a");
    const b = await startSup("b");
    const c = await startSup("c", { plugins: ["chan-other"] });
    await waitFor(
      async () => countOf("a") === 3 && countOf("b") === 3,
      10_000,
      "a and b hold 3 each",
    );
    await sleep(SCAN * 10);
    expect(countOf("a")).toBe(3);
    expect(countOf("b")).toBe(3);
    expect(countOf("c")).toBe(0);
    expect(totalHeld()).toBe(CONNECTIONS);
    // c heartbeats only for the plugin it has
    expect(await redis.zscore(OTHER_KEY, c.replicaId)).not.toBeNull();
    expect(await redis.zscore(MINI_KEY, c.replicaId)).toBeNull();
    expect((await redis.zrange(MINI_KEY, "0", "-1")).sort()).toEqual(
      [a.replicaId, b.replicaId].sort(),
    );
  }, 30_000);

  it("a handback nudges replicas below their share to claim at once, not on their next round", async () => {
    const slow: KernelConfig["channels"] = {
      ...channels,
      leaseTtlMs: 20_000,
      scanIntervalMs: 4_000,
    };
    await startSup("a", { channels: slow });
    await waitFor(async () => countOf("a") === CONNECTIONS, 10_000, "a holds all");
    // Start b half a round after a's scan, so without the nudge b's next scan is ~2s after a's
    await sleep(slow.scanIntervalMs / 2);
    await startSup("b", { channels: slow });
    await waitFor(async () => countOf("b") >= 1, 15_000, "b claims one");
    const down = events.find((e) => e.inst === "a" && e.kind === "down") as Ev;
    const up = events.find((e) => e.inst === "b" && e.kind === "up") as Ev;
    expect(up.id).toBe(down.id);
    expect(up.at - down.at).toBeLessThan(1_000);
  }, 30_000);

  it("handoff nudges coalesce: a burst of 20 runs at most 2 claim-only scans", async () => {
    let claimScans = 0;
    await startSup("burst", {
      channels: { ...channels, leaseTtlMs: 20_000, scanIntervalMs: 4_000 },
      onScan: (claimOnly) => {
        if (claimOnly) claimScans++;
      },
    });
    await waitFor(async () => countOf("burst") === CONNECTIONS, 10_000, "burst holds all");
    // A nudge for a plugin this replica has not loaded is ignored
    await bus.publish(CHANNEL_HANDOFF_TOPIC, { plugin: "chan-other", replicaId: "someone" });
    await sleep(100);
    expect(claimScans).toBe(0);
    for (let i = 0; i < 20; i++) {
      await bus.publish(CHANNEL_HANDOFF_TOPIC, { plugin: "chan-mini", replicaId: "someone" });
    }
    await sleep(500);
    expect(claimScans).toBeGreaterThanOrEqual(1);
    expect(claimScans).toBeLessThanOrEqual(2);
  }, 30_000);

  it("heartbeat: the member is the replica id with a server-time score; stop() removes it", async () => {
    const s = await startSup("hb");
    await waitFor(
      async () => (await redis.zscore(MINI_KEY, s.replicaId)) !== null,
      5_000,
      "heartbeat written",
    );
    const score = Number(await redis.zscore(MINI_KEY, s.replicaId));
    expect((await serverNow()) - score).toBeLessThan(TTL);
    expect(await redis.pttl(MINI_KEY)).toBeGreaterThan(0);
    // A stale member is cleared by the next heartbeat round
    await redis.zadd(MINI_KEY, (await serverNow()) - TTL - 1000, "stale-replica");
    await waitFor(
      async () => (await redis.zscore(MINI_KEY, "stale-replica")) === null,
      5_000,
      "stale member removed",
    );
    await stopAll();
    expect(await redis.zscore(MINI_KEY, s.replicaId)).toBeNull();
  }, 30_000);

  it("maintenance check warns once per interval per missing plugin, after the grace period", async () => {
    await redis.del(MINI_KEY, OTHER_KEY, gatewayMissingWarnedKey);
    const warns: { msg: string; fields: Record<string, unknown> | undefined }[] = [];
    const deps = {
      db: kernelDb(raw),
      redis,
      config: () => ({ channels }),
      log: { warn: (msg: string, fields?: Record<string, unknown>) => warns.push({ msg, fields }) },
      everyMs: 1000,
    };
    // Within the startup grace period: silent
    expect(await checkGatewayPresence({ ...deps, graceUntil: Date.now() + 10_000 })).toBe(false);
    // A live gateway for another plugin does not cover chan-mini
    await redis.zadd(OTHER_KEY, await serverNow(), "other-replica");
    expect(await checkGatewayPresence({ ...deps, graceUntil: Date.now() - 1 })).toBe(true);
    expect(await checkGatewayPresence(deps)).toBe(false);
    expect(warns).toHaveLength(1);
    expect(warns[0]?.msg).toMatch(/no live gateway replica/);
    expect(warns[0]?.fields).toMatchObject({ plugins: ["chan-mini"], connections: CONNECTIONS });

    // A live chan-mini heartbeat: no warning, even after the rate limit window
    await redis.del(gatewayMissingWarnedKey);
    await redis.zadd(MINI_KEY, await serverNow(), "live-replica");
    expect(await checkGatewayPresence(deps)).toBe(false);
    // Only a stale heartbeat (older than one lease TTL) counts as no gateway
    await redis.zadd(MINI_KEY, (await serverNow()) - TTL - 1000, "live-replica");
    expect(await checkGatewayPresence(deps)).toBe(true);
    expect(warns).toHaveLength(2);

    // No holdable connections (inactive, or the plugin disabled for the org): nothing to warn about
    await redis.del(gatewayMissingWarnedKey);
    await sql`UPDATE capybara.channel_connections SET status = 'disabled'`.execute(raw);
    try {
      expect(await checkGatewayPresence(deps)).toBe(false);
    } finally {
      await sql`UPDATE capybara.channel_connections SET status = 'active'`.execute(raw);
    }
    await sql`UPDATE capybara.extension_org_configs SET enabled = false WHERE plugin = 'chan-mini'`.execute(
      raw,
    );
    try {
      expect(await checkGatewayPresence(deps)).toBe(false);
    } finally {
      await sql`UPDATE capybara.extension_org_configs SET enabled = true WHERE plugin = 'chan-mini'`.execute(
        raw,
      );
    }
    expect(warns).toHaveLength(2);

    // Ruling R4: webhook-mode connections also need a live gateway (it serves the webhook route)
    await redis.del(gatewayMissingWarnedKey);
    await sql`UPDATE capybara.channel_connections SET inbound_mode = 'webhook'`.execute(raw);
    try {
      expect(await checkGatewayPresence(deps)).toBe(true);
    } finally {
      await sql`UPDATE capybara.channel_connections SET inbound_mode = 'long_connection'`.execute(
        raw,
      );
    }
    expect(warns).toHaveLength(3);
    expect(warns[2]?.fields).toMatchObject({ plugins: ["chan-mini"], connections: CONNECTIONS });
    await redis.del(MINI_KEY, OTHER_KEY, gatewayMissingWarnedKey);
  });

  it("a worker process without the gateway role logs one startup info line", () => {
    const lines = logLines
      .map((l) => JSON.parse(l) as { level?: string; msg?: string })
      .filter((l) => /worker role without gateway/.test(l.msg ?? ""));
    expect(lines).toHaveLength(1);
    expect(lines[0]?.level).toBe("info");
  });
});
