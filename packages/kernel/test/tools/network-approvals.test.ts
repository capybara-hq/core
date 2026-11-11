import { randomUUID } from "node:crypto";
import type { DeviceLocalPolicySummary, KernelReq } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EventLog } from "../../src/conversations/event-log.js";
import type { ConversationEvent } from "../../src/conversations/events.js";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { DevicesService } from "../../src/devices/devices.service.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import { deviceLeaseKey } from "../../src/local-devices/keys.js";
import { MachinesService } from "../../src/local-devices/machines.js";
import { NetworkGrants } from "../../src/local-devices/network-grants.js";
import { assistantIdemKey } from "../../src/runtime/model-call.js";
import { Waits } from "../../src/runtime/waits.js";
import {
  type ApprovalRecord,
  ApprovalsService,
  NETWORK_ASK_CANCELLED_NOTE,
  type NetworkAskInput,
} from "../../src/tools/approvals.service.js";
import { legacyDbFor } from "../helpers/conversations.js";
import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import {
  createAgent,
  createConv,
  createOrg,
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
import { FakeMachine, HELLO } from "../local-devices/fake-machine.js";
import type { Answer } from "../local-devices/test-holder.js";

/**
 * Network asks (network ask-to-allow spec §5.2, §6.1–§6.8, P1.6): approvals of kind `network`
 * the device owner decides. 「这次允许」 is a run grant, 「一直允许」 the `policy` op to a fake
 * machine (offline: a run grant with the reason), a reply skips the ask, expiry and abort settle
 * it, and the call's tool approvals are left alone.
 */

const POLICY: DeviceLocalPolicySummary = {
  network: "allowlist",
  allowedDomains: ["pypi.org"],
  remoteGrants: "owner",
};

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
  orgId = await createOrg(await session(k, "owner"));
  wsUrl = `ws://127.0.0.1:${k.port}/device/connect`;
}, 180_000);

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
    scopes: ["once", "always"],
    ...over,
  });
}

const decide = (id: string, payload: Record<string, unknown>, req: Req = s.req) =>
  req({ method: "POST", url: `/api/v1/orgs/${orgId}/approvals/${id}/decision`, payload });

const ofType = <T extends ConversationEvent["type"]>(evs: ConversationEvent[], type: T) =>
  evs.filter((e): e is Extract<ConversationEvent, { type: T }> => e.type === type);

const row = (id: string) =>
  db.selectFrom("approvals").selectAll().where("id", "=", id).executeTakeFirstOrThrow();

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
    .orderBy("at")
    .execute();

