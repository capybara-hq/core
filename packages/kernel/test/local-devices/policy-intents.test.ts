import { randomUUID } from "node:crypto";
import type {
  DeviceHello,
  DeviceLocalPolicySummary,
  DevicePolicyOpOutcome,
  KernelReq,
} from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { DevicesService } from "../../src/devices/devices.service.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import { OUTBOX_DISPATCH_FAILS } from "../../src/infra/outbox/outbox.dispatcher.js";
import {
  DEVICE_POLICY_AFTER_CALL,
  DevicePolicyService,
  POLICY_DEADLINE_MS,
} from "../../src/local-devices/device-policy.service.js";
import { deviceLeaseKey } from "../../src/local-devices/keys.js";
import { MachinesService } from "../../src/local-devices/machines.js";
import type { DeviceOpResolveData } from "../../src/local-devices/policy-op-jobs.js";
import { LIST_TTL_MARGIN_MS } from "../../src/local-devices/relay.js";
import { MAINTENANCE_QUEUE_NAME } from "../../src/runtime/maintenance-queue.js";
import { DeviceOpResolver } from "../../src/tools/device-op-resolver.js";
import { legacyDbFor } from "../helpers/conversations.js";
import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import {
  createOrg,
  PW,
  runConfig,
  session,
  startKernel,
  type TestKernel,
  waitFor,
} from "../helpers/runs.js";
import { FakeMachine, HELLO } from "./fake-machine.js";
import type { Answer } from "./test-holder.js";

/**
 * Device policy changes record their intent before the call (transactional outbox spec §7, Part 6
 * re-plan Task 19a): the intent transaction (entry on the machine row, `device.policy_requested`,
 * the `device-op-resolve` job owed for when the op can no longer reach the machine), the call with
 * the op id, the resolve transaction; the resolver job after a crash (it only asks the machine
 * with `policyStatus`, never re-sends the change) and the hello backfill (`recentOps`). Every add
 * to the maintenance queue fails here (`OUTBOX_DISPATCH_FAILS`): the jobs are run by calling the
 * resolver with the owed row's data, no sleeps.
 */

const POLICY: DeviceLocalPolicySummary = {
  effectiveTier: "strict",
  isolation: "sandbox",
  localhost: "off",
  unixSockets: "off",
  allowedDomains: ["pypi.org"],
  remoteGrants: "owner",
};
const GRACE_S = 2;
/** How long after the intent the op can no longer reach the machine. */
const T = POLICY_DEADLINE_MS + GRACE_S * 1000 + LIST_TTL_MARGIN_MS + 5000;
const FEATURES: Partial<DeviceHello> = {
  features: ["networkReport", "policyOp", "policyOpId"],
  policy: POLICY,
};

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let k: TestKernel;
let machines: MachinesService;
let devices: DevicesService;
let policies: DevicePolicyService;
let resolver: DeviceOpResolver;
let txHost: TransactionHost;
let ownerId: string;
let orgId: string;
let url: string;
/** The op ids whose call "crashes" right after the device answered (once each). */
const crashAfter = new Set<string>();
let crashNext = false;
const open: FakeMachine[] = [];

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
        devices: { local: { reconnectGraceSeconds: GRACE_S, leaseTtlMs: 6000 } },
      },
    ),
    {
      overrides: [
        {
          provide: OUTBOX_DISPATCH_FAILS,
          useValue: (queue: string) => queue === MAINTENANCE_QUEUE_NAME,
        },
        {
          provide: DEVICE_POLICY_AFTER_CALL,
          useValue: (opId: string) => {
            if (!crashNext) return;
            crashNext = false;
            crashAfter.add(opId);
            throw new Error("crashed after the call");
          },
        },
      ],
    },
  );
  machines = k.app.get(MachinesService);
  devices = k.app.get(DevicesService);
  policies = k.app.get(DevicePolicyService);
  resolver = k.app.get(DeviceOpResolver);
  txHost = k.app.get(TransactionHost);
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  orgId = await createOrg(await session(k, "owner"));
  url = `ws://127.0.0.1:${k.port}/device/connect`;
}, 180_000);

