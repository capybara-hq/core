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
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ConversationEvent } from "../../src/conversations/events.js";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { DevicesService } from "../../src/devices/devices.service.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import { OUTBOX_DISPATCH_FAILS } from "../../src/infra/outbox/outbox.dispatcher.js";
import { DEVICE_POLICY_AFTER_CALL } from "../../src/local-devices/device-policy.service.js";
import { deviceLeaseKey } from "../../src/local-devices/keys.js";
import { MachinesService } from "../../src/local-devices/machines.js";
import type { DeviceOpResolveData } from "../../src/local-devices/policy-op-jobs.js";
import { MAINTENANCE_QUEUE_NAME } from "../../src/runtime/maintenance-queue.js";
import { RUN_QUEUE_NAME, resumeJobId } from "../../src/runtime/run-jobs.js";
import { type ApprovalRecord, ApprovalsService } from "../../src/tools/approvals.service.js";
import { DeviceOpResolver } from "../../src/tools/device-op-resolver.js";
import { legacyDbFor } from "../helpers/conversations.js";
import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import {
  createAgent,
  createConv,
  createOrg,
  eventsOf,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
  waitFor,
} from "../helpers/runs.js";
import { FakeMachine, HELLO } from "../local-devices/fake-machine.js";
import type { Answer } from "../local-devices/test-holder.js";

/**
 * Network asks decide on the device policy intent (transactional outbox spec §7, Part 6 re-plan
 * Task 19b): 「这台设备一直允许」 records the intent (with the ask's id) before the device is
 * called; the call's outcome and the ask's decision are one transaction; a crash between the
 * two is settled by the `device-op-resolve` job, which decides the still-pending ask when the
 * device applied the change and otherwise leaves it pending with the reason (`detail.attempt`).
 * Every add to the maintenance and run queues fails here (`OUTBOX_DISPATCH_FAILS`): the owed rows
 * are asserted, the resolver is called with the owed row's data, no sleeps.
 */

const POLICY: DeviceLocalPolicySummary = {
  effectiveTier: "strict",
  isolation: "sandbox",
  localhost: "off",
  unixSockets: "off",
  allowedDomains: ["pypi.org"],
  remoteGrants: "owner",
};
const FEATURES: DeviceHello["features"] = ["networkReport", "policyOp", "policyOpId"];

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let k: TestKernel;
let ownerId: string;
let orgId: string;
let wsUrl: string;
let crashNext = false;
const crashed: string[] = [];
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
        // long enough for a machine to reconnect while a call waits for it
        devices: { local: { reconnectGraceSeconds: 5, leaseTtlMs: 6000 } },
      },
    ),
    {
      overrides: [
        {
          provide: OUTBOX_DISPATCH_FAILS,
          useValue: (queue: string) => queue === MAINTENANCE_QUEUE_NAME || queue === RUN_QUEUE_NAME,
        },
        {
          provide: DEVICE_POLICY_AFTER_CALL,
          useValue: (opId: string) => {
            if (!crashNext) return;
            crashNext = false;
            crashed.push(opId);
            throw new Error("crashed after the call");
          },
        },
      ],
    },
  );
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  orgId = await createOrg(await session(k, "owner"));
  wsUrl = `ws://127.0.0.1:${k.port}/device/connect`;
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

interface Setup {
  accountId: string;
  req: Req;
  deviceId: string;
  machineId: string;
  credential: string;
  conversationId: string;
  runId: string;
}

let s: Setup;

