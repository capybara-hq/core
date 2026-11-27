import { randomUUID } from "node:crypto";
import type { PushMessage } from "@capybara-hq/plugin-sdk";
import {
  fakeExtensionEntry,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { getQueueToken } from "@nestjs/bullmq";
import type { Queue } from "bullmq";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AutomationRunTracker } from "../../src/automations/run-tracker.js";
import type { KernelConfig } from "../../src/config/schema.js";
import { EventLog } from "../../src/conversations/event-log.js";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { KernelConfigService } from "../../src/infra/config/kernel-config.service.js";
import { KernelDb } from "../../src/infra/database/kernel-db.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import { OutboxService } from "../../src/infra/outbox/outbox.service.js";
import { PushFanout } from "../../src/push/fanout.js";
import {
  automationRunEventId,
  conversationEventId,
  PUSH_QUEUE,
  type PushFanoutData,
  pushFanoutJobId,
} from "../../src/push/jobs.js";
import { PushPreferencesService } from "../../src/push/preferences.service.js";
import { PushOwed } from "../../src/push/push-owed.js";
import { PushTokenStore } from "../../src/push/token-store.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createAgent,
  createConv,
  createOrgWithProviders,
  PW,
  postMessage,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
  waitFor,
  waitForTerminal,
} from "../helpers/runs.js";

/**
 * Push triggers and fanout (mobile app spec §9.4, plan task C7): a trigger event owes a
 * `push-fanout` in its own transaction; the fanout resolves recipients when it runs (membership,
 * account status, org liveness, pending asks: review focus 1 and 2) and owes one `push-deliver`
 * per registration, rendered in its locale. Resolution cases seed the event row directly (no
 * fanout owed) and call `PushFanout.run` themselves, so a change between event and fanout is
 * deterministic; deliveries are observed on the `fake-push` probe by collapse id (the event id).
 */

const ORIGIN = "https://cap.example";

let pgc: TestContainer;
let rd: TestContainer;
let k: TestKernel;
let cfg: KernelConfig;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let queue: Queue;
let ownerReq: Req;
let orgId: string;
let agentId: string;
const ids: Record<string, string> = {};

/** The fake's in-process record of send attempts. */
function sends(): { registrationId: string; message: PushMessage }[] {
  const g = globalThis as {
    __fakePush?: { sends: { registrationId: string; message: PushMessage }[] };
  };
  g.__fakePush ??= { sends: [] };
  return g.__fakePush.sends;
}
const sendsOf = (eventId: string) => sends().filter((s) => s.message.collapseId === eventId);

/** Waits until `n` sends of `eventId` arrived; returns them by registration id. */
async function delivered(eventId: string, n: number) {
  await waitFor(async () => sendsOf(eventId).length >= n, 20_000, `${n} sends of ${eventId}`);
  return new Map(sendsOf(eventId).map((s) => [s.registrationId, s.message]));
}

const fanout = () => k.app.get(PushFanout, { strict: false });
const inTx = <T>(fn: () => Promise<T>) => k.app.get(TransactionHost).run(fn);

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  cfg = runConfig(
    { pg: pgc.url, redis: rd.url },
    {
      extensions: [MODEL_FAKE, fakeExtensionEntry("fake-push")],
      http: { port: 0, publicUrl: `${ORIGIN}/` },
    },
  );
  k = await startKernel(cfg);
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  queue = k.app.get<Queue>(getQueueToken(PUSH_QUEUE), { strict: false });
  const accounts = accountsFor(db);
  for (const login of ["owner", "admin1", "admin2", "member1", "other"]) {
    ids[login] = (await accounts.createLocal({ login, password: PW, displayName: login })).id;
  }
  ownerReq = await session(k, "owner");
  orgId = await createOrgWithProviders(k, ownerReq);
  agentId = await createAgent(ownerReq, orgId);
  await member(orgId, ids.admin1 as string, "admin");
  await member(orgId, ids.admin2 as string, "admin");
  await member(orgId, ids.member1 as string, "member");
  // `other` owns a second org and is not a member of the first
  await createOrgWithProviders(k, await session(k, "other"), "Other");
  for (const login of Object.keys(ids)) {
    ids[`reg-${login}`] = await register(ids[login] as string, login === "admin2" ? "zh" : "en");
  }
});
afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