afterEach(() => {
  crashNext = false;
  for (const m of open.splice(0)) m.close();
});

afterAll(async () => {
  await k?.close();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

async function device() {
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
    return { accountId, deviceId, ...issued };
  });
}

type Dev = Awaited<ReturnType<typeof device>>;

/** A machine stand-in that applies `policy` ops, logs their outcomes and answers `policyStatus`. */
class Sim {
  policy: DeviceLocalPolicySummary = POLICY;
  readonly log = new Map<string, DevicePolicyOpOutcome>();
  /** When set, `policy` ops are left unanswered (the test answers or drops the connection). */
  hold = false;
  refuse: string | undefined;
  /**
   * After applying: `bad-result` answers ok with a result the kernel cannot read; `error` answers
   * the machine's own error; `stopped` logs only `started` and answers nothing (it stopped between
   * the write and its log).
   */
  after: "bad-result" | "error" | "stopped" | undefined;

  answer = (req: KernelReq): Answer => {
    if (req.op === "policyStatus") {
      const { opId } = req.args as { opId: string };
      return {
        ok: true,
        result: {
          outcome: this.log.get(opId) ?? "unknown",
          policy: this.policy,
          ...(this.log.get(opId) === "refused" && { message: this.refuse }),
        },
      };
    }
    if (req.op !== "policy") return { ok: true, result: null };
    if (this.hold) return undefined;
    return this.apply(req);
  };

  apply(req: KernelReq): Answer {
    const a = req.args as { opId: string; add?: string[]; remove?: string[] };
    if (this.refuse !== undefined) {
      this.log.set(a.opId, "refused");
      return { ok: false, error: { kind: "policy", message: this.refuse } };
    }
    const domains = new Set(this.policy.allowedDomains);
    for (const h of a.add ?? []) domains.add(h);
    for (const h of a.remove ?? []) domains.delete(h);
    this.policy = { ...this.policy, allowedDomains: [...domains] };
    if (this.after === "stopped") {
      this.log.set(a.opId, "started");
      return undefined;
    }
    this.log.set(a.opId, "applied");
    if (this.after === "bad-result") return { ok: true, result: { policy: "garbled" } };
    if (this.after === "error") return { ok: false, error: { kind: "error", message: "EIO" } };
    return { ok: true, result: { policy: this.policy } };
  }

  recentOps() {
    return [...this.log].map(([opId, outcome]) => ({ opId, outcome }));
  }
}

async function connect(d: Dev, sim: Sim, hello: Partial<DeviceHello> = {}) {
  const machine = new FakeMachine(url, d.credential, sim.answer, { hello: false });
  open.push(machine);
  await machine.opened;
  machine.send({ ...HELLO, ...FEATURES, policy: sim.policy, ...hello });
  await waitFor(
    async () => (await redis.get(deviceLeaseKey(d.deviceId))) !== null,
    10_000,
    "lease held",
  );
  await waitFor(
    async () =>
      (
        await db
          .selectFrom("device_machines")
          .select("roots")
          .where("id", "=", d.machineId)
          .executeTakeFirst()
      )?.roots != null,
    10_000,
    "hello recorded",
  );
  return machine;
}

/** Drops the machine's connection and waits until no replica holds it. */
async function disconnect(d: Dev, machine: FakeMachine) {
  machine.close();
  await waitFor(
    async () => (await redis.get(deviceLeaseKey(d.deviceId))) === null,
    15_000,
    "lease released",
  );
  // the next connection's hello is recorded anew
  await db
    .updateTable("device_machines")
    .set({ roots: null })
    .where("id", "=", d.machineId)
    .execute();
}

const source = (accountId: string) => ({
  approvalId: "ap-1",
  accountId,
  accountName: "Me",
  via: "web" as const,
});

