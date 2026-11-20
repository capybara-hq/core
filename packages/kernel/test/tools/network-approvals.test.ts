import { randomUUID } from "node:crypto";
import type { DeviceLocalPolicySummary, KernelReq } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EventLog } from "../../src/conversations/event-log.js";
import type { ConversationEvent } from "../../src/conversations/events.js";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { DeviceProjectsService } from "../../src/devices/device-projects.service.js";
import { DevicesService } from "../../src/devices/devices.service.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import { deviceLeaseKey } from "../../src/local-devices/keys.js";
import { MachinesService } from "../../src/local-devices/machines.js";
import { NetworkGrants } from "../../src/local-devices/network-grants.js";
import { assistantIdemKey } from "../../src/runtime/model-call.js";
import { RunExecution, withExclusiveAdmission } from "../../src/runtime/run-execution.js";
import { Waits } from "../../src/runtime/waits.js";
import {
  type ApprovalRecord,
  ApprovalsService,
  NETWORK_ASK_CANCELLED_NOTE,
  type NetworkAskInput,
} from "../../src/tools/approvals.service.js";
import { DeviceOpResolver } from "../../src/tools/device-op-resolver.js";
import { legacyDbFor } from "../helpers/conversations.js";
import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import {
  createAgent,
  createConv,
  createOrgWithProviders,
  eventsOf,
  PW,
  postMessage,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
  waitFor,
} from "../helpers/runs.js";
import { FakeMachine } from "../local-devices/fake-machine-v3.js";
import type { Answer } from "../local-devices/test-holder.js";

/**
 * Network asks (network ask-to-allow spec §5.2, §6.1–§6.8, P1.6): approvals of kind `network`
 * the device owner decides. "Allow once" is a run grant and the only offer: under device protocol 4
 * the deployment never adds a host to a local device, so "Always allow" is not offered and is
 * refused (no `policy` op is sent). A reply skips the ask, expiry and abort settle it, and the
 * call's tool approvals are left alone; a pending op is still settled in lock order with fenced
 * device writers.
 */

const POLICY: DeviceLocalPolicySummary = { allowedDomains: ["pypi.org"] };

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let k: TestKernel;
let ownerId: string;
let orgId: string;
let wsUrl: string;
const open: FakeMachine[] = [];

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = legacyDbFor(raw);
  redis = new Redis(rd.url);
  // no worker: a resumed run is enqueued and stays queued
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "gateway"],
        devices: { local: { reconnectGraceSeconds: 2, leaseTtlMs: 6000 } },
      },
    ),
  );
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  orgId = await createOrgWithProviders(k, await session(k, "owner"));
  wsUrl = `ws://127.0.0.1:${k.port}/device/connect`;
});

afterEach(() => {
  for (const m of open.splice(0)) m.close();
});

afterAll(async () => {
  await k?.close();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

const approvals = () => k.app.get(ApprovalsService);

/** A member with a session, a local device (machine signed in, not connected) and a conversation. */
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
  const runId = await run(conversationId, accountId);
  s = { accountId, req, ...device, conversationId, runId };
});

/** A waiting run of `conversationId` started by `accountId`. */
async function run(conversationId: string, accountId: string, budgetRunId: string | null = null) {
  const id = randomUUID();
  await sql`INSERT INTO capybara.runs (id, conversation_id, status, agent_version,
      trigger_account_id, trigger_seq, budget_run_id, waiting_since)
    VALUES (${id}, ${conversationId}, 'waiting', 1, ${accountId}, 0, ${budgetRunId}, now())`.execute(
    raw,
  );
  return id;
}

const KEPT = { content: "curl: (56) CONNECT tunnel failed, response 403", isError: true };

