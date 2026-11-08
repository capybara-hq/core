import { randomUUID } from "node:crypto";
import type { KernelReq } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { deviceLeaseKey, deviceResKey, deviceRevokedTopic } from "../../src/devices/keys.js";
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