const apply = (d: Dev, add = ["files.slack.com"]) =>
  policies.apply({
    orgId,
    deviceId: d.deviceId,
    change: { add },
    source: source(d.accountId),
  });

const auditsOf = (deviceId: string) =>
  db
    .selectFrom("audit_events")
    .select(["action", "actor_account_id", "detail"])
    .where("target", "=", deviceId)
    .where("action", "like", "device.policy_%")
    .orderBy("id")
    .execute();

async function entries(machineId: string) {
  const r = await db
    .selectFrom("device_machines")
    .select("pending_policy_ops")
    .where("id", "=", machineId)
    .executeTakeFirstOrThrow();
  return r.pending_policy_ops as Record<string, unknown>[];
}

const owed = (jobId: string) =>
  db
    .selectFrom("outbox")
    .select(["job_name", "job_id", "data", "run_at", "queue"])
    .where("job_id", "=", jobId)
    .executeTakeFirst();

/** The owed job's data (what the maintenance worker would hand the resolver). */
const jobData = (job: { data: unknown } | undefined) => {
  if (job === undefined) throw new Error("no job owed");
  return job.data as DeviceOpResolveData;
};

const policyReqs = (m: FakeMachine) =>
  m.frames.filter((f): f is KernelReq => f.type === "req" && f.op === "policy");
const statusReqs = (m: FakeMachine) =>
  m.frames.filter((f): f is KernelReq => f.type === "req" && f.op === "policyStatus");

/** Runs the op's call to a crash right after the device answered; returns the op id. */
async function crashedApply(d: Dev): Promise<string> {
  crashNext = true;
  await expect(apply(d)).rejects.toThrow(/crashed after the call/);
  const [opId] = [...crashAfter].slice(-1);
  if (opId === undefined) throw new Error("no crash");
  return opId;
}

/** Moves the op's window into the past (as if `T` had elapsed). */
async function windowPassed(machineId: string, opId: string) {
  await patchEntry(machineId, opId, { resolveAt: Date.now() - 1 });
}

/** Merges `patch` into the op's entry. */
async function patchEntry(machineId: string, opId: string, patch: Record<string, unknown>) {
  await sql`UPDATE capybara.device_machines SET pending_policy_ops = (
      SELECT jsonb_agg(CASE WHEN e->>'id' = ${opId}
        THEN e || ${JSON.stringify(patch)}::jsonb ELSE e END)
      FROM jsonb_array_elements(pending_policy_ops) e)
    WHERE id = ${machineId}`.execute(raw);
}