async function member(org: string, accountId: string, role: "admin" | "member") {
  await db.insertInto("memberships").values({ org_id: org, account_id: accountId, role }).execute();
}

/** A registration of `accountId` with an ordinary (delivered) token; returns its id. */
async function register(accountId: string, locale: "en" | "zh"): Promise<string> {
  const id = randomUUID();
  const sealed = k.app.get(PushTokenStore).seal(id, `ok-${id}`);
  await db
    .insertInto("push_registrations")
    .values({
      id,
      account_id: accountId,
      session_id: null,
      platform: "ios",
      app_id: "com.example.app",
      provider: "fake-push",
      token_hash: sealed.tokenHash,
      master_key_id: sealed.masterKeyId,
      token_ciphertext: sealed.ciphertext,
      locale,
      device_name: "Phone",
    })
    .execute();
  return id;
}

/** A conversation row of `ownerId` in `org` (no event, no run). */
async function seedConv(
  ownerId: string,
  opts: { org?: string; kind?: "chat" | "subagent" | "eval"; parent?: string; title?: string } = {},
): Promise<string> {
  const id = randomUUID();
  await db
    .insertInto("conversations")
    .values({
      id,
      org_id: opts.org ?? orgId,
      agent_id: agentId,
      account_id: ownerId,
      kind: opts.kind ?? "chat",
      parent_conversation_id: opts.parent ?? null,
      title: opts.title ?? null,
      source: opts.kind === "subagent" ? "subagent" : "web",
    } as never)
    .execute();
  return id;
}

async function seedRun(convId: string, triggerId: string, automationRunId?: string) {
  const id = randomUUID();
  await db
    .insertInto("runs")
    .values({
      id,
      conversation_id: convId,
      trigger_account_id: triggerId,
      status: "waiting",
      agent_version: 1,
      trigger_seq: 0,
      automation_run_id: automationRunId ?? null,
    })
    .execute();
  return id;
}

/** Writes one event row directly (no fanout owed); returns the fanout's data. */
async function seedEvent(
  convId: string,
  type: string,
  payload: unknown,
  runId: string | null,
): Promise<PushFanoutData> {
  const { last_seq } = await db
    .updateTable("conversations")
    .set({ last_seq: sql`last_seq + 1` })
    .where("id", "=", convId)
    .returning("last_seq")
    .executeTakeFirstOrThrow();
  const seq = Number(last_seq);
  await db
    .insertInto("conversation_events")
    .values({
      conversation_id: convId,
      seq,
      type: type as never,
      run_id: runId,
      idem_key: null,
      payload: JSON.stringify(payload),
    })
    .execute();
  return {
    eventId: conversationEventId(convId, seq),
    source: { kind: "conversation", conversationId: convId, seq },
  };
}

async function seedApproval(
  convId: string,
  runId: string,
  who: { requestedFor?: string; approverRole?: "admin" | "member" },
  org = orgId,
): Promise<string> {
  const id = randomUUID();
  await db
    .insertInto("approvals")
    .values({
      id,
      org_id: org,
      conversation_id: convId,
      run_id: runId,
      call_id: randomUUID(),
      attempt: 1,
      tool_key: "Bash",
      spec_hash: "spec",
      connector_id: null,
      requested_for: who.requestedFor ?? null,
      approver_role: who.approverRole ?? null,
      scope: null,
      decided_by: null,
      expires_at: new Date(Date.now() + 3_600_000),
    })
    .execute();
  return id;
}

const finished = { reason: "completed", consumedUpToSeq: 0 };

/** The outbox rows of `jobId` visible in the transaction in context. */
const outboxRows = (jobId: string) =>
  k.app
    .get(KernelDb)
    .db.selectFrom("outbox")
    .select(["job_name", "data", "org_id"])
    .where("job_id", "=", jobId)
    .execute();