function ask(over: Partial<NetworkAskInput> = {}): Promise<ApprovalRecord> {
  return approvals().requestNetwork({
    orgId,
    conversationId: s.conversationId,
    runId: s.runId,
    step: 1,
    callId: `c-${randomUUID().slice(0, 8)}`,
    requestedFor: s.accountId,
    detail: {
      deviceId: s.deviceId,
      hosts: [
        { host: "files.slack.com", port: 443 },
        { host: "api.github.com", port: 443 },
      ],
      command: "curl https://files.slack.com/x",
      description: "Download the file",
      result: KEPT,
    },
    scopes: ["once"],
    ...over,
  });
}

const decide = (id: string, payload: Record<string, unknown>, req: Req = s.req) =>
  req({ method: "POST", url: `/api/v1/orgs/${orgId}/approvals/${id}/decision`, payload });

const ofType = <T extends ConversationEvent["type"]>(evs: ConversationEvent[], type: T) =>
  evs.filter((e): e is Extract<ConversationEvent, { type: T }> => e.type === type);

const row = (id: string) =>
  db.selectFrom("approvals").selectAll().where("id", "=", id).executeTakeFirstOrThrow();

/** The machine's pending policy ops (the platform's sent intents). */
async function entries() {
  const r = await db
    .selectFrom("device_machines")
    .select("pending_policy_ops")
    .where("id", "=", s.machineId)
    .executeTakeFirstOrThrow();
  return r.pending_policy_ops as Record<string, unknown>[];
}

const runStatus = async (runId: string) =>
  (await db.selectFrom("runs").select("status").where("id", "=", runId).executeTakeFirstOrThrow())
    .status;

const networkAudits = (deviceId: string) =>
  db
    .selectFrom("audit_events")
    .select(["action", "actor_account_id", "detail"])
    .where("target", "=", deviceId)
    .where("action", "in", [
      "device.policy_changed",
      "device.network_allowed",
      "device.network_denied",
    ])
    .orderBy("id")
    .execute();