describe("device policy intents", () => {
  it("the request is audited and the resolve job owed before the device sees the op", async () => {
    const d = await device();
    const sim = new Sim();
    sim.hold = true;
    const machine = await connect(d, sim);
    const before = Date.now();
    const out = apply(d);
    const req = (await machine.next((f) => f.type === "req" && f.op === "policy")) as KernelReq;
    const opId = (req.args as { opId: string }).opId;
    // in flight: the intent is there
    expect(await auditsOf(d.deviceId)).toEqual([
      {
        action: "device.policy_requested",
        actor_account_id: d.accountId,
        detail: {
          opId,
          add: ["files.slack.com"],
          remove: [],
          by: d.accountId,
          via: "web",
          approvalId: "ap-1",
        },
      },
    ]);
    const [entry] = await entries(d.machineId);
    expect(entry).toMatchObject({ id: opId, status: "sent", add: ["files.slack.com"] });
    const job = await owed(`device-op-resolve-${opId}`);
    expect(job).toMatchObject({
      job_name: "device-op-resolve",
      queue: MAINTENANCE_QUEUE_NAME,
      data: { machineId: d.machineId, opId },
    });
    const runAt = job?.run_at?.getTime() ?? 0;
    expect(runAt).toBe(entry?.resolveAt);
    expect(runAt).toBeGreaterThanOrEqual(before + T);
    expect(runAt).toBeLessThanOrEqual(Date.now() + T);
    machine.respond(req.id, sim.apply(req) as NonNullable<Answer>);
    expect(await out).toMatchObject({ applied: true });
    expect(await entries(d.machineId)).toEqual([]);
    expect((await auditsOf(d.deviceId)).map((a) => a.action)).toEqual([
      "device.policy_requested",
      "device.policy_changed",
    ]);
    // the resolve job of a settled op does nothing
    await resolver.resolve({ machineId: d.machineId, opId });
    expect(statusReqs(machine)).toEqual([]);
    expect((await auditsOf(d.deviceId)).length).toBe(2);
  });

  it("a crash after the call is resolved by the job: the device reports applied", async () => {
    const d = await device();
    const sim = new Sim();
    const machine = await connect(d, sim);
    const opId = await crashedApply(d);
    // the device applied it; the kernel recorded only the intent
    expect(await entries(d.machineId)).toEqual([
      expect.objectContaining({ id: opId, status: "sent" }),
    ]);
    expect((await auditsOf(d.deviceId)).map((a) => a.action)).toEqual(["device.policy_requested"]);
    const job = await owed(`device-op-resolve-${opId}`);
    await resolver.resolve(jobData(job));
    const want = { ...POLICY, allowedDomains: ["pypi.org", "files.slack.com"] };
    expect((await policies.summary(d.deviceId))?.policy).toEqual(want);
    expect(await entries(d.machineId)).toEqual([]);
    const audits = await auditsOf(d.deviceId);
    expect(audits.map((a) => a.action)).toEqual([
      "device.policy_requested",
      "device.policy_changed",
    ]);
    expect(audits[1]?.detail).toEqual({
      opId,
      add: ["files.slack.com"],
      remove: [],
      by: d.accountId,
      via: "web",
      approvalId: "ap-1",
    });
    // the resolver never re-sends the change: one `policy`, one `policyStatus`
    expect(policyReqs(machine)).toHaveLength(1);
    expect(statusReqs(machine).map((f) => f.args)).toEqual([{ opId }]);
    // a second delivery of the job does nothing
    await resolver.resolve(jobData(job));
    expect(statusReqs(machine)).toHaveLength(1);
    expect((await auditsOf(d.deviceId)).length).toBe(2);
  });

  it("a crash after a refusal is resolved failed by the job", async () => {
    const d = await device();
    const sim = new Sim();
    sim.refuse = "remote grants are off";
    await connect(d, sim);
    crashNext = true;
    // the seam runs after every answer, a refusal too
    await expect(apply(d)).rejects.toThrow(/crashed/);
    const opId = [...crashAfter].slice(-1)[0] as string;
    await resolver.resolve({ machineId: d.machineId, opId });
    expect(await entries(d.machineId)).toEqual([]);
    const audits = await auditsOf(d.deviceId);
    expect(audits.map((a) => a.action)).toEqual([
      "device.policy_requested",
      "device.policy_failed",
    ]);
    expect(audits[1]?.detail).toMatchObject({ opId, reason: "refused" });
    expect((await policies.summary(d.deviceId))?.policy).toEqual(POLICY);
  });

  it("the resolver on a disconnected machine records unknown and keeps the entry; hello reporting it applied finalizes it, late", async () => {
    const d = await device();
    const sim = new Sim();
    const machine = await connect(d, sim);
    const opId = await crashedApply(d);
    await disconnect(d, machine);
    await resolver.resolve({ machineId: d.machineId, opId });
    expect(statusReqs(machine)).toEqual([]);
    const [entry] = await entries(d.machineId);
    expect(entry).toMatchObject({ id: opId, status: "unknown" });
    expect(entry?.until).toBe((entry?.sentAt as number) + 24 * 3_600_000);
    expect((await auditsOf(d.deviceId)).map((a) => a.action)).toEqual([
      "device.policy_requested",
      "device.policy_unknown",
    ]);
    // a second run while still offline audits nothing more
    await resolver.resolve({ machineId: d.machineId, opId });
    expect((await auditsOf(d.deviceId)).length).toBe(2);

    // the machine comes back: its hello reports the op applied and the policy it wrote
    const again = await connect(d, sim, { recentOps: sim.recentOps() });
    expect((await entries(d.machineId))[0]).toMatchObject({
      id: opId,
      reported: { outcome: "applied" },
    });
    const job = await owed(`device-op-reported-${opId}`);
    expect(job).toMatchObject({ job_name: "device-op-resolve", run_at: null });
    // the self-reported change is the op's: not audited as the owner's
    expect((await auditsOf(d.deviceId)).length).toBe(2);
    await resolver.resolve(jobData(job));
    expect(statusReqs(again)).toEqual([]);
    expect(await entries(d.machineId)).toEqual([]);
    const audits = await auditsOf(d.deviceId);
    expect(audits.map((a) => a.action)).toEqual([
      "device.policy_requested",
      "device.policy_unknown",
      "device.policy_changed",
    ]);
    expect(audits[2]?.detail).toMatchObject({ opId, add: ["files.slack.com"], late: true });
    expect((await policies.summary(d.deviceId))?.policy?.allowedDomains).toEqual([
      "pypi.org",
      "files.slack.com",
    ]);
    // the device page lists the change once
    const recent = (await devices.get(orgId, d.accountId, d.deviceId)).sandbox.recent;
    expect(recent).toEqual([
      expect.objectContaining({ kind: "policy", add: ["files.slack.com"], via: "web" }),
    ]);
  });

  it("hello not listing an op past its window marks it failed; within the window it is left to the resolver", async () => {
    const d = await device();
    const sim = new Sim();
    // the device disconnects mid-call: the op never reaches its log, no answer comes
    sim.hold = true;
    const machine = await connect(d, sim);
    void machine.next((f) => f.type === "req" && f.op === "policy").then(() => machine.close());
    expect(await apply(d)).toMatchObject({ applied: false, reason: "offline" });
    const [sent] = policyReqs(machine);
    const opId = (sent?.args as { opId: string } | undefined)?.opId ?? "";
    expect((await auditsOf(d.deviceId)).map((a) => a.action)).toEqual([
      "device.policy_requested",
      "device.policy_unknown",
    ]);
    await waitFor(
      async () => (await redis.get(deviceLeaseKey(d.deviceId))) === null,
      15_000,
      "lease released",
    );
    await db
      .updateTable("device_machines")
      .set({ roots: null })
      .where("id", "=", d.machineId)
      .execute();
    expect((await entries(d.machineId))[0]).toMatchObject({ id: opId, status: "unknown" });

    // within the window: nothing reported
    sim.hold = false;
    const m2 = await connect(d, sim, { recentOps: [] });
    expect((await entries(d.machineId))[0]?.reported).toBeUndefined();
    expect(await owed(`device-op-reported-${opId}`)).toBeUndefined();
    await disconnect(d, m2);

    // past it: absent from the device's outcomes means it never arrived
    await windowPassed(d.machineId, opId);
    await connect(d, sim, { recentOps: [] });
    expect((await entries(d.machineId))[0]).toMatchObject({ reported: { outcome: "absent" } });
    const job = await owed(`device-op-reported-${opId}`);
    await resolver.resolve(jobData(job));
    expect(await entries(d.machineId)).toEqual([]);
    const audits = await auditsOf(d.deviceId);
    expect(audits.map((a) => a.action)).toEqual([
      "device.policy_requested",
      "device.policy_unknown",
      "device.policy_failed",
    ]);
    expect(audits[2]?.detail).toMatchObject({ opId, reason: "not_received" });
  }, 60_000);

  it("a device without policyOpId is unsupported and sent nothing", async () => {
    const d = await device();
    const sim = new Sim();
    const machine = await connect(d, sim, { features: ["networkReport", "policyOp"] });
    expect(await apply(d)).toMatchObject({ applied: false, reason: "unsupported" });
    expect(policyReqs(machine)).toEqual([]);
    expect(await auditsOf(d.deviceId)).toEqual([]);
    expect(await entries(d.machineId)).toEqual([]);
  });

  it("the kernel keeps policyOpId from the hello", async () => {
    const d = await device();
    await connect(d, new Sim());
    expect((await policies.summary(d.deviceId))?.features).toEqual([
      "networkReport",
      "policyOp",
      "policyOpId",
    ]);
  });

  it("a refusal is audited policy_failed and nothing is stored", async () => {
    const d = await device();
    const sim = new Sim();
    sim.refuse = "This device does not accept network changes from the deployment";
    await connect(d, sim, { policy: { ...POLICY, remoteGrants: "off" } });
    expect(await apply(d)).toEqual({ applied: false, reason: "refused", message: sim.refuse });
    expect(await entries(d.machineId)).toEqual([]);
    const audits = await auditsOf(d.deviceId);
    expect(audits.map((a) => a.action)).toEqual([
      "device.policy_requested",
      "device.policy_failed",
    ]);
    expect(audits[1]?.detail).toMatchObject({ reason: "refused", message: sim.refuse });
    expect((await policies.summary(d.deviceId))?.policy?.remoteGrants).toBe("off");
  });

  it("an answer the kernel cannot read, or the machine's own error, is resolved, not refused", async () => {
    for (const after of ["bad-result", "error"] as const) {
      const d = await device();
      const sim = new Sim();
      sim.after = after;
      const machine = await connect(d, sim);
      const out = await apply(d);
      expect(out).toMatchObject({ applied: false, reason: "offline" });
      const message = out.applied ? "" : out.message;
      expect(message).toMatch(
        /^The device's machine did not confirm the policy change; the platform checks it again shortly\. /,
      );
      expect(message).not.toContain("is offline");
      if (after === "error") expect(message.endsWith(" EIO")).toBe(true);
      const [sent] = policyReqs(machine);
      const opId = (sent?.args as { opId: string } | undefined)?.opId ?? "";
      expect(await entries(d.machineId)).toEqual([
        expect.objectContaining({ id: opId, status: "unknown" }),
      ]);
      await resolver.resolve(jobData(await owed(`device-op-resolve-${opId}`)));
      expect(await entries(d.machineId)).toEqual([]);
      const audits = await auditsOf(d.deviceId);
      expect(audits.map((a) => a.action)).toEqual([
        "device.policy_requested",
        "device.policy_unknown",
        "device.policy_changed",
      ]);
      expect(audits[2]?.detail).toMatchObject({ opId, late: true });
      expect((await policies.summary(d.deviceId))?.policy?.allowedDomains).toEqual([
        "pypi.org",
        "files.slack.com",
      ]);
      expect(policyReqs(machine)).toHaveLength(1);
    }
  }, 60_000);

  it("an op the machine logged only as started is judged by the policy it reports, past the window", async () => {
    // written before it stopped: applied (by the resolver's policyStatus, then by a hello)
    const d = await device();
    const sim = new Sim();
    sim.after = "stopped";
    let machine = await connect(d, sim);
    void machine.next((f) => f.type === "req" && f.op === "policy").then(() => machine.close());
    expect(await apply(d)).toMatchObject({ applied: false, reason: "offline" });
    const opId = (policyReqs(machine)[0]?.args as { opId: string } | undefined)?.opId ?? "";
    await waitFor(
      async () => (await redis.get(deviceLeaseKey(d.deviceId))) === null,
      15_000,
      "lease released",
    );
    await db
      .updateTable("device_machines")
      .set({ roots: null })
      .where("id", "=", d.machineId)
      .execute();
    // within the window the resolver cannot tell yet
    machine = await connect(d, sim, { recentOps: sim.recentOps() });
    await resolver.resolve({ machineId: d.machineId, opId });
    expect((await entries(d.machineId))[0]).toMatchObject({ status: "unknown" });
    expect((await entries(d.machineId))[0]?.reported).toBeUndefined();
    await windowPassed(d.machineId, opId);
    await resolver.resolve({ machineId: d.machineId, opId });
    expect(await entries(d.machineId)).toEqual([]);
    expect((await auditsOf(d.deviceId)).map((a) => a.action)).toEqual([
      "device.policy_requested",
      "device.policy_unknown",
      "device.policy_changed",
    ]);

    // not written before it stopped: a hello past the window reports it interrupted
    const d2 = await device();
    const sim2 = new Sim();
    sim2.hold = true;
    const m2 = await connect(d2, sim2);
    void m2.next((f) => f.type === "req" && f.op === "policy").then(() => m2.close());
    await apply(d2);
    const op2 = (policyReqs(m2)[0]?.args as { opId: string } | undefined)?.opId ?? "";
    await disconnect(d2, m2);
    await windowPassed(d2.machineId, op2);
    await connect(d2, sim2, { recentOps: [{ opId: op2, outcome: "started" }] });
    expect((await entries(d2.machineId))[0]).toMatchObject({
      reported: { outcome: "interrupted" },
    });
    await resolver.resolve(jobData(await owed(`device-op-reported-${op2}`)));
    expect(await entries(d2.machineId)).toEqual([]);
    const audits = await auditsOf(d2.deviceId);
    expect(audits.at(-1)).toMatchObject({
      action: "device.policy_failed",
      detail: expect.objectContaining({ opId: op2, reason: "interrupted" }),
    });
  }, 90_000);

  it("a hello's refusal keeps the machine's message; an op reported meanwhile is not turned unknown", async () => {
    const d = await device();
    const sim = new Sim();
    sim.refuse = "remote grants are off on this machine";
    const machine = await connect(d, sim);
    const opId = await crashedApply(d);
    await disconnect(d, machine);
    await connect(d, sim, { recentOps: sim.recentOps() });
    expect((await entries(d.machineId))[0]).toMatchObject({ reported: { outcome: "refused" } });
    // a resolver that read the entry before the hello and found the machine offline
    expect(
      await txHost.run(() =>
        policies.settleIn({ machineId: d.machineId, opId }, { outcome: "unknown" }),
      ),
    ).toMatchObject({ applied: false });
    expect((await entries(d.machineId))[0]).toMatchObject({ status: "sent" });
    expect((await auditsOf(d.deviceId)).map((a) => a.action)).toEqual(["device.policy_requested"]);
    await resolver.resolve(jobData(await owed(`device-op-reported-${opId}`)));
    const audits = await auditsOf(d.deviceId);
    expect(audits.map((a) => a.action)).toEqual([
      "device.policy_requested",
      "device.policy_failed",
    ]);
    expect(audits[1]?.detail).toMatchObject({ reason: "refused", message: sim.refuse });
  });

  it("an expired entry no longer takes a hello's report: the change is the owner's", async () => {
    const d = await device();
    const sim = new Sim();
    const machine = await connect(d, sim);
    const opId = await crashedApply(d);
    await disconnect(d, machine);
    await patchEntry(d.machineId, opId, { until: Date.now() - 1, resolveAt: Date.now() - 1 });
    await connect(d, sim, { recentOps: sim.recentOps() });
    expect((await entries(d.machineId))[0]?.reported).toBeUndefined();
    expect(await owed(`device-op-reported-${opId}`)).toBeUndefined();
    // the resolve job finds no live entry either
    await resolver.resolve({ machineId: d.machineId, opId });
    const audits = await auditsOf(d.deviceId);
    expect(audits.map((a) => [a.action, (a.detail as { via?: string }).via])).toEqual([
      ["device.policy_requested", "web"],
      ["device.policy_changed", "device"],
    ]);
  });
});