describe("owed in the event's transaction", () => {
  it("a completed chat run owes its fanout; each registration of the owner gets one message in its locale", async () => {
    // admin2 owns this conversation: a zh registration
    const admin2 = await session(k, "admin2");
    const conv = await createConv(admin2, orgId, agentId);
    await postMessage(admin2, orgId, conv, "echo:hello");
    const [end] = await waitForTerminal(db, conv);
    expect(end?.type).toBe("run_finished");
    const eventId = conversationEventId(conv, end?.seq as number);
    const job = await waitFor(
      async () => {
        const j = await queue.getJob(pushFanoutJobId(eventId));
        // finishedOn and returnvalue come from the same read (isCompleted() would be a second one)
        return j?.finishedOn !== undefined ? j : null;
      },
      20_000,
      "fanout job completed",
    );
    expect(job.data).toEqual({
      eventId,
      source: { kind: "conversation", conversationId: conv, seq: end?.seq },
    });
    expect(job.returnvalue).toBe(1);
    const got = await delivered(eventId, 1);
    expect([...got.keys()]).toEqual([ids["reg-admin2"]]);
    expect(got.get(ids["reg-admin2"] as string)).toEqual({
      title: "Helper",
      body: "已完成",
      path: `/chat/${conv}?org=${orgId}`,
      threadId: conv,
      collapseId: eventId,
      origin: ORIGIN,
    });
  });

  it("the outbox row is written by the append's own transaction", async () => {
    const conv = await seedConv(ids.member1 as string);
    const runId = await seedRun(conv, ids.member1 as string);
    await inTx(async () => {
      const [e] = await k.app
        .get(EventLog)
        .appendIn(conv, [{ type: "run_finished", runId, payload: finished }]);
      const eventId = conversationEventId(conv, e?.seq as number);
      expect(await outboxRows(pushFanoutJobId(eventId))).toEqual([
        {
          job_name: "push-fanout",
          data: {
            eventId,
            source: { kind: "conversation", conversationId: conv, seq: e?.seq },
          },
          org_id: orgId,
        },
      ]);
    });
  });

  it("an eval conversation writes nothing", async () => {
    const conv = await seedConv(ids.member1 as string, { kind: "eval" });
    const runId = await seedRun(conv, ids.member1 as string);
    await inTx(async () => {
      const [e] = await k.app
        .get(EventLog)
        .appendIn(conv, [{ type: "run_finished", runId, payload: finished }]);
      const eventId = conversationEventId(conv, e?.seq as number);
      expect(await outboxRows(pushFanoutJobId(eventId))).toEqual([]);
    });
  });

  it("with no push-provider loaded nothing is written", async () => {
    const owed = k.app.get(PushOwed, { strict: false });
    const none = new PushOwed(
      k.app.get(OutboxService),
      { any: () => false },
      k.app.get(TransactionHost),
    );
    const conv = await seedConv(ids.member1 as string);
    const event = {
      conversationId: conv,
      seq: 1,
      runId: null,
      createdAt: new Date(),
      type: "run_finished",
      payload: finished,
    } as ConversationEvent;
    const jobId = pushFanoutJobId(conversationEventId(conv, 1));
    await inTx(async () => {
      await none.oweIn(conv, orgId, "chat", [event]);
      expect(await outboxRows(jobId)).toEqual([]);
      // the control: the kernel's own, with fake-push loaded
      await owed.oweIn(conv, orgId, "chat", [event]);
      expect(await outboxRows(jobId)).toHaveLength(1);
      throw new RollbackSignal();
    }).catch((e) => {
      if (!(e instanceof RollbackSignal)) throw e;
    });
  });
});

class RollbackSignal extends Error {}

