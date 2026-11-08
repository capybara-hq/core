import { randomUUID } from "node:crypto";
import { connect as tcpConnect } from "node:net";
import type { KernelReq } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { DeviceGateway } from "../../src/devices/device-gateway.js";
import {
  deviceLeaseKey,
  deviceResKey,
  deviceResTopic,
  deviceRevokedTopic,
  deviceTakenKey,
} from "../../src/devices/keys.js";
import { MachinesService } from "../../src/devices/machines.js";
import { DeviceRelay } from "../../src/devices/relay.js";
import { EnvironmentsService } from "../../src/environments/environments.service.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import { legacyDbFor } from "../helpers/conversations.js";
import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import {
  createOrg,
  PW,
  runConfig,
  session,
  sleep,
  startKernel,
  type TestKernel,
  waitFor,
} from "../helpers/runs.js";
import { FakeMachine, refusal } from "./fake-machine.js";

/**
 * The gateway holds the WebSocket connections of connected machines (environments spec §13.4):
 * the credential and protocol are checked before the upgrade, the connection claims the
 * environment's lease after `hello`, and relayed requests reach the socket and come back.
 */

const MAX_FRAME_BYTES = 64 * 1024;
const EXEC_RESULT = { exitCode: 0, stdout: "hi\n", stderr: "", truncated: false, timedOut: false };
const LIMITS = { cpu: 1, memoryMb: 512, diskMb: 1024, egress: "none", allowHosts: [] };
const execArgs = {
  command: "echo hi",
  timeoutMs: 1000,
  maxOutputBytes: 1000,
  tag: "t1",
  actor: { accountId: "a", conversationId: "c" },
  limits: LIMITS,
};

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let k: TestKernel;
let machines: MachinesService;
let environments: EnvironmentsService;
let relay: DeviceRelay;
let txHost: TransactionHost;
let ownerId: string;
let orgId: string;
let url: string;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = legacyDbFor(raw);
  redis = new Redis(rd.url);
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker", "gateway"],
        environments: {
          device: { reconnectGraceSeconds: 5, leaseTtlMs: 6000, maxFrameBytes: MAX_FRAME_BYTES },
        },
      },
    ),
  );
  machines = k.app.get(MachinesService);
  environments = k.app.get(EnvironmentsService);
  relay = k.app.get(DeviceRelay);
  txHost = k.app.get(TransactionHost);
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  orgId = await createOrg(await session(k, "owner"));
  url = `ws://127.0.0.1:${k.port}/device/connect`;
}, 180_000);

