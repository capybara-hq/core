import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import Fastify from "fastify";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { createKeyring } from "../../src/ctx/secrets.js";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import {
  DEVICE_STREAM_TICKET_PREFIX,
  type DeviceAccessCaller,
  DeviceAccessService,
} from "../../src/device-access/device-access.service.js";
import {
  DeviceStreamViewers,
  hopHeaders,
  RECEIVE_HIGH_WATER_BYTES,
  VIEWER_MAX_MESSAGE_BYTES,
  VIEWER_RECHECK_MS,
  verifyHopHeaders,
  WsEnd,
} from "../../src/device-access/viewer.js";
import { viewerThrottleOn } from "../../src/device-access/viewer-routes.js";
import { registerDeviceConnectRoute } from "../../src/dial-in/routes.js";
import { redactPath } from "../../src/http/error.filter.js";
import { createLogger } from "../../src/log.js";
import { DeviceServices } from "../../src/sandbox/device-services.js";
import { SandboxService } from "../../src/sandbox/sandbox.service.js";
import type { SandboxUseContext } from "../../src/sandbox/use-context.js";
import { echoServiceSpec } from "../fixtures/extensions/fake-device-access/index.js";
import { FAKE_PERMISSION_SUPPORT } from "../fixtures/plugins/device-fake/index.js";
import { legacyDbFor } from "../helpers/conversations.js";
import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createAgent,
  createConv,
  createOrgWithProviders,
  enableExtensions,
  PW,
  runConfig,
  session,
  startKernel,
  type TestKernel,
  waitFor,
} from "../helpers/runs.js";

/**
 * The viewer endpoint (browser use spec §6.2): `GET /device/stream?ticket=` on the gateway role
 * takes a single-use viewer ticket, checks its record again, holds the device for the viewer's
 * life and pipes the device service's stream to the browser unchanged. On a `device-fake` device
 * with the framed echo service.
 */

const FAKE_DEVICE_ACCESS = fileURLToPath(
  new URL("../fixtures/extensions/fake-device-access/index.ts", import.meta.url),
);
const CALLER: DeviceAccessCaller = { extension: "fake-device-access", services: ["echo"] };
const MIN = 60_000;

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let k: TestKernel;
let ownerId: string;
let orgId: string;
let sandboxRoot: string;
let access: DeviceAccessService;
/** Every log line the kernel wrote. */
const lines: string[] = [];

beforeAll(async () => {
  sandboxRoot = await mkdtemp(join(tmpdir(), "cap-viewer-"));
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = legacyDbFor(raw);
  redis = new Redis(rd.url);
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker", "gateway"],
        extensions: [
          MODEL_FAKE,
          fileURLToPath(new URL("../fixtures/plugins/device-fake/index.ts", import.meta.url)),
          FAKE_DEVICE_ACCESS,
        ],
        extensionConfig: { "device-fake": { root: sandboxRoot } },
        // behind the web tier (one trusted hop): its X-Forwarded-For names the client
        http: { port: 0, publicUrl: "https://capybara.example.com", trustProxy: 1 },
      },
    ),
    { logger: createLogger("debug", { write: (line) => void lines.push(line) }) },
  );
  access = k.app.get(DeviceAccessService);
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  orgId = await createOrgWithProviders(k, await session(k, "owner"));
  await enableExtensions(raw, orgId, "fake-device-access");
});

afterAll(async () => {
  await k?.close();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
  if (sandboxRoot) await rm(sandboxRoot, { recursive: true, force: true });
});

interface Setup {
  accountId: string;
  deviceId: string;
  conversationId: string;
}