describe("recipients when the fanout runs", () => {
  it("the owner switched replies off: no job", async () => {
    const conv = await seedConv(ids.member1 as string);
    const runId = await seedRun(conv, ids.member1 as string);
    const data = await seedEvent(conv, "run_finished", finished, runId);
    const prefs = k.app.get(PushPreferencesService, { strict: false });
    await prefs.set(ids.member1 as string, { replies: false });
    try {
      expect(await fanout().run(data)).toBe(0);
    } finally {
      await prefs.set(ids.member1 as string, { replies: true });
    }
  });

  it("an approval escalated to admin reaches the org's admins, not its initiator, a member or another org", async () => {
    const conv = await seedConv(ids.admin1 as string, { title: "Deploy check" });
    const runId = await seedRun(conv, ids.admin1 as string);
    const approvalId = await seedApproval(conv, runId, { approverRole: "admin" });
    const data = await seedEvent(conv, "approval_requested", { approvalId }, runId);
    // the org's owner and the other admin; not admin1 (the initiator), member1 or other
    expect(await fanout().run(data)).toBe(2);
    const got = await delivered(data.eventId, 2);
    expect([...got.keys()].sort()).toEqual([ids["reg-owner"], ids["reg-admin2"]].sort());
    expect(got.get(ids["reg-owner"] as string)).toMatchObject({
      title: "Helper",
      body: "needs your approval",
    });
    expect(got.get(ids["reg-admin2"] as string)?.body).toBe("需要你的审批");
    // previews are off by default: the conversation title never leaves
    expect(JSON.stringify([...got.values()])).not.toContain("Deploy check");
  });

  it("an approval decided before the fanout runs: no job", async () => {
    const conv = await seedConv(ids.member1 as string);
    const runId = await seedRun(conv, ids.member1 as string);
    const approvalId = await seedApproval(conv, runId, { requestedFor: ids.member1 as string });
    const data = await seedEvent(conv, "approval_requested", { approvalId }, runId);
    await db
      .updateTable("approvals")
      .set({ status: "approved" })
      .where("id", "=", approvalId)
      .execute();
    expect(await fanout().run(data)).toBe(0);
  });

  it("an approval naming an account of another org reaches nobody", async () => {
    const conv = await seedConv(ids.member1 as string);
    const runId = await seedRun(conv, ids.member1 as string);
    const approvalId = await seedApproval(conv, runId, { requestedFor: ids.other as string });
    const data = await seedEvent(conv, "approval_requested", { approvalId }, runId);
    expect(await fanout().run(data)).toBe(0);
  });

  it("a question goes to the run's trigger account while pending", async () => {
    const conv = await seedConv(ids.owner as string);
    const runId = await seedRun(conv, ids.member1 as string);
    const questionId = randomUUID();
    await db
      .insertInto("questions")
      .values({
        id: questionId,
        org_id: orgId,
        conversation_id: conv,
        run_id: runId,
        call_id: randomUUID(),
        spec: JSON.stringify({}),
        expires_at: new Date(Date.now() + 3_600_000),
      })
      .execute();
    const data = await seedEvent(conv, "question_asked", { questionId }, runId);
    expect(await fanout().run(data)).toBe(1);
    const got = await delivered(data.eventId, 1);
    expect(got.get(ids["reg-member1"] as string)?.body).toBe("has a question for you");
    await db
      .updateTable("questions")
      .set({ status: "answered" })
      .where("id", "=", questionId)
      .execute();
    const again = await seedEvent(conv, "question_asked", { questionId }, runId);
    expect(await fanout().run(again)).toBe(0);
  });

  it("the owner removed from the org between event and fanout: no job", async () => {
    const leaver = (
      await accountsFor(db).createLocal({ login: "leaver", password: PW, displayName: "L" })
    ).id;
    await member(orgId, leaver, "member");
    await register(leaver, "en");
    const conv = await seedConv(leaver);
    const runId = await seedRun(conv, leaver);
    const data = await seedEvent(conv, "run_finished", finished, runId);
    await db
      .deleteFrom("memberships")
      .where("org_id", "=", orgId)
      .where("account_id", "=", leaver)
      .execute();
    expect(await fanout().run(data)).toBe(0);
  });

  it("a disabled owner: no job", async () => {
    const gone = (
      await accountsFor(db).createLocal({ login: "gone", password: PW, displayName: "G" })
    ).id;
    await member(orgId, gone, "member");
    await register(gone, "en");
    const conv = await seedConv(gone);
    const runId = await seedRun(conv, gone);
    const data = await seedEvent(conv, "run_finished", finished, runId);
    await db.updateTable("accounts").set({ status: "disabled" }).where("id", "=", gone).execute();
    expect(await fanout().run(data)).toBe(0);
  });

  it("a deleted org: no job", async () => {
    const doomed = await createOrgWithProviders(k, ownerReq, "Doomed");
    const conv = await seedConv(ids.owner as string, { org: doomed });
    const runId = await seedRun(conv, ids.owner as string);
    const data = await seedEvent(conv, "run_finished", finished, runId);
    await db.updateTable("orgs").set({ deleted_at: new Date() }).where("id", "=", doomed).execute();
    expect(await fanout().run(data)).toBe(0);
  });

  it("a connect request goes to the run's trigger account", async () => {
    const conv = await seedConv(ids.owner as string);
    const runId = await seedRun(conv, ids.member1 as string);
    const data = await seedEvent(
      conv,
      "connection_required",
      { step: 0, callId: "c1", appId: "a1", appName: "Docs" },
      runId,
    );
    expect(await fanout().run(data)).toBe(1);
    const got = await delivered(data.eventId, 1);
    expect([...got.keys()]).toEqual([ids["reg-member1"]]);
    expect(got.get(ids["reg-member1"] as string)?.body).toBe("needs you to connect an account");
  });

  it("a sub-agent's finish in the root log reaches the root's owner", async () => {
    const root = await seedConv(ids.member1 as string);
    const runId = await seedRun(root, ids.owner as string);
    const data = await seedEvent(root, "subagent_finished", { status: "completed" }, runId);
    expect(await fanout().run(data)).toBe(1);
    const got = await delivered(data.eventId, 1);
    expect([...got.keys()]).toEqual([ids["reg-member1"]]);
    expect(got.get(ids["reg-member1"] as string)).toMatchObject({
      body: "a sub-agent finished",
      path: `/chat/${root}?org=${orgId}`,
      threadId: root,
    });
  });

  it("a background task a person (or a deletion) stopped pushes nothing", async () => {
    const conv = await seedConv(ids.member1 as string);
    const runId = await seedRun(conv, ids.member1 as string);
    const data = await seedEvent(
      conv,
      "background_task_finished",
      { status: "stopped", stoppedBy: "person" },
      runId,
    );
    expect(await fanout().run(data)).toBe(0);
  });

  it("previews titles: the conversation title leads the body", async () => {
    const config = k.app.get(KernelConfigService);
    await config.apply({ ...cfg, push: { previews: "titles" } });
    expect(config.get().push.previews).toBe("titles");
    try {
      const conv = await seedConv(ids.member1 as string, { title: "Deploy check" });
      const runId = await seedRun(conv, ids.member1 as string);
      const data = await seedEvent(conv, "run_finished", finished, runId);
      expect(await fanout().run(data)).toBe(1);
      const got = await delivered(data.eventId, 1);
      expect(got.get(ids["reg-member1"] as string)?.body).toBe("Deploy check: finished");
    } finally {
      await config.apply(cfg);
    }
    expect(config.get().push.previews).toBe("off");
  });

  it("a sub-agent's approval links to the root with the child", async () => {
    const root = await seedConv(ids.member1 as string);
    const child = await seedConv(ids.member1 as string, { kind: "subagent", parent: root });
    const runId = await seedRun(child, ids.member1 as string);
    const approvalId = await seedApproval(child, runId, { requestedFor: ids.member1 as string });
    const data = await seedEvent(child, "approval_requested", { approvalId }, runId);
    expect(await fanout().run(data)).toBe(1);
    const got = await delivered(data.eventId, 1);
    expect(got.get(ids["reg-member1"] as string)).toMatchObject({
      path: `/chat/${root}?org=${orgId}&subagent=${child}`,
      threadId: root,
    });
  });

  it("a sub-agent under an eval root pushes nothing", async () => {
    const root = await seedConv(ids.member1 as string, { kind: "eval" });
    const child = await seedConv(ids.member1 as string, { kind: "subagent", parent: root });
    const runId = await seedRun(child, ids.member1 as string);
    const approvalId = await seedApproval(child, runId, { requestedFor: ids.member1 as string });
    const data = await seedEvent(child, "approval_requested", { approvalId }, runId);
    expect(await fanout().run(data)).toBe(0);
  });

  it("a sub-agent's run end pushes no reply; its background finish reaches the root's owner", async () => {
    const root = await seedConv(ids.member1 as string);
    const child = await seedConv(ids.member1 as string, { kind: "subagent", parent: root });
    const runId = await seedRun(child, ids.member1 as string);
    expect(await fanout().run(await seedEvent(child, "run_finished", finished, runId))).toBe(0);
    const bg = await seedEvent(child, "background_task_finished", { status: "completed" }, runId);
    expect(await fanout().run(bg)).toBe(1);
    expect((await delivered(bg.eventId, 1)).get(ids["reg-member1"] as string)?.body).toBe(
      "a background task ended",
    );
  });

  it("run() twice owes no extra job", async () => {
    const conv = await seedConv(ids.member1 as string);
    const runId = await seedRun(conv, ids.member1 as string);
    const data = await seedEvent(conv, "run_failed", { error: { code: "x", message: "m" } }, runId);
    expect(await fanout().run(data)).toBe(1);
    await delivered(data.eventId, 1);
    // the first rows are delivered: a repeat inserts rows again, BullMQ swallows the known ids
    await fanout().run(data);
    await waitFor(
      async () => {
        const left = await db
          .selectFrom("outbox")
          .select("id")
          .where("job_id", "like", `push-${data.eventId}-%`)
          .execute();
        return left.length === 0;
      },
      20_000,
      "repeat rows dispatched",
    );
    await waitFor(
      async () => (await queue.getJobCounts("waiting", "active", "delayed")).waiting === 0,
      20_000,
      "queue idle",
    );
    const counts = await queue.getJobCounts("waiting", "active", "delayed");
    expect(counts).toEqual({ waiting: 0, active: 0, delayed: 0 });
    expect(sendsOf(data.eventId)).toHaveLength(1);
  });
});