/** Connects the device's machine with the policy op and waits until its hello is recorded. */
async function connect(answer: (req: KernelReq) => Answer) {
  const machine = new FakeMachine(wsUrl, s.credential, answer, { hello: false });
  open.push(machine);
  await machine.opened;
  machine.send({ ...HELLO, features: ["networkReport", "policyOp"], policy: POLICY });
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
      scopes: ["once", "always"],
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

  it("「一直允许」: the policy op reaches the machine first, the decision records always", async () => {
    let now = POLICY;
    const machine = await connect((req) => {
      if (req.op !== "policy") return { ok: true, result: null };
      const add = (req.args as { add?: string[] }).add ?? [];
      now = { ...now, allowedDomains: [...now.allowedDomains, ...add] };
      return { ok: true, result: { policy: now } };
    });
    const a = await ask();
    const res = await decide(a.id, {
      decision: "approve",
      scope: "always",
      hosts: ["files.slack.com"],
    });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { approval: unknown }).approval).toMatchObject({
      status: "approved",
      scope: "always",
      detail: { grantedHosts: ["files.slack.com"], outcome: "always" },
    });
    const op = (await machine.next((f) => f.type === "req" && f.op === "policy")) as KernelReq;
    expect(op.args).toEqual({
      add: ["files.slack.com"],
      source: {
        approvalId: a.id,
        accountId: s.accountId,
        accountName: expect.stringMatching(/^Dev /),
        via: "web",
      },
    });
    const audits = await networkAudits(s.deviceId);
    expect(audits.map((x) => x.action)).toEqual([
      "device.policy_changed",
      "device.network_allowed",
    ]);
    expect(audits[1]?.detail).toMatchObject({
      hosts: ["files.slack.com"],
      refused: ["api.github.com"],
      scope: "always",
      outcome: "always",
    });
    // an always grant is the device's own policy now; the unchecked host is refused in the run
    const state = await k.app.get(NetworkGrants).runState(s.runId);
    expect([...state.refused]).toEqual(["api.github.com"]);
  });

  it("「一直允许」 with the device offline falls back to a run grant, with the reason", async () => {
    // signed in with the feature, then gone
    const machine = await connect(() => ({ ok: true, result: null }));
    machine.close();
    await waitFor(
      async () => (await redis.get(deviceLeaseKey(s.deviceId))) === null,
      15_000,
      "lease released",
    );
    const a = await ask();
    const res = await decide(a.id, { decision: "approve", scope: "always" });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { approval: unknown }).approval).toMatchObject({
      status: "approved",
      scope: "once",
      detail: { outcome: "once_fallback", fallback: "offline" },
    });
    const grants = await k.app
      .get(NetworkGrants)
      .forExec({ orgId, runId: s.runId, deviceId: s.deviceId });
    expect(grants?.hosts).toHaveLength(2);
    const audits = await networkAudits(s.deviceId);
    expect(audits.map((x) => x.action)).toEqual(["device.network_allowed"]);
    expect(audits[0]?.detail).toMatchObject({ outcome: "once_fallback", fallback: "offline" });
  });

  it("「一直允许」 refused by the device: approved as always, nothing granted, not even for the run", async () => {
    await connect((req) =>
      req.op === "policy"
        ? {
            ok: false,
            error: { kind: "policy", message: "This device does not accept network changes." },
          }
        : { ok: true, result: null },
    );
    const a = await ask();
    const res = await decide(a.id, { decision: "approve", scope: "always" });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { approval: unknown }).approval).toMatchObject({
      status: "approved",
      scope: "always",
      detail: { grantedHosts: [], outcome: "refused", fallback: "refused" },
    });
    expect(
      await k.app.get(NetworkGrants).forExec({ orgId, runId: s.runId, deviceId: s.deviceId }),
    ).toBeUndefined();
    const state = await k.app.get(NetworkGrants).runState(s.runId);
    expect([...state.refused].sort()).toEqual(["api.github.com", "files.slack.com"]);
    const audits = await networkAudits(s.deviceId);
    expect(audits.map((x) => x.action)).toEqual(["device.network_allowed"]);
    expect(audits[0]?.detail).toMatchObject({
      hosts: ["files.slack.com", "api.github.com"],
      scope: "always",
      outcome: "refused",
      fallback: "refused",
    });
  });

  it("「一直允许」 applied after the ask closed: audited as late, 409 saying what the device allows", async () => {
    let now = POLICY;
    const machine = await connect(() => undefined);
    const a = await ask();
    const pending = decide(a.id, {
      decision: "approve",
      scope: "always",
      hosts: ["files.slack.com"],
    });
    const op = (await machine.next((f) => f.type === "req" && f.op === "policy")) as KernelReq;
    // a reply, the expiry or a stop closes the ask while the device applies the change
    await sql`UPDATE capybara.approvals SET status = 'cancelled', decided_at = now()
      WHERE id = ${a.id}`.execute(raw);
    now = { ...now, allowedDomains: [...now.allowedDomains, "files.slack.com"] };
    machine.respond(op.id, { ok: true, result: { policy: now } });
    const res = await pending;
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: {
        code: "approval.already_decided",
        message: "The device now allows files.slack.com; the request had already closed.",
      },
    });
    expect((await row(a.id)).status).toBe("cancelled");
    const audits = await networkAudits(s.deviceId);
    expect(audits.map((x) => x.action)).toEqual([
      "device.policy_changed",
      "device.network_allowed",
    ]);
    expect(audits[1]?.detail).toMatchObject({
      approvalId: a.id,
      hosts: ["files.slack.com"],
      scope: "always",
      outcome: "always",
      late: true,
    });
  });

  it("a device without remote grants is asked once only; always → 409 approval.scope_not_allowed", async () => {
    const a = await ask({ scopes: ["once"] });
    const res = await decide(a.id, { decision: "approve", scope: "always" });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe(
      "approval.scope_not_allowed",
    );
    expect((await row(a.id)).status).toBe("pending");
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