afterAll(async () => {
  await k?.close();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

/** A member's device environment with a machine: the ids and the credential. */
async function connected() {
  const login = `m-${randomUUID().slice(0, 8)}`;
  const accountId = (await accountsFor(db).createLocal({ login, password: PW, displayName: login }))
    .id;
  await testMembers(db).add(orgId, accountId, "member", ownerId);
  const m = await txHost.run(async () => {
    const { id: environmentId } = await environments.createDevice(orgId, accountId, "Box");
    const issued = await machines.issue({
      orgId,
      environmentId,
      accountId,
      name: "box",
      os: "linux",
      arch: "x64",
      programVersion: "0.1.0",
    });
    return { environmentId, ...issued };
  });
  return { accountId, ...m };
}

const held = (environmentId: string) =>
  waitFor(() => redis.get(deviceLeaseKey(environmentId)), 10_000, "lease held");
const codeOf = (body: string) => (JSON.parse(body) as { error: { code: string } }).error.code;

describe("GET /device/connect", () => {
  it("unknown credential is 401 before upgrade", async () => {
    const r = await refusal(url, {
      Authorization: `Bearer cap_dev_${"A".repeat(43)}`,
      "X-Capybara-Device-Protocol": "1",
    });
    expect(r?.status).toBe(401);
    expect(codeOf(r?.body ?? "")).toBe("device.credential_invalid");
    const none = await refusal(url, { "X-Capybara-Device-Protocol": "1" });
    expect(none?.status).toBe(401);
  });

  it("protocol 2 is 426 program_outdated", async () => {
    const m = await connected();
    for (const protocol of ["2", ""]) {
      const r = await refusal(url, {
        Authorization: `Bearer ${m.credential}`,
        ...(protocol !== "" && { "X-Capybara-Device-Protocol": protocol }),
      });
      expect(r?.status).toBe(426);
      expect(codeOf(r?.body ?? "")).toBe("environment.program_outdated");
    }
  });

  it("hello then a relayed exec round-trip", async () => {
    const m = await connected();
    const machine = new FakeMachine(url, m.credential, (req) =>
      req.op === "exec" ? { ok: true, result: EXEC_RESULT } : undefined,
    );
    await machine.opened;
    expect(await held(m.environmentId)).toBeTruthy();
    const r = await relay.call(m.environmentId, "exec", execArgs, {
      deadlineMs: 6000,
      signal: AbortSignal.timeout(20_000),
    });
    expect(r).toEqual(EXEC_RESULT);
    expect(machine.frames[0]).toMatchObject({ type: "req", op: "exec", args: execArgs });
    // the hello was recorded
    const row = await db
      .selectFrom("environment_machines")
      .select(["mode", "last_seen_at"])
      .where("id", "=", m.machineId)
      .executeTakeFirstOrThrow();
    expect(row.mode).toBe("os");
    expect(row.last_seen_at).not.toBeNull();
    machine.close();
    await machine.closed;
    // the lease is handed back when the machine leaves
    await waitFor(
      async () => (await redis.get(deviceLeaseKey(m.environmentId))) === null,
      10_000,
      "lease released",
    );
  });

  it("a result is stored with the grace + deadline TTL and a cancel is forwarded", async () => {
    const m = await connected();
    const machine = new FakeMachine(url, m.credential);
    await machine.opened;
    await held(m.environmentId);
    const ac = new AbortController();
    const call = relay
      .call(m.environmentId, "exec", execArgs, { deadlineMs: 8000, signal: ac.signal })
      .catch((e: unknown) => e);
    const req = (await machine.next((f) => f.type === "req")) as KernelReq;
    ac.abort(new Error("stop"));
    await call;
    // taken by the machine: the give-up is a cancel, forwarded to the socket
    expect(await machine.next((f) => f.type === "cancel" && f.id === req.id)).toBeTruthy();
    // a late result is still stored (TTL grace 5 s + deadline 8 s + margin), nobody reads it
    machine.respond(req.id, { ok: true, result: EXEC_RESULT });
    const ttl = await waitFor(async () => {
      const t = await redis.pttl(deviceResKey(req.id));
      return t > 0 ? t : null;
    });
    expect(ttl).toBeGreaterThan(8000 + 5000);
    machine.close();
  });

  it("a frame before hello closes 4400; a frame over maxFrameBytes closes 1009", async () => {
    const m = await connected();
    const early = new FakeMachine(url, m.credential, undefined, { hello: false });
    await early.opened;
    early.respond(randomUUID(), { ok: true, result: null });
    expect((await early.closed).code).toBe(4400);

    const big = new FakeMachine(url, m.credential);
    await big.opened;
    await held(m.environmentId);
    big.respond(randomUUID(), { ok: true, result: "x".repeat(MAX_FRAME_BYTES + 1) });
    expect((await big.closed).code).toBe(1009);
  });

  it("revoking closes the socket with 4003 and refuses reconnects", async () => {
    const m = await connected();
    const machine = new FakeMachine(url, m.credential);
    await machine.opened;
    await held(m.environmentId);
    // another machine's revocation (a replacement sign-in) leaves this connection alone (R16)
    await redis.publish(
      `cap:kernel:${deviceRevokedTopic(m.environmentId)}`,
      JSON.stringify({ machineId: randomUUID() }),
    );
    await sleep(300);
    expect(machine.ws.readyState).toBe(machine.ws.OPEN);
    await machines.revoke(orgId, m.accountId, m.environmentId);
    // the stop frame goes out before the close
    expect(await machine.next((f) => f.type === "req" && f.op === "stop")).toMatchObject({
      args: { reason: "revoked" },
    });
    expect((await machine.closed).code).toBe(4003);
    const again = await refusal(url, {
      Authorization: `Bearer ${m.credential}`,
      "X-Capybara-Device-Protocol": "1",
    });
    expect(again?.status).toBe(401);
  });

  it("a newer connection of the same environment replaces the older one (4002)", async () => {
    const m = await connected();
    const first = new FakeMachine(url, m.credential);
    await first.opened;
    const firstToken = await held(m.environmentId);
    const second = new FakeMachine(url, m.credential, (req) =>
      req.op === "exec" ? { ok: true, result: EXEC_RESULT } : undefined,
    );
    await second.opened;
    expect((await first.closed).code).toBe(4002);
    await waitFor(async () => {
      const t = await redis.get(deviceLeaseKey(m.environmentId));
      return t !== null && t !== firstToken;
    });
    expect(
      await relay.call(m.environmentId, "exec", execArgs, {
        deadlineMs: 6000,
        signal: AbortSignal.timeout(20_000),
      }),
    ).toEqual(EXEC_RESULT);
    second.close();
  });

  it("a result for an unknown request writes no key and publishes nothing", async () => {
    const m = await connected();
    const machine = new FakeMachine(url, m.credential);
    await machine.opened;
    await held(m.environmentId);
    const id = randomUUID();
    const sub = new Redis(rd.url);
    const heard: string[] = [];
    sub.on("message", (_ch, msg: string) => heard.push(msg));
    await sub.subscribe(`cap:kernel:${deviceResTopic(id)}`);
    machine.respond(id, { ok: true, result: EXEC_RESULT });
    await sleep(500);
    expect(await redis.exists(deviceResKey(id))).toBe(0);
    expect(heard).toEqual([]);
    expect(machine.ws.readyState).toBe(machine.ws.OPEN);
    sub.disconnect();
    machine.close();
  });

  it("a result for a request taken for another environment is dropped", async () => {
    const m = await connected();
    const machine = new FakeMachine(url, m.credential);
    await machine.opened;
    await held(m.environmentId);
    const id = randomUUID();
    const other = randomUUID();
    await redis.set(deviceTakenKey(id), other, "PX", 60_000);
    machine.respond(id, { ok: true, result: EXEC_RESULT });
    await sleep(500);
    expect(await redis.exists(deviceResKey(id))).toBe(0);
    expect(await redis.get(deviceTakenKey(id))).toBe(other);
    machine.close();
  });

  it("a result flushed after a reconnect on a new socket is accepted", async () => {
    const m = await connected();
    const first = new FakeMachine(url, m.credential);
    await first.opened;
    await held(m.environmentId);
    const call = relay.call(m.environmentId, "exec", execArgs, {
      deadlineMs: 20_000,
      signal: AbortSignal.timeout(30_000),
    });
    const req = (await first.next((f) => f.type === "req")) as KernelReq;
    expect(await redis.get(deviceTakenKey(req.id))).toBe(m.environmentId);
    first.close();
    await first.closed;
    await waitFor(async () => (await redis.get(deviceLeaseKey(m.environmentId))) === null);
    // the program flushes what finished while it was away right after its hello
    const second = new FakeMachine(url, m.credential);
    await second.opened;
    second.respond(req.id, { ok: true, result: EXEC_RESULT });
    expect(await call).toEqual(EXEC_RESULT);
    second.close();
  });

  it("an upgrade request to another path is answered 404 and its socket closed", async () => {
    for (const path of ["/healthz", "/api/v1/setup"]) {
      const answer = await new Promise<{ data: string; closed: boolean }>((resolve, reject) => {
        const sock = tcpConnect(k.port as number, "127.0.0.1");
        let data = "";
        const timer = setTimeout(() => resolve({ data, closed: false }), 5000);
        sock.on("data", (c) => {
          data += c.toString("utf8");
        });
        sock.on("close", () => {
          clearTimeout(timer);
          resolve({ data, closed: true });
        });
        sock.on("error", reject);
        sock.write(
          `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n` +
            "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
        );
      });
      expect(answer.data.startsWith("HTTP/1.1 404"), `${path}: ${answer.data}`).toBe(true);
      expect(answer.closed, path).toBe(true);
    }
  });

  it("two near-simultaneous newcomers end with exactly one holder", async () => {
    const m = await connected();
    const holder = new FakeMachine(url, m.credential);
    await holder.opened;
    await held(m.environmentId);
    const a = new FakeMachine(url, m.credential);
    const b = new FakeMachine(url, m.credential);
    expect((await holder.closed).code).toBe(4002);
    const loser = await Promise.race([
      a.closed.then((c) => ({ c, other: b })),
      b.closed.then((c) => ({ c, other: a })),
    ]);
    expect([4002, 4409]).toContain(loser.c.code);
    await sleep(1000);
    expect(loser.other.ws.readyState).toBe(loser.other.ws.OPEN);
    expect(await redis.get(deviceLeaseKey(m.environmentId))).not.toBeNull();
    a.close();
    b.close();
  }, 20_000);

  it("a lease held elsewhere that is never handed back closes the claim with 4409", async () => {
    const m = await connected();
    await redis.set(deviceLeaseKey(m.environmentId), "stuck", "PX", 60_000);
    const machine = new FakeMachine(url, m.credential);
    await machine.opened;
    expect((await machine.closed).code).toBe(4409);
    await redis.del(deviceLeaseKey(m.environmentId));
  }, 20_000);

  it("a lost lease closes the socket with 4001", async () => {
    const m = await connected();
    const machine = new FakeMachine(url, m.credential);
    await machine.opened;
    await held(m.environmentId);
    // the key taken by someone else: the next renewal (every TTL/3) fails
    await redis.set(deviceLeaseKey(m.environmentId), "someone-else", "PX", 60_000);
    expect((await machine.closed).code).toBe(4001);
    expect(await redis.get(deviceLeaseKey(m.environmentId))).toBe("someone-else");
    await redis.del(deviceLeaseKey(m.environmentId));
  }, 20_000);

  it("a machine that misses two pongs is terminated", async () => {
    const gw = k.app.get(DeviceGateway);
    gw.pingIntervalMs = 200;
    try {
      const m = await connected();
      const machine = new FakeMachine(url, m.credential, undefined, { autoPong: false });
      await machine.opened;
      // terminated without a close frame
      expect((await machine.closed).code).toBe(1006);
      await waitFor(async () => (await redis.get(deviceLeaseKey(m.environmentId))) === null);
    } finally {
      gw.pingIntervalMs = 20_000;
    }
  });

  it("stopping the kernel closes the socket with 1001 and releases the lease", async () => {
    const m = await connected();
    const machine = new FakeMachine(url, m.credential);
    await machine.opened;
    await held(m.environmentId);
    await k.close();
    expect((await machine.closed).code).toBe(1001);
    expect(await redis.get(deviceLeaseKey(m.environmentId))).toBeNull();
  });
});