beforeEach(async () => {
  const login = `m-${randomUUID().slice(0, 8)}`;
  const accountId = (
    await accountsFor(db).createLocal({ login, password: PW, displayName: `Dev ${login}` })
  ).id;
  await testMembers(db).add(orgId, accountId, "member", ownerId);
  const req = await session(k, login);
  const device = await k.app.get(TransactionHost).run(async () => {
    const { id: deviceId } = await k.app.get(DevicesService).createLocal(orgId, accountId, "Box");
    const issued = await k.app.get(MachinesService).issue({
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
  const agentId = await createAgent(req, orgId);
  const conversationId = await createConv(req, orgId, agentId);
  const runId = randomUUID();
  await sql`INSERT INTO capybara.runs (id, conversation_id, status, agent_version,
      trigger_account_id, trigger_seq, waiting_since)
    VALUES (${runId}, ${conversationId}, 'waiting', 1, ${accountId}, 0, now())`.execute(raw);
  s = { accountId, req, ...device, conversationId, runId };
});

/** A machine stand-in that applies `policy` ops, logs their outcomes and answers `policyStatus`. */
class Sim {
  policy: DeviceLocalPolicySummary = POLICY;
  readonly log = new Map<string, DevicePolicyOpOutcome>();
  /** `hold`: no answer (the test answers); `apply-then-drop`: applies, never answers. */
  mode: "answer" | "hold" | "apply-then-drop" = "answer";

  answer = (req: KernelReq): Answer => {
    if (req.op === "policyStatus") {
      const { opId } = req.args as { opId: string };
      return {
        ok: true,
        result: { outcome: this.log.get(opId) ?? "unknown", policy: this.policy },
      };
    }
    if (req.op !== "policy" || this.mode === "hold") {
      return req.op === "policy" ? undefined : { ok: true, result: null };
    }
    const answer = this.apply(req);
    return this.mode === "apply-then-drop" ? undefined : answer;
  };

  apply(req: KernelReq): NonNullable<Answer> {
    const a = req.args as { opId: string; add?: string[] };
    this.policy = {
      ...this.policy,
      allowedDomains: [...new Set([...this.policy.allowedDomains, ...(a.add ?? [])])],
    };
    this.log.set(a.opId, "applied");
    return { ok: true, result: { policy: this.policy } };
  }

  recentOps() {
    return [...this.log].map(([opId, outcome]) => ({ opId, outcome }));
  }
}

async function connect(sim: Sim, hello: Partial<DeviceHello> = {}) {
  const machine = new FakeMachine(wsUrl, s.credential, sim.answer, { hello: false });
  open.push(machine);
  await machine.opened;
  machine.send({ ...HELLO, features: FEATURES, policy: sim.policy, ...hello });
  await waitFor(
    async () => (await redis.get(deviceLeaseKey(s.deviceId))) !== null,
    10_000,
    "lease held",
  );
  await waitFor(
    async () =>
      (
        await db
          .selectFrom("device_machines")
          .select("roots")
          .where("id", "=", s.machineId)
          .executeTakeFirst()
      )?.roots != null,
    10_000,
    "hello recorded",
  );
  return machine;
}

/** Drops the machine's connection and waits until no replica holds it. */
async function disconnect(machine: FakeMachine) {
  machine.close();
  await waitFor(
    async () => (await redis.get(deviceLeaseKey(s.deviceId))) === null,
    15_000,
    "lease released",
  );
  // the next connection's hello is recorded anew
  await db
    .updateTable("device_machines")
    .set({ roots: null })
    .where("id", "=", s.machineId)
    .execute();
}

function ask(): Promise<ApprovalRecord> {
  return k.app.get(ApprovalsService).requestNetwork({
    orgId,
    conversationId: s.conversationId,
    runId: s.runId,
    step: 1,
    callId: `c-${randomUUID().slice(0, 8)}`,
    requestedFor: s.accountId,
    detail: {
      deviceId: s.deviceId,
      hosts: [{ host: "files.slack.com", port: 443 }],
      command: "curl https://files.slack.com/x",
      description: "Download the file",
      result: { content: "curl: (56) CONNECT tunnel failed, response 403", isError: true },
    },
    scopes: ["once", "always"],
  });
}

const always = (id: string) =>
  s.req({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/approvals/${id}/decision`,
    payload: { decision: "approve", scope: "always" },
  });

const row = (id: string) =>
  db.selectFrom("approvals").selectAll().where("id", "=", id).executeTakeFirstOrThrow();

const audits = () =>
  db
    .selectFrom("audit_events")
    .select(["action", "actor_account_id", "detail", "at"])
    .where("target", "=", s.deviceId)
    .where((w) =>
      w.or([w("action", "like", "device.policy_%"), w("action", "like", "device.network_%")]),
    )
    .orderBy("id")
    .execute();

async function entries() {
  const r = await db
    .selectFrom("device_machines")
    .select("pending_policy_ops")
    .where("id", "=", s.machineId)
    .executeTakeFirstOrThrow();
  return r.pending_policy_ops as Record<string, unknown>[];
}

const owed = (jobId: string) =>
  db
    .selectFrom("outbox")
    .select(["job_name", "job_id", "data", "queue"])
    .where("job_id", "=", jobId)
    .executeTakeFirst();

const jobData = (job: { data: unknown } | undefined) => {
  if (job === undefined) throw new Error("no job owed");
  return job.data as DeviceOpResolveData;
};

const ofType = <T extends ConversationEvent["type"]>(evs: ConversationEvent[], type: T) =>
  evs.filter((e): e is Extract<ConversationEvent, { type: T }> => e.type === type);

const resolver = () => k.app.get(DeviceOpResolver);

/** Decides 「一直允许」 to a crash right after the device answered; returns the op id. */
async function crashedAlways(id: string): Promise<string> {
  crashNext = true;
  const res = await always(id);
  expect(res.statusCode).toBe(500);
  const opId = crashed.at(-1);
  if (opId === undefined) throw new Error("no crash");
  return opId;
}

describe("network asks on the device policy intent", { timeout: 60_000 }, () => {
  it("an always-allow decision records the request before the device is called", async () => {
    const sim = new Sim();
    sim.mode = "hold";
    const machine = await connect(sim);
    const a = await ask();
    const pending = always(a.id);
    const op = (await machine.next((f) => f.type === "req" && f.op === "policy")) as KernelReq;
    const opId = (op.args as { opId: string }).opId;
    // in flight: the intent names the ask; the ask is still pending
    expect(await audits()).toEqual([
      expect.objectContaining({
        action: "device.policy_requested",
        actor_account_id: s.accountId,
        detail: expect.objectContaining({ opId, add: ["files.slack.com"], approvalId: a.id }),
      }),
    ]);
    expect((await entries())[0]).toMatchObject({
      id: opId,
      status: "sent",
      source: { accountId: s.accountId, via: "web", approvalId: a.id },
    });
    expect((await row(a.id)).status).toBe("pending");
    machine.respond(op.id, sim.apply(op));
    const res = await pending;
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { approval: unknown }).approval).toMatchObject({
      status: "approved",
      scope: "always",
      detail: { outcome: "always", grantedHosts: ["files.slack.com"] },
    });
    // the decision and the op's outcome in one transaction
    const all = await audits();
    expect(all.map((x) => x.action)).toEqual([
      "device.policy_requested",
      "device.network_allowed",
      "device.policy_changed",
    ]);
    expect(all[1]?.at).toEqual(all[2]?.at);
    expect(all[0]?.at).not.toEqual(all[1]?.at);
    expect(await entries()).toEqual([]);
    expect(await owed(resumeJobId(s.conversationId, a.id))).toMatchObject({
      queue: RUN_QUEUE_NAME,
    });
  });

  it("a crash after the call: the job approves the still-pending ask, audits network_allowed and resumes the run", async () => {
    const sim = new Sim();
    const machine = await connect(sim);
    const a = await ask();
    const opId = await crashedAlways(a.id);
    // the device applied it; the kernel holds only the intent; the ask waits
    expect((await row(a.id)).status).toBe("pending");
    expect((await audits()).map((x) => x.action)).toEqual(["device.policy_requested"]);
    expect(await owed(resumeJobId(s.conversationId, a.id))).toBeUndefined();

    await resolver().resolve(jobData(await owed(`device-op-resolve-${opId}`)));
    const r = await row(a.id);
    expect(r).toMatchObject({ status: "approved", scope: "always", decided_by: s.accountId });
    expect(r.detail).toMatchObject({ outcome: "always", grantedHosts: ["files.slack.com"] });
    const all = await audits();
    expect(all.map((x) => x.action)).toEqual([
      "device.policy_requested",
      "device.network_allowed",
      "device.policy_changed",
    ]);
    expect(all[1]?.detail).toMatchObject({
      approvalId: a.id,
      hosts: ["files.slack.com"],
      scope: "always",
      outcome: "always",
      via: "web",
    });
    expect(all[1]?.detail).not.toHaveProperty("late");
    // the run's resume is owed in the same transaction; the decision is in the log
    expect(await owed(resumeJobId(s.conversationId, a.id))).toMatchObject({
      job_name: "run",
      queue: RUN_QUEUE_NAME,
    });
    const decided = ofType(await eventsOf(db, s.conversationId), "approval_decided");
    expect(decided.map((e) => e.payload)).toEqual([
      expect.objectContaining({ approvalId: a.id, decision: "approved", scope: "always" }),
    ]);
    // the resolver never re-sends the change; a second delivery does nothing
    expect(machine.frames.filter((f) => f.type === "req" && f.op === "policy")).toHaveLength(1);
    await resolver().resolve({ machineId: s.machineId, opId });
    expect((await audits()).length).toBe(3);
  });

  it("a crash after the call with the device disconnected: the ask stays pending with an unknown reason and an unknown audit", async () => {
    const sim = new Sim();
    const machine = await connect(sim);
    const a = await ask();
    const opId = await crashedAlways(a.id);
    await disconnect(machine);

    await resolver().resolve(jobData(await owed(`device-op-resolve-${opId}`)));
    const r = await row(a.id);
    expect(r).toMatchObject({ status: "pending", decided_by: null, scope: null });
    // never undecided without a reason (Review Focus 5)
    expect(r.detail).toMatchObject({
      attempt: { outcome: "unknown", message: expect.stringMatching(/did not confirm/) },
    });
    expect(r.detail).not.toHaveProperty("outcome");
    expect((await audits()).map((x) => x.action)).toEqual([
      "device.policy_requested",
      "device.policy_unknown",
    ]);
    const updated = ofType(await eventsOf(db, s.conversationId), "approval_updated");
    expect(updated.map((e) => e.payload)).toEqual([{ approvalId: a.id, callId: a.callId }]);
    // a second run while still offline writes nothing more
    await resolver().resolve({ machineId: s.machineId, opId });
    expect((await audits()).length).toBe(2);
    expect(ofType(await eventsOf(db, s.conversationId), "approval_updated")).toHaveLength(1);

    // the machine comes back and reports the op applied: the ask is approved now
    await connect(sim, { recentOps: sim.recentOps() });
    await resolver().resolve(jobData(await owed(`device-op-reported-${opId}`)));
    expect(await row(a.id)).toMatchObject({ status: "approved", scope: "always" });
    expect((await audits()).map((x) => x.action)).toEqual([
      "device.policy_requested",
      "device.policy_unknown",
      "device.network_allowed",
      "device.policy_changed",
    ]);
    expect(await owed(resumeJobId(s.conversationId, a.id))).toBeDefined();
  });

  it("the device disconnects mid-call while the owner waits: once_fallback as today and the intent is unknown", async () => {
    const sim = new Sim();
    sim.mode = "hold";
    const machine = await connect(sim);
    void machine.next((f) => f.type === "req" && f.op === "policy").then(() => machine.close());
    const a = await ask();
    const res = await always(a.id);
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { approval: unknown }).approval).toMatchObject({
      status: "approved",
      scope: "once",
      detail: { outcome: "once_fallback", fallback: "offline" },
    });
    const all = await audits();
    expect(all.map((x) => x.action)).toEqual([
      "device.policy_requested",
      "device.network_allowed",
      "device.policy_unknown",
    ]);
    expect(all[1]?.detail).toMatchObject({ outcome: "once_fallback", fallback: "offline" });
    expect((await entries())[0]).toMatchObject({ status: "unknown" });
  });

  it("hello later reporting it applied approves nothing already decided and audits it late", async () => {
    const sim = new Sim();
    // the machine applies the change, then its connection drops before the answer
    sim.mode = "apply-then-drop";
    const machine = await connect(sim);
    void machine.next((f) => f.type === "req" && f.op === "policy").then(() => machine.close());
    const a = await ask();
    const res = await always(a.id);
    expect(res.statusCode, res.body).toBe(200);
    expect((await row(a.id)).detail).toMatchObject({ outcome: "once_fallback" });
    const [entry] = await entries();
    const opId = entry?.id as string;
    await waitFor(
      async () => (await redis.get(deviceLeaseKey(s.deviceId))) === null,
      15_000,
      "lease released",
    );
    await db
      .updateTable("device_machines")
      .set({ roots: null })
      .where("id", "=", s.machineId)
      .execute();

    sim.mode = "answer";
    await connect(sim, { recentOps: sim.recentOps() });
    await resolver().resolve(jobData(await owed(`device-op-reported-${opId}`)));
    // the decision stands as it was taken
    const r = await row(a.id);
    expect(r).toMatchObject({ status: "approved", scope: "once" });
    expect(r.detail).toMatchObject({ outcome: "once_fallback", fallback: "offline" });
    const all = await audits();
    expect(all.map((x) => x.action)).toEqual([
      "device.policy_requested",
      "device.network_allowed",
      "device.policy_unknown",
      "device.policy_changed",
      "device.network_allowed",
    ]);
    expect(all[3]?.detail).toMatchObject({ opId, late: true });
    expect(all[4]?.detail).toMatchObject({
      approvalId: a.id,
      hosts: ["files.slack.com"],
      outcome: "always",
      late: true,
    });
    expect(all[3]?.at).toEqual(all[4]?.at);
    // one decision only
    expect(ofType(await eventsOf(db, s.conversationId), "approval_decided")).toHaveLength(1);
  });

  it("the device reconnects mid-call and reports the op applied: the owner gets the approved ask, not a 409", async () => {
    const sim = new Sim();
    // the machine applies the change and drops before answering
    sim.mode = "apply-then-drop";
    const machine = await connect(sim);
    const first = machine.next((f) => f.type === "req" && f.op === "policy");
    const a = await ask();
    const pending = always(a.id);
    const op = (await first) as KernelReq;
    const opId = (op.args as { opId: string }).opId;
    await disconnect(machine);
    // it comes back within the grace and reports the op applied in its hello
    const again = await connect(sim, { recentOps: sim.recentOps() });
    // the reported job runs while the owner's call still waits: it approves the ask as the owner
    await resolver().resolve(jobData(await owed(`device-op-reported-${opId}`)));
    expect(await row(a.id)).toMatchObject({ status: "approved", scope: "always" });
    // then sends the result it kept while disconnected
    again.respond(op.id, { ok: true, result: { policy: sim.policy } });
    const res = await pending;
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { approval: unknown }).approval).toMatchObject({
      status: "approved",
      scope: "always",
      decidedBy: s.accountId,
      detail: { outcome: "always" },
    });
    expect((await audits()).map((x) => x.action)).toEqual([
      "device.policy_requested",
      "device.network_allowed",
      "device.policy_changed",
    ]);
    expect(ofType(await eventsOf(db, s.conversationId), "approval_decided")).toHaveLength(1);
  });

  it("the device is deleted during the call: device.not_found, the op recorded unknown, nothing granted", async () => {
    const sim = new Sim();
    sim.mode = "hold";
    const machine = await connect(sim);
    void machine
      .next((f) => f.type === "req" && f.op === "policy")
      .then(async () => {
        await sql`UPDATE capybara.devices SET deleted_at = now() WHERE id = ${s.deviceId}`.execute(
          raw,
        );
        machine.close();
      });
    const a = await ask();
    const res = await always(a.id);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "device.not_found" } });
    expect((await row(a.id)).status).toBe("pending");
    expect((await audits()).map((x) => x.action)).toEqual([
      "device.policy_requested",
      "device.policy_unknown",
    ]);
  });

  it("a crash after the call whose chooser can no longer decide: the ask waits with that reason, the allow audited, not late", async () => {
    const sim = new Sim();
    await connect(sim);
    const a = await ask();
    const opId = await crashedAlways(a.id);
    // the ask now waits for someone else (its chooser cannot decide it any more)
    await sql`UPDATE capybara.approvals SET requested_for = ${ownerId} WHERE id = ${a.id}`.execute(
      raw,
    );
    await resolver().resolve(jobData(await owed(`device-op-resolve-${opId}`)));
    const r = await row(a.id);
    expect(r.status).toBe("pending");
    expect(r.detail).toMatchObject({
      attempt: { outcome: "applied_undecided", message: expect.stringMatching(/allowed it/) },
    });
    const all = await audits();
    expect(all.map((x) => x.action)).toEqual([
      "device.policy_requested",
      "device.policy_changed",
      "device.network_allowed",
    ]);
    expect(all[2]?.detail).toMatchObject({ approvalId: a.id, undecided: true });
    expect(all[2]?.detail).not.toHaveProperty("late");
    expect(ofType(await eventsOf(db, s.conversationId), "approval_updated")).toHaveLength(1);
  });

  it("the ask closed during the call: the change is audited late in the settle transaction and the owner gets a 409", async () => {
    const sim = new Sim();
    sim.mode = "hold";
    const machine = await connect(sim);
    const a = await ask();
    const pending = always(a.id);
    const op = (await machine.next((f) => f.type === "req" && f.op === "policy")) as KernelReq;
    // a reply, the expiry or a stop closes the ask while the device applies the change
    await sql`UPDATE capybara.approvals SET status = 'cancelled', decided_at = now()
      WHERE id = ${a.id}`.execute(raw);
    machine.respond(op.id, sim.apply(op));
    const res = await pending;
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: {
        code: "approval.already_decided",
        message: "The device now allows files.slack.com; the request had already closed.",
      },
    });
    expect((await row(a.id)).status).toBe("cancelled");
    const all = await audits();
    expect(all.map((x) => x.action)).toEqual([
      "device.policy_requested",
      "device.policy_changed",
      "device.network_allowed",
    ]);
    expect(all[2]?.detail).toMatchObject({
      approvalId: a.id,
      hosts: ["files.slack.com"],
      scope: "always",
      outcome: "always",
      late: true,
    });
    // one transaction: the op's outcome and the late allow
    expect(all[1]?.at).toEqual(all[2]?.at);
    expect(await entries()).toEqual([]);
    expect(await owed(resumeJobId(s.conversationId, a.id))).toBeUndefined();
  });
});