describe("automation runs", () => {
  /** A task of member1 with one running task run whose kernel run is `runId`. */
  async function taskRun(name: string) {
    const taskId = randomUUID();
    await db
      .insertInto("automations")
      .values({
        id: taskId,
        org_id: orgId,
        account_id: ids.member1 as string,
        agent_id: agentId,
        name,
        prompt: "hello",
        trigger: JSON.stringify({ kind: "once", at: "2030-01-01T00:00:00Z" }),
        mode: "new",
      })
      .execute();
    const conv = await seedConv(ids.member1 as string);
    const taskRunId = randomUUID();
    const runId = await seedRun(conv, ids.member1 as string, undefined);
    await db
      .insertInto("automation_runs")
      .values({
        id: taskRunId,
        automation_id: taskId,
        org_id: orgId,
        scheduled_for: new Date(),
        trigger_key: new Date().toISOString(),
        fired_at: new Date(),
        conversation_id: conv,
        run_id: runId,
        status: "running",
      })
      .execute();
    await db
      .updateTable("runs")
      .set({ automation_run_id: taskRunId })
      .where("id", "=", runId)
      .execute();
    return { taskId, taskRunId, runId, conv };
  }

  it.each([
    ["completed", "your automation ran"],
    ["failed", "your automation failed"],
  ] as const)(
    "a %s run owes push-fanout-automation-<taskRunId> to the task's owner",
    async (outcome, body) => {
      const t = await taskRun(`Nightly ${outcome}`);
      await k.app.get(AutomationRunTracker, { strict: false }).onRunFinished(t.runId, outcome);
      const eventId = automationRunEventId(t.taskRunId);
      const got = await delivered(eventId, 1);
      expect(got.get(ids["reg-member1"] as string)).toEqual({
        title: `Nightly ${outcome}`,
        body,
        path: `/chat/${t.conv}?org=${orgId}`,
        threadId: `automation-${t.taskId}`,
        collapseId: eventId,
        origin: ORIGIN,
      });
      // its kernel run's end pushes no reply (the automation's push stands for it)
      expect(await fanout().run(await seedEvent(t.conv, "run_finished", finished, t.runId))).toBe(
        0,
      );
    },
  );
  it("a deleted task's run pushes nothing", async () => {
    const t = await taskRun("Deleted");
    await db
      .updateTable("automation_runs")
      .set({ status: "completed" })
      .where("id", "=", t.taskRunId)
      .execute();
    await db
      .updateTable("automations")
      .set({ deleted_at: new Date() })
      .where("id", "=", t.taskId)
      .execute();
    expect(
      await fanout().run({
        eventId: automationRunEventId(t.taskRunId),
        source: { kind: "automation", taskRunId: t.taskRunId },
      }),
    ).toBe(0);
  });
});
