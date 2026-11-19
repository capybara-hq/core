import { randomUUID } from "node:crypto";
import { connect as tcpConnect } from "node:net";
import type { KernelReq } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { DevicesService } from "../../src/devices/devices.service.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import {
  deviceLeaseKey,
  deviceResKey,
  deviceResTopic,
  deviceRevokedTopic,
  deviceTakenKey,
} from "../../src/local-devices/keys.js";
import { LocalDeviceGateway } from "../../src/local-devices/local-device-gateway.js";
import { MachinesService } from "../../src/local-devices/machines.js";
import { NetworkGrants } from "../../src/local-devices/network-grants.js";
import { LocalDeviceRelay } from "../../src/local-devices/relay.js";
import { LegacyRetirementStore } from "../../src/sandbox/legacy-retirement.js";
import { SandboxService } from "../../src/sandbox/sandbox.service.js";
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
import { seedConversation } from "../helpers/tool-fixtures.js";
import {
  DEVICE_PROTOCOL_HEADER_VALUE,
  FakeMachine,
  FakeMachineV3,
  HELLO,
  ownerReportFor,
  refusal,
} from "./fake-machine-v3.js";

/**
 * The gateway holds the WebSocket connections of connected machines (environments spec §13.4):
 * the credential and protocol are checked before the upgrade, the connection claims the
 * device's lease after `hello`, and relayed requests reach the socket and come back.
 */

const MAX_FRAME_BYTES = 64 * 1024;
const EXEC_RESULT = { exitCode: 0, stdout: "hi\n", stderr: "", truncated: false, timedOut: false };
const LIMITS = {
  cpu: 1,
  memoryMb: 512,
  diskMb: 1024,
  network: { kind: "allowlist" as const, hosts: [] },
};
/** A protocol 3 exec request: the command under an admitted scope on `deviceId`. */
const execArgs = (deviceId: string) => ({
  scope: {
    operationId: "op-1",
    admitBeforeMs: Date.now() + 60_000,
    deviceId,
    rootConversationId: "c",
    profileRevision: 1,
    ceilingRevision: "r",
    profile: "approve-for-me",
    actor: { accountId: "a", conversationId: "c" },
    tag: "t1",
    filesystem: { kind: "scoped", readRoots: ["/work"], writeRoots: ["/work"] },
    network: { kind: "none" },
  },
  command: "echo hi",
  timeoutMs: 1000,
  maxOutputBytes: 1000,
  limits: LIMITS,
});

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let k: TestKernel;
let machines: MachinesService;
let devices: DevicesService;
let relay: LocalDeviceRelay;
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
        devices: {
          local: { reconnectGraceSeconds: 5, leaseTtlMs: 6000, maxFrameBytes: MAX_FRAME_BYTES },
        },
      },
    ),
  );
  machines = k.app.get(MachinesService);
  devices = k.app.get(DevicesService);
  relay = k.app.get(LocalDeviceRelay);
  txHost = k.app.get(TransactionHost);
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  orgId = await createOrg(await session(k, "owner"));
  url = `ws://127.0.0.1:${k.port}/device/connect`;
});