/** A member with a running `device-fake` device of their own, its echo service started. */
async function memberWithDevice(): Promise<Setup> {
  const login = `m-${randomUUID().slice(0, 8)}`;
  const accountId = (
    await accountsFor(db).createLocal({ login, password: PW, displayName: `Dev ${login}` })
  ).id;
  await testMembers(db).add(orgId, accountId, "member", ownerId);
  const req = await session(k, login);
  const deviceId = randomUUID();
  await db
    .insertInto("devices")
    .values({
      id: deviceId,
      org_id: orgId,
      owner_kind: "personal",
      owner_account_id: accountId,
      name: "Box",
      provider: "device-fake",
      network_mode: "allowlist",
      network_hosts: JSON.stringify([]),
      report: JSON.stringify({ support: FAKE_PERMISSION_SUPPORT }),
    })
    .execute();
  const agentId = await createAgent(req, orgId);
  const conversationId = await createConv(req, orgId, agentId);
  await db
    .updateTable("conversations")
    .set({ device_id: deviceId })
    .where("id", "=", conversationId)
    .execute();
  const use: SandboxUseContext = {
    orgId,
    deviceId,
    holderConversationId: conversationId,
    actor: { accountId, conversationId },
  };
  await k.app.get(DeviceServices).ensure(use, echoServiceSpec(), AbortSignal.timeout(30_000));
  return { accountId, deviceId, conversationId };
}

let s: Setup;

beforeEach(async () => {
  s = await memberWithDevice();
});

const mint = async (who: Setup = s): Promise<string> =>
  (
    await access.mintTicket(
      { orgId, accountId: who.accountId, conversationId: who.conversationId },
      "echo",
      CALLER,
    )
  ).id;

interface Viewer {
  ws: WebSocket;
  /** The messages received, as text. */
  received: string[];
  /** Resolves with the close code and reason. */
  closed: Promise<{ code: number; reason: string }>;
  /** Resolves with the next message received from now on. */
  next(): Promise<string>;
}

/** A browser's viewer socket on `/device/stream?ticket=`. */
function viewer(ticket: string, headers: Record<string, string> = {}): Viewer {
  const ws = new WebSocket(`ws://127.0.0.1:${k.port}/device/stream?ticket=${ticket}`, { headers });
  const received: string[] = [];
  const waiting: ((m: string) => void)[] = [];
  ws.on("message", (data: Buffer) => {
    const m = data.toString("utf8");
    received.push(m);
    for (const w of waiting.splice(0)) w(m);
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.on("close", (code, reason) => resolve({ code, reason: reason.toString("utf8") }));
    ws.on("error", () => {});
  });
  return {
    ws,
    received,
    closed,
    next: () => new Promise<string>((resolve) => waiting.push(resolve)),
  };
}

/** Sends `text` and resolves with the echo. */
async function roundTrip(v: Viewer, text: string): Promise<string> {
  const answer = v.next();
  if (v.ws.readyState !== WebSocket.OPEN)
    await new Promise<void>((resolve) => v.ws.once("open", () => resolve()));
  v.ws.send(Buffer.from(text, "utf8"));
  return answer;
}

const instanceStatus = async (): Promise<string | undefined> =>
  (
    await db
      .selectFrom("device_instances")
      .select("status")
      .where("device_id", "=", s.deviceId)
      .executeTakeFirst()
  )?.status;

const auditsOf = (action: string, deviceId: string) =>
  db
    .selectFrom("audit_events")
    .selectAll()
    .where("action", "=", action)
    .where("target", "=", deviceId)
    .execute();