/** Connects the device's machine with the policy op and waits until its hello is recorded. */
async function connect(answer: (req: KernelReq) => Answer) {
  const machine = new FakeMachine(wsUrl, s.credential, answer, { hello: false });
  open.push(machine);
  await machine.opened;
  machine.hello({ features: ["networkReport", "policyOp", "policyOpId"], policy: POLICY });
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

describe("requestNetwork", () => {
  it("records a pending network ask for the device owner and logs approval_requested with the hosts", async () => {
    const a = await ask();
    expect(a).toMatchObject({
      kind: "network",
      status: "pending",
      toolKey: "Bash",
      attempt: 1,
      requestedFor: s.accountId,
      approverRole: null,
      scopes: ["once"],
      detail: { deviceId: s.deviceId, result: KEPT },
    });
    const [requested] = ofType(await eventsOf(db, s.conversationId), "approval_requested");
    expect(requested?.payload).toEqual({
      step: 1,
      callId: a.callId,
      approvalId: a.id,
      toolKey: "Bash",
      expiresAt: a.expiresAt,
      network: { hosts: ["files.slack.com", "api.github.com"] },
      requestedFor: s.accountId,
      approverRole: null,
    });
    // expires like a tool approval (tools.approvalTimeoutHours, 24h by default)
    const hours = (new Date(a.expiresAt).getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(23.9);
    expect(hours).toBeLessThanOrEqual(24);
  });

  it("takes the attempt after the call's tool approvals; forCall sees only tool approvals; one ask per call", async () => {
    const callId = "c-shared";
    const tool = await approvals().request({
      orgId,
      conversationId: s.conversationId,
      runId: s.runId,
      step: 1,
      callId,
      toolKey: "Bash",
      specHash: "h",
      connectorId: null,
      input: { command: "curl x" },
      requestedFor: s.accountId,
      approverRole: null,
    });
    const net = await ask({ callId });
    expect(net.attempt).toBe(2);
    expect(await ask({ callId })).toMatchObject({ id: net.id });
    expect((await approvals().forCall(s.runId, callId))?.id).toBe(tool.id);
    expect((await approvals().networkForCall(s.runId, callId))?.id).toBe(net.id);
    expect(await approvals().networkForCall(s.runId, "c-none")).toBeNull();
    // deciding the network ask leaves the tool approval as it was
    expect((await decide(net.id, { decision: "deny" })).statusCode).toBe(200);
    expect((await approvals().forCall(s.runId, callId))?.status).toBe("pending");
  });
});

describe("decide", () => {
  it("「这次允许」: a run grant of every asked host, approval_decided, device.network_allowed, the run resumes", async () => {
    const a = await ask();
    const res = await decide(a.id, { decision: "approve", scope: "once" });
    expect(res.statusCode, res.body).toBe(200);
    const body = (res.json() as { approval: Record<string, unknown> }).approval;
    expect(body).toMatchObject({ status: "approved", scope: "once", kind: "network" });
    // the kept command result never leaves the kernel
    expect(body.detail).not.toHaveProperty("result");
    expect((await row(a.id)).detail).toMatchObject({
      grantedHosts: ["files.slack.com", "api.github.com"],
      outcome: "once",
      result: KEPT,
    });
    const grants = await k.app
      .get(NetworkGrants)
      .forExec({ orgId, runId: s.runId, deviceId: s.deviceId });
    expect([...(grants?.hosts ?? [])].sort()).toEqual(["api.github.com", "files.slack.com"]);
    const [decided] = ofType(await eventsOf(db, s.conversationId), "approval_decided");
    expect(decided?.payload).toEqual({
      approvalId: a.id,
      callId: a.callId,
      decision: "approved",
      scope: "once",
      byAccountId: s.accountId,
    });
    expect(await networkAudits(s.deviceId)).toEqual([
      {
        action: "device.network_allowed",
        actor_account_id: s.accountId,
        detail: expect.objectContaining({
          approvalId: a.id,
          deviceId: s.deviceId,
          hosts: ["files.slack.com", "api.github.com"],
          scope: "once",
          outcome: "once",
          by: s.accountId,
          via: "web",
        }),
      },
    ]);
    // no tool grant of any kind
    expect(await db.selectFrom("tool_grants").selectAll().execute()).toEqual([]);
    expect(await db.selectFrom("conversation_tool_grants").selectAll().execute()).toEqual([]);
    await waitFor(async () => (await runStatus(s.runId)) === "queued", 10_000, "run resumed");
  });

  // Device protocol 4: the platform never widens a local device's sandbox, so an ask offers a run
  // grant only; "Always allow" is refused and nothing reaches the machine
  it("an ask offers once only; always → 409 approval.scope_not_allowed, nothing sent", async () => {
    const machine = await connect(() => ({ ok: true, result: null }));
    const a = await ask();
    expect(a.scopes).toEqual(["once"]);
    const res = await decide(a.id, { decision: "approve", scope: "always" });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe(
      "approval.scope_not_allowed",
    );
    expect((await row(a.id)).status).toBe("pending");
    expect(machine.frames.filter((f) => f.type === "req" && f.op === "policy")).toEqual([]);
    expect(await entries()).toEqual([]);
  });

  it("deny: a reason, device.network_denied, nothing granted, the hosts refused in the run", async () => {
    const a = await ask();
    const res = await decide(a.id, { decision: "deny", reason: "Not this one" });
    expect(res.statusCode, res.body).toBe(200);
    expect(
      await k.app.get(NetworkGrants).forExec({ orgId, runId: s.runId, deviceId: s.deviceId }),
    ).toBeUndefined();
    const state = await k.app.get(NetworkGrants).runState(s.runId);
    expect([...state.refused].sort()).toEqual(["api.github.com", "files.slack.com"]);
    const audits = await networkAudits(s.deviceId);
    expect(audits).toEqual([
      {
        action: "device.network_denied",
        actor_account_id: s.accountId,
        detail: expect.objectContaining({
          hosts: ["files.slack.com", "api.github.com"],
          outcome: "denied",
          scope: null,
          reason: "Not this one",
        }),
      },
    ]);
  });
});

/** A sub-agent's conversation under the setup's conversation. */
async function subagentConversation(): Promise<string> {
  const id = randomUUID();
  await sql`INSERT INTO capybara.conversations
      (id, org_id, agent_id, account_id, kind, parent_conversation_id)
    SELECT ${id}, org_id, agent_id, account_id, 'subagent', id
      FROM capybara.conversations WHERE id = ${s.conversationId}`.execute(raw);
  return id;
}

describe("settling without a decision", () => {
  it("a reply by the run's starter skips the asks here and in a sub-agent's conversation; the runs resume", async () => {
    const here = await ask();
    // a sub-agent's conversation and run (its trigger account is the person's, as dispatched)
    const childConv = await subagentConversation();
    const childRun = await run(childConv, s.accountId, s.runId);
    const child = await ask({ conversationId: childConv, runId: childRun });
    // another person's run in a sub-agent's conversation is not theirs to skip
    const strangerConv = await subagentConversation();
    const strangerRun = await run(strangerConv, ownerId);
    const stranger = await ask({ conversationId: strangerConv, runId: strangerRun });

    await postMessage(s.req, orgId, s.conversationId, "never mind, use the cache");

    for (const [id, conv] of [
      [here.id, s.conversationId],
      [child.id, childConv],
    ] as const) {
      expect((await row(id)).status).toBe("skipped");
      const decided = ofType(await eventsOf(db, conv), "approval_decided").find(
        (e) => e.payload.approvalId === id,
      );
      expect(decided?.payload).toEqual({
        approvalId: id,
        callId: expect.any(String),
        decision: "skipped",
        byAccountId: s.accountId,
      });
    }
    expect((await row(stranger.id)).status).toBe("pending");
    await waitFor(async () => (await runStatus(s.runId)) === "queued", 10_000, "run resumed");
    await waitFor(async () => (await runStatus(childRun)) === "queued", 10_000, "child resumed");
    // a skipped host is not asked again in the run tree
    const state = await k.app.get(NetworkGrants).runState(s.runId);
    expect(state.refused.has("files.slack.com")).toBe(true);
    // a skipped ask is no longer decidable
    const late = await decide(here.id, { decision: "approve" });
    expect(late.statusCode).toBe(409);
  });

  it("expiry: the wait timeout expires the ask like a tool approval", async () => {
    const a = await ask();
    await sql`UPDATE capybara.approvals SET expires_at = now() - interval '1 second'
      WHERE id = ${a.id}`.execute(raw);
    await k.app.get(Waits).expire("approval", a.id);
    expect((await row(a.id)).status).toBe("expired");
    const decided = ofType(await eventsOf(db, s.conversationId), "approval_decided");
    expect(decided.map((e) => e.payload.decision)).toEqual(["expired"]);
    const late = await decide(a.id, { decision: "approve" });
    expect(late.statusCode).toBe(409);
  });

  it("abort: the call's result is the kept command result plus the cancelled note", async () => {
    const callId = "c-abort";
    await k.app.get(EventLog).append(s.conversationId, [
      {
        type: "assistant_message",
        runId: s.runId,
        idemKey: assistantIdemKey(s.runId, 1),
        payload: {
          step: 1,
          content: [{ type: "tool_call", id: callId, name: "Bash", input: { command: "curl x" } }],
          stopReason: "tool_use",
        },
      },
    ]);
    const a = await ask({ callId });
    expect(await k.app.get(Waits).abortWaiting(s.conversationId, s.runId, s.accountId)).toBe(true);
    expect((await row(a.id)).status).toBe("cancelled");
    const [result] = ofType(await eventsOf(db, s.conversationId), "tool_result");
    expect(result?.payload).toMatchObject({
      callId,
      toolKey: "Bash",
      content: `${KEPT.content}\n\n${NETWORK_ASK_CANCELLED_NOTE}`,
      isError: true,
    });
  });
});

// A pending op naming an ask (written before device protocol 4, or by the resolver's own records)
// is still settled: the settle transactions lock the ask's conversation, its approval and its run,
// then record the op's outcome under the machine's device permission lock. A fenced device writer
// of the same tree (a Platform device project write in a tool step) holds that lock in its prelude
// and then wants the tree's root row: the settle takes the device lock first (its ordered prelude),
// else 40P01.
describe("network ask settlements and fenced device writers of the same tree", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const resolver = () => k.app.get(DeviceOpResolver);
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  };
  const waitingLocks = async () =>
    Number(
      (
        await sql<{ n: string }>`select count(*) n from pg_locks l
          join pg_stat_activity a on a.pid = l.pid
          where not l.granted and a.datname = current_database()`.execute(raw)
      ).rows[0]?.n,
    );

  /** A pending op on the machine answering ask `approvalId`, reported never received. */
  async function pendingOp(approvalId: string): Promise<string> {
    const opId = randomUUID();
    const now = Date.now();
    await db
      .updateTable("device_machines")
      .set({
        pending_policy_ops: JSON.stringify([
          {
            id: opId,
            add: ["files.slack.com"],
            remove: [],
            source: { accountId: s.accountId, via: "web", approvalId },
            status: "sent",
            sentAt: now,
            resolveAt: now,
            until: now + 3_600_000,
            reported: { outcome: "absent" },
          },
        ]),
      })
      .where("id", "=", s.machineId)
      .execute();
    return opId;
  }

  /**
   * A claimed run in the ask's tree removes a device project (a tool step), paused once
   * its prelude holds the device lock; `settle` then runs, and the writer goes on once it waits.
   */
  async function againstFencedDeviceWrite(settle: () => Promise<unknown>): Promise<void> {
    // a sub-agent of the ask's conversation (the root: its one active run is the waiting one)
    const child = randomUUID();
    await sql`INSERT INTO capybara.conversations
        (id, org_id, agent_id, account_id, parent_conversation_id, kind)
      SELECT ${child}, org_id, agent_id, account_id, id, 'subagent'
      FROM capybara.conversations WHERE id = ${s.conversationId}`.execute(raw);
    const runId = randomUUID();
    await sql`INSERT INTO capybara.runs (id, conversation_id, status, agent_version,
        trigger_account_id, trigger_seq)
      VALUES (${runId}, ${child}, 'running', 1, ${s.accountId}, 0)`.execute(raw);
    const claim = await k.app.get(RunExecution).claim(child, runId, randomUUID());
    if (!claim) throw new Error("the run could not be claimed");
    const projects = k.app.get(DeviceProjectsService);
    // biome-ignore lint/suspicious/noExplicitAny: a private method spied on as a test seam
    const seam = projects as unknown as Record<string, (...a: any[]) => Promise<void>>;
    const real = seam.lockSubject?.bind(projects);
    if (!real) throw new Error("no prelude to pause");
    const held = deferred();
    const go = deferred();
    vi.spyOn(seam, "lockSubject").mockImplementationOnce(async (...args: unknown[]) => {
      await real(...args);
      held.resolve();
      await go.promise;
    });
    const writer = k.app.get(RunExecution).withClaim(
      claim,
      () => true,
      () => withExclusiveAdmission(() => projects.remove(orgId, s.accountId, s.deviceId, "none")),
    );
    await held.promise;
    let settled = false;
    const other = settle().finally(() => {
      settled = true;
    });
    await expect.poll(async () => settled || (await waitingLocks()) > 0).toBe(true);
    go.resolve();
    const [w, o] = await Promise.allSettled([writer, other]);
    expect(w.status === "rejected" ? String(w.reason) : "fulfilled").toBe("fulfilled");
    expect(o.status === "rejected" ? String(o.reason) : "fulfilled").toBe("fulfilled");
  }

  it("the device-op-resolve job's settle", async () => {
    const a = await ask();
    const opId = await pendingOp(a.id);
    await againstFencedDeviceWrite(() => resolver().resolve({ machineId: s.machineId, opId }));
    // recorded: the op is gone; the ask is not decided by it
    expect(await entries()).toEqual([]);
    expect((await row(a.id)).status).toBe("pending");
  });
});