afterAll(async () => {
  await k?.close();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

/** A member's local device with a machine: the ids and the credential. */
async function connected() {
  const login = `m-${randomUUID().slice(0, 8)}`;
  const accountId = (await accountsFor(db).createLocal({ login, password: PW, displayName: login }))
    .id;
  await testMembers(db).add(orgId, accountId, "member", ownerId);
  const m = await txHost.run(async () => {
    const { id: deviceId } = await devices.createLocal(orgId, accountId, "Box");
    const issued = await machines.issue({
      orgId,
      deviceId,
      accountId,
      name: "box",
      os: "linux",
      arch: "x64",
      programVersion: "0.1.0",
    });
    return { deviceId, ...issued };
  });
  return { accountId, ...m };
}

/**
 * Sends `GET path` with `Connection: connection` and `Upgrade: protocol` over raw TCP; resolves
 * what came back and whether the server closed the socket (within 3 s).
 */
function rawUpgrade(
  path: string,
  protocol: string,
  connection = "Upgrade",
): Promise<{ data: string; closed: boolean }> {
  return new Promise((resolve, reject) => {
    const sock = tcpConnect(k.port as number, "127.0.0.1");
    let data = "";
    const timer = setTimeout(() => {
      sock.destroy();
      resolve({ data, closed: false });
    }, 3000);
    sock.on("data", (c) => {
      data += c.toString("utf8");
    });
    sock.on("close", () => {
      clearTimeout(timer);
      resolve({ data, closed: true });
    });
    sock.on("error", reject);
    sock.write(
      `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: ${connection}\r\n` +
        `Upgrade: ${protocol}\r\n` +
        "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
    );
  });
}

const held = (deviceId: string) =>
  waitFor(() => redis.get(deviceLeaseKey(deviceId)), 10_000, "lease held");
const codeOf = (body: string) => (JSON.parse(body) as { error: { code: string } }).error.code;

/** Each boot-evidence test starts without a freeze or obligations, with no machine connected. */
async function resetRetirement(): Promise<void> {
  for (const m of bootOpen.splice(0)) {
    m.close();
    await m.closed;
  }
  await sql`DELETE FROM capybara.legacy_launch_freeze`.execute(raw);
  await sql`TRUNCATE capybara.device_retirement_members, capybara.device_retirement_obligations`.execute(
    raw,
  );
}
const bootOpen: FakeMachine[] = [];

/** Open, or quarantined by the gate or the worker's retirement tick meanwhile: never resolved. */
const unresolved = expect.stringMatching(/^(open|quarantined)$/);
const B1 = "0f2a9c1e-7b1d-4b8e-9d5e-000000000001";
const B2 = "0f2a9c1e-7b1d-4b8e-9d5e-000000000002";
const B3 = "0f2a9c1e-7b1d-4b8e-9d5e-000000000003";

/** A member's local device with a machine. */
async function bootDevice() {
  const login = `m-${randomUUID().slice(0, 8)}`;
  const accountId = (await accountsFor(db).createLocal({ login, password: PW, displayName: login }))
    .id;
  await testMembers(db).add(orgId, accountId, "member", ownerId);
  return txHost.run(async () => {
    const { id: deviceId } = await devices.createLocal(orgId, accountId, "Box");
    const issued = await machines.issue({
      orgId,
      deviceId,
      accountId,
      name: "box",
      os: "linux",
      arch: "x64",
      programVersion: "0.1.0",
    });
    return { deviceId, accountId, ...issued };
  });
}

const machineBoot = async (machineId: string) =>
  (
    await sql<{ boot_id: string | null }>`SELECT boot_id FROM capybara.device_machines
      WHERE id = ${machineId}`.execute(raw)
  ).rows[0]?.boot_id ?? null;

/** Connects `credential` over the real gateway with a hello reporting `bootId`; waits for its record. */
async function hello(credential: string, machineId: string, bootId?: string): Promise<void> {
  // only the hello's record writes roots, so a connect-time touch of a new machine never counts
  const seen = async () =>
    (
      await sql<{ at: Date | null }>`SELECT last_seen_at AS at FROM capybara.device_machines
        WHERE id = ${machineId} AND roots IS NOT NULL`.execute(raw)
    ).rows[0]?.at?.getTime() ?? 0;
  const before = await seen();
  const m = new FakeMachine(url, credential, undefined, { hello: false });
  bootOpen.push(m);
  await m.opened;
  m.hello({ ...(bootId !== undefined && { bootId }) });
  // the hello's record moves last_seen_at (in the same transaction as the boot record)
  await waitFor(async () => ((await seen()) > before ? true : null), 10_000, "hello recorded");
}

/** A legacy row of the device's that may still run, recorded as an obligation under the freeze. */
async function obligation(deviceId: string) {
  const c = await seedConversation(raw);
  const id = `bt_${randomUUID()
    .replace(/[^a-z2-7]/g, "")
    .slice(0, 6)
    .padEnd(6, "a")}`;
  await sql`INSERT INTO capybara.background_tasks (id, org_id, conversation_id,
      sandbox_conversation_id, device_id, run_id, call_id, trigger_account_id, description, command,
      sid, output_path, status, deadline_at, sandbox_created_at)
    VALUES (${id}, ${orgId}, ${c.conversationId}, ${c.conversationId}, ${deviceId}, 'run-1',
      ${`call-${id}`}, ${c.accountId}, 'd', 'sleep 600', '4242', ${`.capybara/tasks/${id}.out`},
      'running', now() + interval '1 hour', now() - interval '1 hour')`.execute(raw);
  await k.app.get(LegacyRetirementStore).freeze("test");
  await k.app.get(LegacyRetirementStore).scanUntilStable();
  return (
    await sql<{
      state: string;
      resolution: string | null;
      boot_id: string | null;
      boot_machine_id: string | null;
    }>`SELECT state, resolution, boot_id, boot_machine_id
      FROM capybara.device_retirement_obligations WHERE device_id = ${deviceId}`.execute(raw)
  ).rows;
}
const states = async (deviceId: string) =>
  (
    await sql<{ state: string; resolution: string | null }>`SELECT state, resolution
      FROM capybara.device_retirement_obligations WHERE device_id = ${deviceId}`.execute(raw)
  ).rows;
const use = (deviceId: string, accountId: string) =>
  k.app.get(SandboxService).withSandbox(
    {
      orgId,
      deviceId,
      holderConversationId: "c-boot",
      actor: { accountId, conversationId: "c-boot" },
    },
    async () => "used",
    AbortSignal.timeout(20_000),
  );

/**
 * Boot-ID evidence for local legacy retirement (permission runtime cutover 8.5, user decision):
 * a local obligation records the boot identity its machine last reported, and resolves only when
 * an authenticated hello of that same machine reports a later boot (the computer restarted, so no
 * process of the earlier boot can exist). The same boot, an unknown recorded boot, a stale or
 * replayed boot, another machine credential and a revoked or unauthenticated connection never
 * resolve it.
 */
describe("boot identity evidence for local legacy retirement", () => {
  it("a later boot of the same machine settles its local obligations; the same boot does not", async () => {
    await resetRetirement();
    const d = await bootDevice();
    await hello(d.credential, d.machineId, B1);
    expect(await obligation(d.deviceId)).toEqual([
      { state: unresolved, resolution: null, boot_id: B1, boot_machine_id: d.machineId },
    ]);
    // the person is asked to restart the computer
    await expect(use(d.deviceId, d.accountId)).rejects.toMatchObject({
      code: "device.restart_required",
    });
    expect(await k.app.get(SandboxService).retireLegacy(d.deviceId)).toBe("unavailable");

    // a reconnect from the same boot is no evidence
    await hello(d.credential, d.machineId, B1);
    expect(await states(d.deviceId)).toEqual([{ state: "quarantined", resolution: null }]);

    // the computer restarted: its next authenticated hello reports a later boot
    await hello(d.credential, d.machineId, B2);
    expect(await states(d.deviceId)).toEqual([{ state: "resolved", resolution: "host-rebooted" }]);
    expect(await k.app.get(SandboxService).retireLegacy(d.deviceId)).toBe("clear");
    expect(await k.app.get(LegacyRetirementStore).hasUnresolved(d.deviceId)).toBe(false);

    // a stale or replayed earlier boot changes nothing
    await hello(d.credential, d.machineId, B1);
    expect(await machineBoot(d.machineId)).toBe(B2);

    // a hello without a boot identity (a downgraded program) keeps no stale boot as evidence
    await hello(d.credential, d.machineId);
    expect(await machineBoot(d.machineId)).toBeNull();
  });

  it("an obligation recorded without a boot identity never resolves by itself", async () => {
    await resetRetirement();
    const d = await bootDevice();
    await hello(d.credential, d.machineId);
    expect(await obligation(d.deviceId)).toEqual([
      { state: unresolved, resolution: null, boot_id: null, boot_machine_id: d.machineId },
    ]);
    await hello(d.credential, d.machineId, B1);
    await hello(d.credential, d.machineId, B2);
    expect(await states(d.deviceId)).toEqual([{ state: unresolved, resolution: null }]);
    // nothing a restart could prove: the owner replaces the device, no restart request
    await expect(use(d.deviceId, d.accountId)).rejects.toMatchObject({
      code: "device.replace_required",
    });
    expect(await states(d.deviceId)).toEqual([{ state: "quarantined", resolution: null }]);
  });

  /** A re-login on the device: a new machine credential, the previous one revoked. */
  const relogin = (d: { deviceId: string; accountId: string }) =>
    txHost.run(() =>
      machines.issue({
        orgId,
        deviceId: d.deviceId,
        accountId: d.accountId,
        name: "box",
        os: "linux",
        arch: "x64",
        programVersion: "0.1.0",
      }),
    );

  it("an unauthenticated connection, a revoked machine's late hello and a replayed boot are no evidence", async () => {
    await resetRetirement();
    const d = await bootDevice();
    await hello(d.credential, d.machineId, B1);
    await obligation(d.deviceId);

    // no credential the deployment issued: refused before any hello
    expect(
      await refusal(url, {
        Authorization: "Bearer cap_dev_bogus",
        "X-Capybara-Device-Protocol": DEVICE_PROTOCOL_HEADER_VALUE,
      }),
    ).toMatchObject({ status: 401 });

    // a re-login revokes the first machine; its old credential cannot connect any more and a late
    // hello of its older connection is not recorded
    const second = await relogin(d);
    expect(
      await refusal(url, {
        Authorization: `Bearer ${d.credential}`,
        "X-Capybara-Device-Protocol": DEVICE_PROTOCOL_HEADER_VALUE,
      }),
    ).toMatchObject({ status: 401 });
    await machines.recordHello(d.machineId, { ...HELLO, bootId: B2 });
    expect(await machineBoot(d.machineId)).toBe(B1);
    expect(await states(d.deviceId)).toEqual([{ state: unresolved, resolution: null }]);

    // a boot the device had reported before the obligation's, replayed through the new credential
    await sql`INSERT INTO capybara.device_machine_boots (machine_id, boot_id, seq)
      VALUES (${d.machineId}, ${B3}, 0)`.execute(raw);
    await hello(second.credential, second.machineId, B3);
    expect(await states(d.deviceId)).toEqual([{ state: unresolved, resolution: null }]);
    expect(await k.app.get(LegacyRetirementStore).hasUnresolved(d.deviceId)).toBe(true);
  });

  it("a re-login on the same computer is no restart; a re-login after a restart is", async () => {
    await resetRetirement();
    const d = await bootDevice();
    await hello(d.credential, d.machineId, B1);
    await obligation(d.deviceId);

    // a new credential reporting the same boot: the same computer, not restarted
    const second = await relogin(d);
    await hello(second.credential, second.machineId, B1);
    expect(await states(d.deviceId)).toEqual([{ state: unresolved, resolution: null }]);
    await expect(use(d.deviceId, d.accountId)).rejects.toMatchObject({
      code: "device.restart_required",
    });

    // the evidence is the OS instance, not the credential: another re-login after a restart
    const third = await relogin(d);
    await hello(third.credential, third.machineId, B2);
    expect(await states(d.deviceId)).toEqual([{ state: "resolved", resolution: "host-rebooted" }]);
    expect(await k.app.get(SandboxService).retireLegacy(d.deviceId)).toBe("clear");
  });
});

describe("the hello's policy summary and the reported mode", () => {
  const SUMMARY = { allowedDomains: [] };

  /** Connects a machine of a new device that says `hello`; resolves once it is recorded. */
  async function helloWith(hello: Record<string, unknown>) {
    const m = await connected();
    const machine = new FakeMachine(url, m.credential, undefined, { hello: false });
    await machine.opened;
    machine.hello({ ...hello });
    await held(m.deviceId);
    await waitFor(
      async () =>
        (
          await db
            .selectFrom("device_machines")
            .select("program_version")
            .where("id", "=", m.machineId)
            .executeTakeFirst()
        )?.program_version === "0.9.0",
      10_000,
      "hello recorded",
    );
    return { m, machine };
  }

  it("an unreadable summary is stored as none", async () => {
    const { m, machine } = await helloWith({
      programVersion: "0.9.0",
      features: ["networkReport", "policyOp"],
      policy: { ...SUMMARY, allowedDomains: "not-a-list" },
    });
    // fail closed: a program that sent no readable summary (nor a report of its own) is sandbox
    expect(await k.app.get(NetworkGrants).reportedMode(m.deviceId)).toBe("sandbox");
    expect((await machines.activeFor(m.deviceId))?.localPolicy).toBeNull();
    machine.close();
  });

  it("a policy frame after the hello replaces the stored summary and owner report, in order", async () => {
    const { m, machine } = await helloWith({
      programVersion: "0.9.0",
      features: ["networkReport", "policyOp"],
      policy: SUMMARY,
      ownerCeiling: ownerReportFor(SUMMARY, { outsideSandbox: true }),
    });
    expect(await k.app.get(NetworkGrants).reportedMode(m.deviceId)).toBe("auto");
    // the owner turns Full off on the machine (`capybara-device ceiling set`)
    // (protocol 4: the summary carries the allowlist only; Full is the owner report's)
    const narrowed = { allowedDomains: [] };
    machine.send({
      type: "policy",
      policy: narrowed,
      ownerCeiling: ownerReportFor(narrowed, { outsideSandbox: false }),
    });
    await waitFor(
      async () => (await k.app.get(NetworkGrants).reportedMode(m.deviceId)) === "sandbox",
      10_000,
      "policy recorded",
    );
    expect((await machines.activeFor(m.deviceId))?.localPolicy).toEqual(narrowed);
    // the frame's change is listed as made on the machine, once, as the owner report's
    expect(
      await db
        .selectFrom("audit_events")
        .select(["action", "detail"])
        .where("target", "=", m.deviceId)
        .where("action", "in", ["device.policy_changed", "device.owner_ceiling_changed"])
        .orderBy("at")
        .orderBy("id")
        .execute(),
    ).toEqual([
      {
        action: "device.owner_ceiling_changed",
        detail: expect.objectContaining({
          from: expect.objectContaining({ fullAccess: true }),
          to: expect.objectContaining({ fullAccess: false }),
          via: "device",
        }),
      },
    ]);
    // the connection stays up
    expect(machine.ws.readyState).toBe(machine.ws.OPEN);
    machine.close();
  });

  it("the reported mode follows the owner report's Full ceiling", async () => {
    const full = await helloWith({
      programVersion: "0.9.0",
      features: ["networkReport", "policyOp"],
      policy: SUMMARY,
      ownerCeiling: ownerReportFor(SUMMARY, { outsideSandbox: true }),
    });
    expect(await k.app.get(NetworkGrants).reportedMode(full.m.deviceId)).toBe("auto");
    full.machine.close();
    // fail closed: a restricted owner ceiling is sandbox, whatever its summary says
    const restricted = await helloWith({
      programVersion: "0.9.0",
      features: ["networkReport", "policyOp"],
      policy: SUMMARY,
      ownerCeiling: ownerReportFor(SUMMARY, { outsideSandbox: false }),
    });
    expect(await k.app.get(NetworkGrants).reportedMode(restricted.m.deviceId)).toBe("sandbox");
    restricted.machine.close();
  });
});

describe("GET /device/connect", () => {
  it("unknown credential is 401 before upgrade", async () => {
    const r = await refusal(url, {
      Authorization: `Bearer cap_dev_${"A".repeat(43)}`,
      "X-Capybara-Device-Protocol": DEVICE_PROTOCOL_HEADER_VALUE,
    });
    expect(r?.status).toBe(401);
    expect(codeOf(r?.body ?? "")).toBe("device.credential_invalid");
    const none = await refusal(url, { "X-Capybara-Device-Protocol": DEVICE_PROTOCOL_HEADER_VALUE });
    expect(none?.status).toBe(401);
  });

  it("protocol 1 is 426 program_outdated", async () => {
    const m = await connected();
    for (const protocol of ["1", ""]) {
      const r = await refusal(url, {
        Authorization: `Bearer ${m.credential}`,
        ...(protocol !== "" && { "X-Capybara-Device-Protocol": protocol }),
      });
      expect(r?.status).toBe(426);
      expect(codeOf(r?.body ?? "")).toBe("device.program_outdated");
    }
  });

  it("hello then a relayed exec round-trip", async () => {
    const m = await connected();
    const machine = new FakeMachine(url, m.credential, (req) =>
      req.op === "exec" ? { ok: true, result: EXEC_RESULT } : undefined,
    );
    await machine.opened;
    expect(await held(m.deviceId)).toBeTruthy();
    const r = await relay.callV3(m.deviceId, "exec", execArgs(m.deviceId), {
      deadlineMs: 6000,
      signal: AbortSignal.timeout(20_000),
    });
    expect(r).toEqual(EXEC_RESULT);
    expect(machine.frames.find((f) => f.type === "req" && f.op === "exec")).toMatchObject({
      type: "req",
      args: { command: "echo hi", scope: { deviceId: m.deviceId, tag: "t1" } },
    });
    // the hello was recorded: the claim (and so `held`) comes before the record, so wait for
    // what only the record writes (roots) instead of reading at once
    const row = await waitFor(
      async () =>
        db
          .selectFrom("device_machines")
          .select(["mode", "last_seen_at"])
          .where("id", "=", m.machineId)
          .where("roots", "is not", null)
          .executeTakeFirst(),
      10_000,
      "hello recorded",
    );
    expect(row.mode).toBe("os");
    expect(row.last_seen_at).not.toBeNull();
    machine.close();
    await machine.closed;
    // the lease is handed back when the machine leaves
    await waitFor(
      async () => (await redis.get(deviceLeaseKey(m.deviceId))) === null,
      10_000,
      "lease released",
    );
  });

  it("a result is stored with the grace + deadline TTL and a cancel is forwarded", async () => {
    const m = await connected();
    const machine = new FakeMachine(url, m.credential);
    await machine.opened;
    await held(m.deviceId);
    const ac = new AbortController();
    const call = relay
      .callV3(m.deviceId, "exec", execArgs(m.deviceId), { deadlineMs: 8000, signal: ac.signal })
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
    await held(m.deviceId);
    big.respond(randomUUID(), { ok: true, result: "x".repeat(MAX_FRAME_BYTES + 1) });
    expect((await big.closed).code).toBe(1009);
  });

  it("revoking closes the socket with 4003 and refuses reconnects", async () => {
    const m = await connected();
    const machine = new FakeMachine(url, m.credential);
    await machine.opened;
    await held(m.deviceId);
    // another machine's revocation (a replacement sign-in) leaves this connection alone (R16)
    await redis.publish(
      `cap:kernel:${deviceRevokedTopic(m.deviceId)}`,
      JSON.stringify({ machineId: randomUUID() }),
    );
    await sleep(300);
    expect(machine.ws.readyState).toBe(machine.ws.OPEN);
    await machines.revoke(orgId, m.accountId, m.deviceId);
    // the stop frame goes out before the close
    expect(await machine.next((f) => f.type === "req" && f.op === "stop")).toMatchObject({
      args: { reason: "revoked" },
    });
    expect((await machine.closed).code).toBe(4003);
    const again = await refusal(url, {
      Authorization: `Bearer ${m.credential}`,
      "X-Capybara-Device-Protocol": DEVICE_PROTOCOL_HEADER_VALUE,
    });
    expect(again?.status).toBe(401);
  });

  it("a newer connection of the same device replaces the older one (4002)", async () => {
    const m = await connected();
    const first = new FakeMachine(url, m.credential);
    await first.opened;
    const firstToken = await held(m.deviceId);
    const second = new FakeMachine(url, m.credential, (req) =>
      req.op === "exec" ? { ok: true, result: EXEC_RESULT } : undefined,
    );
    await second.opened;
    expect((await first.closed).code).toBe(4002);
    await waitFor(async () => {
      const t = await redis.get(deviceLeaseKey(m.deviceId));
      return t !== null && t !== firstToken;
    });
    expect(
      await relay.callV3(m.deviceId, "exec", execArgs(m.deviceId), {
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
    await held(m.deviceId);
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

  it("a result for a request taken for another device is dropped", async () => {
    const m = await connected();
    const machine = new FakeMachine(url, m.credential);
    await machine.opened;
    await held(m.deviceId);
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
    await held(m.deviceId);
    const call = relay.callV3(m.deviceId, "exec", execArgs(m.deviceId), {
      deadlineMs: 20_000,
      signal: AbortSignal.timeout(30_000),
    });
    const req = (await first.next((f) => f.type === "req")) as KernelReq;
    expect(await redis.get(deviceTakenKey(req.id))).toBe(m.deviceId);
    first.close();
    await first.closed;
    await waitFor(async () => (await redis.get(deviceLeaseKey(m.deviceId))) === null);
    // the program flushes what finished while it was away once the kernel is ready (protocol 3:
    // a result before `ready` is a protocol error)
    const second = new FakeMachineV3(url, m.credential);
    await second.ready;
    second.respond(req.id, { ok: true, result: EXEC_RESULT });
    expect(await call).toEqual(EXEC_RESULT);
    second.close();
  });

  it("a non-WebSocket Upgrade header (h2c) on an ordinary API call is answered by its route", async () => {
    // with Connection: upgrade (Node's upgrade path): answered, then the socket is closed
    const declined = await rawUpgrade("/healthz", "h2c");
    expect(declined.data.startsWith("HTTP/1.1 200"), declined.data).toBe(true);
    expect(declined.closed).toBe(true);
    // without it: an ordinary keep-alive request
    const plain = await rawUpgrade("/healthz", "h2c", "keep-alive");
    expect(plain.data.startsWith("HTTP/1.1 200"), plain.data).toBe(true);
  });

  it("an upgrade request to another path is answered 404 and its socket closed", async () => {
    for (const path of ["/healthz", "/api/v1/setup"]) {
      const answer = await rawUpgrade(path, "WebSocket");
      expect(answer.data.startsWith("HTTP/1.1 404"), `${path}: ${answer.data}`).toBe(true);
      expect(answer.closed, path).toBe(true);
    }
  });

  it("two near-simultaneous newcomers end with exactly one holder", async () => {
    const m = await connected();
    const holder = new FakeMachine(url, m.credential);
    await holder.opened;
    await held(m.deviceId);
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
    expect(await redis.get(deviceLeaseKey(m.deviceId))).not.toBeNull();
    a.close();
    b.close();
  });

  it("a lease held elsewhere that is never handed back closes the claim with 4409", async () => {
    const m = await connected();
    await redis.set(deviceLeaseKey(m.deviceId), "stuck", "PX", 60_000);
    const machine = new FakeMachine(url, m.credential);
    await machine.opened;
    expect((await machine.closed).code).toBe(4409);
    await redis.del(deviceLeaseKey(m.deviceId));
  });

  it("a lost lease closes the socket with 4001", async () => {
    const m = await connected();
    const machine = new FakeMachine(url, m.credential);
    await machine.opened;
    await held(m.deviceId);
    // the key taken by someone else: the next renewal (every TTL/3) fails
    await redis.set(deviceLeaseKey(m.deviceId), "someone-else", "PX", 60_000);
    expect((await machine.closed).code).toBe(4001);
    expect(await redis.get(deviceLeaseKey(m.deviceId))).toBe("someone-else");
    await redis.del(deviceLeaseKey(m.deviceId));
  });

  it("a machine that misses two pongs is terminated", async () => {
    const gw = k.app.get(LocalDeviceGateway);
    gw.pingIntervalMs = 200;
    try {
      const m = await connected();
      const machine = new FakeMachine(url, m.credential, undefined, { autoPong: false });
      await machine.opened;
      // terminated without a close frame
      expect((await machine.closed).code).toBe(1006);
      await waitFor(async () => (await redis.get(deviceLeaseKey(m.deviceId))) === null);
    } finally {
      gw.pingIntervalMs = 20_000;
    }
  });

  it("stopping the kernel closes the socket with 1001 and releases the lease", async () => {
    const m = await connected();
    const machine = new FakeMachine(url, m.credential);
    await machine.opened;
    await held(m.deviceId);
    await k.close();
    expect((await machine.closed).code).toBe(1001);
    expect(await redis.get(deviceLeaseKey(m.deviceId))).toBeNull();
  });
});