describe("device stream viewer", () => {
  it("viewer pipes messages both ways to the echo service", async () => {
    const v = viewer(await mint());
    expect(await roundTrip(v, "one")).toBe("one");
    expect(await roundTrip(v, "two")).toBe("two");
    // several in flight keep their order
    const many = Array.from({ length: 20 }, (_, i) => `m${i}`);
    for (const m of many) v.ws.send(Buffer.from(m, "utf8"));
    await waitFor(async () => v.received.length >= 22, 10_000, "all echoes");
    expect(v.received.slice(2)).toEqual(many);
    v.ws.close(1000);
    expect((await v.closed).code).toBe(1000);
    // the open and the close are audited (frames are not)
    const opened = await waitFor(async () => {
      const r = await auditsOf("browser.view", s.deviceId);
      return r.length === 1 ? r : null;
    });
    expect(opened[0]?.detail).toMatchObject({ deviceId: s.deviceId, service: "echo" });
    expect(opened[0]?.actor_account_id).toBe(s.accountId);
    const closedRows = await waitFor(async () => {
      const r = await auditsOf("browser.view_closed", s.deviceId);
      return r.length === 1 ? r : null;
    });
    expect(closedRows[0]?.detail).toMatchObject({ deviceId: s.deviceId, service: "echo" });
    const detail = closedRows[0]?.detail as { durationMs?: unknown } | undefined;
    expect(typeof detail?.durationMs).toBe("number");
  });

  it("ticket is single use", async () => {
    const ticket = await mint();
    const first = viewer(ticket);
    expect(await roundTrip(first, "hi")).toBe("hi");
    first.ws.close(1000);
    await first.closed;
    const second = viewer(ticket);
    expect((await second.closed).code).toBe(4401);
    // an unknown ticket and none at all likewise
    expect((await viewer("nope").closed).code).toBe(4401);
    expect((await viewer("").closed).code).toBe(4401);
  });

  it("ticket bound to device and account", async () => {
    const b = await memberWithDevice();
    // a record edited to another member's account: the conversation's owner differs
    const t1 = await mint();
    const key1 = `${DEVICE_STREAM_TICKET_PREFIX}${t1}`;
    const rec1 = JSON.parse((await redis.get(key1)) as string) as Record<string, unknown>;
    await redis.set(key1, JSON.stringify({ ...rec1, accountId: b.accountId }), "EX", 60);
    expect((await viewer(t1).closed).code).toBe(4401);
    // a record edited to device B: the conversation's device is A, never B's service
    const t2 = await mint();
    const key2 = `${DEVICE_STREAM_TICKET_PREFIX}${t2}`;
    const rec2 = JSON.parse((await redis.get(key2)) as string) as Record<string, unknown>;
    await redis.set(key2, JSON.stringify({ ...rec2, deviceId: b.deviceId }), "EX", 60);
    expect((await viewer(t2).closed).code).toBe(4401);
    expect(await auditsOf("browser.view", b.deviceId)).toHaveLength(0);
    // a record naming a service the extension's manifest does not declare
    const t3 = await mint();
    const key3 = `${DEVICE_STREAM_TICKET_PREFIX}${t3}`;
    const rec3 = JSON.parse((await redis.get(key3)) as string) as Record<string, unknown>;
    await redis.set(key3, JSON.stringify({ ...rec3, service: "other" }), "EX", 60);
    expect((await viewer(t3).closed).code).toBe(4401);
    // B's own ticket reaches B's service
    const vb = viewer(await mint(b));
    expect(await roundTrip(vb, "b")).toBe("b");
    vb.ws.close(1000);
    await vb.closed;
  });

  it("open viewer holds the device", async () => {
    const sandbox = k.app.get(SandboxService);
    const idle = () => new Date(Date.now() + 30 * MIN);
    const v = viewer(await mint());
    expect(await roundTrip(v, "hold")).toBe("hold");
    await sandbox.suspendIdle(idle());
    const row = () =>
      db
        .selectFrom("device_instances")
        .select("status")
        .where("device_id", "=", s.deviceId)
        .executeTakeFirstOrThrow();
    expect((await row()).status).toBe("running");
    // still streaming after the sweep
    expect(await roundTrip(v, "still")).toBe("still");
    v.ws.close(1000);
    await v.closed;
    // the hold ends with the viewer: the next sweep suspends the device
    await waitFor(async () => {
      await sandbox.suspendIdle(idle());
      return (await row()).status === "suspended";
    });
  });

  it("a hop without a valid HMAC is refused before anything is read", async () => {
    const ticket = await mint();
    const ws = new WebSocket(`ws://127.0.0.1:${k.port}/internal/device-stream/${ticket}`, {
      headers: { "x-capybara-hop": "00".repeat(32), "x-capybara-hop-at": String(Date.now()) },
    });
    const status = await new Promise<number>((resolve) => {
      ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      ws.on("open", () => resolve(101));
      ws.on("error", () => {});
    });
    expect(status).toBe(401);
    // the ticket was not consumed by the refused hop
    expect(await redis.exists(`${DEVICE_STREAM_TICKET_PREFIX}${ticket}`)).toBe(1);
  });

  it("ticket value never appears in the request log", async () => {
    const ticket = await mint();
    const v = viewer(ticket);
    expect(await roundTrip(v, "log")).toBe("log");
    v.ws.close(1000);
    await v.closed;
    expect((await viewer(ticket).closed).code).toBe(4401);
    const hop = new WebSocket(`ws://127.0.0.1:${k.port}/internal/device-stream/${ticket}`);
    await new Promise<void>((resolve) => {
      hop.on("unexpected-response", () => resolve());
      hop.on("open", () => resolve());
      hop.on("error", () => resolve());
    });
    hop.terminate();
    await waitFor(async () => lines.some((l) => l.includes("/device/stream")));
    await waitFor(async () => lines.some((l) => l.includes("/internal/device-stream/:ticket")));
    expect(lines.filter((l) => l.includes(ticket))).toEqual([]);
    expect(redactPath(`/internal/device-stream/${ticket}`)).toBe("/internal/device-stream/:ticket");
  });

  it("a viewer message over the limit closes it (1009), releases the hold and audits the close", async () => {
    const v = viewer(await mint());
    expect(await roundTrip(v, "small")).toBe("small");
    v.ws.send(Buffer.alloc(VIEWER_MAX_MESSAGE_BYTES + 1, 1));
    expect((await v.closed).code).toBe(1009);
    await waitFor(async () => (await auditsOf("browser.view_closed", s.deviceId)).length === 1);
    await waitFor(async () => {
      await k.app.get(SandboxService).suspendIdle(new Date(Date.now() + 30 * MIN));
      return (await instanceStatus()) === "suspended";
    });
  });

  it("a viewer that stops answering pings is closed and releases the hold", async () => {
    const viewers = k.app.get(DeviceStreamViewers);
    viewers.pingIntervalMs = 50;
    try {
      const v = viewer(await mint());
      expect(await roundTrip(v, "ping")).toBe("ping");
      // the tab goes away without a close: its socket reads nothing, so no pong comes back
      v.ws.pause();
      await waitFor(async () => (await auditsOf("browser.view_closed", s.deviceId)).length === 1);
      const row = (await auditsOf("browser.view_closed", s.deviceId))[0];
      expect((row?.detail as { code?: unknown } | undefined)?.code).toBe(1006);
      await waitFor(async () => {
        await k.app.get(SandboxService).suspendIdle(new Date(Date.now() + 30 * MIN));
        return (await instanceStatus()) === "suspended";
      });
      v.ws.terminate();
    } finally {
      viewers.pingIntervalMs = 20_000;
    }
  });

  it("a socket pauses at the byte high-water, resumes at half, and closes 1013 when paused too long", async () => {
    const wss = new WebSocketServer({ port: 0 });
    const port = (wss.address() as { port: number }).port;
    const ends: WsEnd[] = [];
    wss.on("connection", (ws) => {
      ends.push(new WsEnd(ws as never, { pingIntervalMs: 20, pausedLimitMs: 300 }));
    });
    try {
      const client = new WebSocket(`ws://127.0.0.1:${port}`);
      const closed = new Promise<number>((resolve) => client.on("close", (c) => resolve(c)));
      await new Promise<void>((resolve) => client.once("open", () => resolve()));
      const end = await waitFor(async () => ends[0]);
      const chunk = Buffer.alloc(256 * 1024, 2);
      // 1.75 MiB queued: still reading
      for (let i = 0; i < 7; i++) client.send(chunk);
      await waitFor(async () => end.pending === 7 * chunk.length);
      expect(end.paused).toBe(false);
      // the eighth reaches 2 MiB: paused
      client.send(chunk);
      await waitFor(async () => end.paused);
      expect(end.pending).toBe(RECEIVE_HIGH_WATER_BYTES);
      // taking half resumes it
      for (let i = 0; i < 4; i++) await end.next();
      expect(end.paused).toBe(false);
      // paused again and left alone: closed with 1013
      for (let i = 0; i < 4; i++) client.send(chunk);
      await waitFor(async () => end.paused);
      expect(await closed).toBe(1013);
    } finally {
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  });

  it("hop headers verify under the current and the previous master key", async () => {
    const a = Buffer.alloc(32, 1);
    const b = Buffer.alloc(32, 2);
    const old = createKeyring(a, []);
    const rotated = createKeyring(b, [a]);
    const other = createKeyring(b, []);
    const now = Date.now();
    const ticket = "t".repeat(32);
    const fromOld = hopHeaders(old, ticket, now);
    const fromNew = hopHeaders(rotated, ticket, now);
    const check = (k: typeof old, h: Record<string, string>) =>
      verifyHopHeaders(k, ticket, h["x-capybara-hop"], h["x-capybara-hop-at"], now);
    // a replica still on the old key and one already rotated accept each other only one way
    expect(check(rotated, fromOld)).toBe(true);
    expect(check(rotated, fromNew)).toBe(true);
    expect(check(other, fromOld)).toBe(false);
    // stale or for another ticket: refused
    expect(
      verifyHopHeaders(
        rotated,
        ticket,
        fromNew["x-capybara-hop"],
        fromNew["x-capybara-hop-at"],
        now + 61_000,
      ),
    ).toBe(false);
    expect(
      verifyHopHeaders(
        rotated,
        "u".repeat(32),
        fromNew["x-capybara-hop"],
        fromNew["x-capybara-hop-at"],
        now,
      ),
    ).toBe(false);
  });

  // near the end: the per-address limit fills; its counters are cleared after
  it("viewer upgrades are limited per forwarded client address", async () => {
    const status = (client: string) =>
      new Promise<number>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${k.port}/device/stream?ticket=nope`, {
          headers: { "x-forwarded-for": client },
        });
        ws.on("unexpected-response", (_req, res) => {
          resolve(res.statusCode ?? 0);
          ws.terminate();
        });
        ws.on("close", () => resolve(101));
        ws.on("error", () => {});
      });
    try {
      let limited = false;
      for (let i = 0; i < 130 && !limited; i++) limited = (await status("198.51.100.1")) === 429;
      expect(limited).toBe(true);
      // another client behind the same web tier has its own bucket
      expect(await status("198.51.100.2")).toBe(101);
    } finally {
      const keys = await redis.keys("throttler:*device-stream*");
      if (keys.length > 0) await redis.del(...keys);
    }
  });

  it("the viewer limit applies only when http.trustProxy trusts a hop (ruling R23)", async () => {
    expect(viewerThrottleOn(false)).toBe(false);
    expect(viewerThrottleOn(0)).toBe(false);
    expect(viewerThrottleOn([])).toBe(false);
    expect(viewerThrottleOn(1)).toBe(true);
    expect(viewerThrottleOn(["10.0.0.0/8"])).toBe(true);
    // the routes as the gateway role wires them, on a bare server: no counter without trust
    for (const trustProxy of [false, 1] as const) {
      const app = Fastify();
      const reserve = vi.fn(async () => {});
      const succeeded = vi.fn(async () => {});
      const serve = vi.fn(async (socket: WebSocket, _t: string, onTaken?: () => Promise<void>) => {
        await onTaken?.();
        socket.close(4401, "invalid ticket");
      });
      await registerDeviceConnectRoute(app, {
        gateway: { admit: async () => null, accept: async () => {} },
        maxFrameBytes: 1024 * 1024,
        streams: {
          viewers: {
            serve: serve as never,
            serveHop: async () => {},
            verifyHop: () => false,
            claimHop: async () => false,
          },
          ...(viewerThrottleOn(trustProxy) && { throttler: { reserve, succeeded } }),
        },
      });
      await app.listen({ port: 0, host: "127.0.0.1" });
      try {
        const port = (app.server.address() as { port: number }).port;
        const ws = new WebSocket(`ws://127.0.0.1:${port}/device/stream?ticket=${"x".repeat(32)}`);
        ws.on("error", () => {});
        expect(await new Promise<number>((r) => ws.on("close", (c) => r(c)))).toBe(4401);
        expect(serve).toHaveBeenCalledTimes(1);
        expect(reserve).toHaveBeenCalledTimes(trustProxy === false ? 0 : 1);
        expect(succeeded).toHaveBeenCalledTimes(trustProxy === false ? 0 : 1);
      } finally {
        await app.close();
      }
    }
  });

  it("a valid ticket gives its attempt back; an invalid one keeps it counted", async () => {
    const counters = async () => {
      const keys = await redis.keys("throttler:*device-stream*");
      return Promise.all(keys.map((key) => redis.get(key)));
    };
    try {
      const v = viewer(await mint(), { "x-forwarded-for": "198.51.100.9" });
      expect(await roundTrip(v, "refund")).toBe("refund");
      v.ws.close(1000);
      await v.closed;
      expect((await counters()).filter((n) => Number(n) > 0)).toEqual([]);
      expect((await viewer("nope", { "x-forwarded-for": "198.51.100.10" }).closed).code).toBe(4401);
      expect(await counters()).toEqual(["1"]);
    } finally {
      const keys = await redis.keys("throttler:*device-stream*");
      if (keys.length > 0) await redis.del(...keys);
    }
  });

  it("an open viewer whose access lapses is closed: 4401 for the extension, 4404 for the provider", async () => {
    const viewers = k.app.get(DeviceStreamViewers);
    viewers.recheckMs = 50;
    const setEnabled = (plugin: string, enabled: boolean) =>
      sql`UPDATE capybara.extension_org_configs SET enabled = ${enabled}
        WHERE plugin = ${plugin} AND org_id = ${orgId}`.execute(raw);
    try {
      // the extension is switched off in the org mid-view
      const v = viewer(await mint());
      expect(await roundTrip(v, "on")).toBe("on");
      await setEnabled("fake-device-access", false);
      try {
        expect((await v.closed).code).toBe(4401);
      } finally {
        await setEnabled("fake-device-access", true);
      }
      // the device's provider is switched off in the org mid-view
      const w = viewer(await mint());
      expect(await roundTrip(w, "on")).toBe("on");
      await setEnabled("device-fake", false);
      try {
        expect((await w.closed).code).toBe(4404);
      } finally {
        await setEnabled("device-fake", true);
      }
      // both closes are audited with their codes
      const closes = await waitFor(async () => {
        const r = await auditsOf("browser.view_closed", s.deviceId);
        return r.length === 2 ? r : null;
      });
      expect(closes.map((r) => (r.detail as { code?: number }).code).sort()).toEqual([4401, 4404]);
    } finally {
      viewers.recheckMs = VIEWER_RECHECK_MS;
    }
  });

  // last: the viewers stop as on a replica shutdown
  it("replica shutdown closes open viewers with 1001", async () => {
    const v = viewer(await mint());
    expect(await roundTrip(v, "bye")).toBe("bye");
    await k.app.get(DeviceStreamViewers).stop();
    expect((await v.closed).code).toBe(1001);
    // the hold was released with it
    await waitFor(async () => {
      await k.app.get(SandboxService).suspendIdle(new Date(Date.now() + 30 * MIN));
      const r = await db
        .selectFrom("device_instances")
        .select("status")
        .where("device_id", "=", s.deviceId)
        .executeTakeFirstOrThrow();
      return r.status === "suspended";
    });
  });
});
