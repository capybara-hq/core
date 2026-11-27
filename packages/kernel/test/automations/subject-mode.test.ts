import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { TriggerSubject } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { SchedulerRegistry } from "@nestjs/schedule";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readAutomationSettings } from "../../src/automations/effective-settings.js";
import { subjectKey } from "../../src/automations/events/guards.js";
import { AutomationFirer } from "../../src/automations/fire.js";
import { AUTOMATION_SCAN_JOB } from "../../src/automations/job-ids.js";
import { AutomationStore } from "../../src/automations/store.js";
import type { Automation, TaskRun } from "../../src/automations/types.js";
import { taskGrantsRunOf, unattendedRunOf } from "../../src/automations/unattended.js";
import { ConversationsService } from "../../src/conversations/conversations.service.js";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { KernelConfigService } from "../../src/infra/config/kernel-config.service.js";
import { OrgSettingsService } from "../../src/orgs/settings.service.js";
import { openBarrier, scriptRules } from "../fixtures/plugins/model-script/index.js";
import { builtinsOff } from "../helpers/disabled-tools.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  enableModelProviders,
  eventsOf,
  PW,
  type Req,
  runConfig,
  runsOf,
  session,
  startKernel,
  type TestKernel,
  waitFor,
} from "../helpers/runs.js";

/**
 * The fire path of event automations (collaboration spec §4.5, §4.6): a `subject` run creates the
 * subject's conversation and maps it (`automation_conversations`, `conversations.subject`), later
 * runs of the subject queue into it, the message carries the event marker and the request renders
 * the event block from it, the run records its automation run and last event, and the run is
 * unattended with the automation's `unattended_ask` over the org's default. Runs are stored as the
 * coalescer stores them (deliveries linked to a run keyed by the first event) and fired directly.
 */

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${name}/index.ts`, import.meta.url));
const MODEL_SCRIPT = fixture("model-script");
const PLUGIN = "fake-trigger-source";

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;
let owner: Req;
let ownerId: string;
let orgId: string;
let agentId: string;
const store = new AutomationStore();

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensions: [MODEL_FAKE, MODEL_SCRIPT],
        auth: { cookieSecure: false },
      },
    ),
  );
  // the tests fire runs themselves: no scan races them
  k.app.get(SchedulerRegistry).getCronJob(AUTOMATION_SCAN_JOB).stop();
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  ownerId = (
    await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "Owner" })
  ).id;
  owner = await session(k, "owner");
  const org = await owner({ method: "POST", url: "/api/v1/orgs", payload: { name: "Acme" } });
  orgId = (org.json() as { org: { id: string } }).org.id;
  await enableModelProviders(k, orgId);
  const res = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Helper",
        instructions: "Be helpful.",
        model: { provider: "model-script", model: "script-1" },
        disabledTools: builtinsOff(),
      },
      visibility: "org",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  agentId = (res.json() as { agent: { id: string } }).agent.id;
});

afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

const firer = () => k.app.get(AutomationFirer);

/** An active `subject`-mode event automation of the owner, stored directly. */
async function automation(prompt = "handle it"): Promise<Automation> {
  return store.insertTask(db, {
    id: randomUUID(),
    orgId,
    accountId: ownerId,
    agentId,
    name: "Triage",
    prompt,
    trigger: { kind: "event", source: PLUGIN, types: ["item.created"], filter: [] },
    mode: "subject",
    conversationId: null,
    chat: null,
    model: null,
    effort: null,
    deviceId: null,
    status: "active",
    nextRunAt: null,
    jitterSeconds: 0,
    expiresAt: null,
  });
}

let clock = Date.now() - 3_600_000;

/**
 * A pending event run of `t` over `events` (in this order), as the coalescer stores it: the
 * events, their deliveries linked to the run, the run keyed by the first event.
 */
async function eventRun(
  t: Automation,
  subject: TriggerSubject,
  summaries: string[],
): Promise<{ run: TaskRun; eventIds: string[] }> {
  const eventIds: string[] = [];
  for (const summary of summaries) {
    const id = randomUUID();
    clock += 1000;
    await db
      .insertInto("trigger_events")
      .values({
        id,
        org_id: orgId,
        plugin: PLUGIN,
        type: "item.created",
        subject: JSON.stringify(subject),
        facts: "{}",
        summary,
        dedupe_key: id,
        state: "dispatched",
        created_at: new Date(clock),
      })
      .execute();
    eventIds.push(id);
  }
  const run = await store.insertRun(db, {
    id: randomUUID(),
    taskId: t.id,
    orgId,
    scheduledFor: null,
    triggerKey: eventIds[0] as string,
    trial: false,
  });
  if (!run) throw new Error("event key taken");
  await db
    .insertInto("automation_event_deliveries")
    .values(
      eventIds.map((id) => ({
        org_id: orgId,
        automation_id: t.id,
        event_id: id,
        subject_key: subjectKey(subject),
        automation_run_id: run.id,
      })),
    )
    .execute();
  return { run, eventIds };
}

async function runOf(id: string): Promise<TaskRun> {
  const r = await store.updateRun(db, id, {});
  if (!r) throw new Error("no task run");
  return r;
}

const settled = (id: string, timeoutMs = 20_000) =>
  waitFor(
    async () => {
      const r = await runOf(id);
      return r.status !== "pending" && r.status !== "running" && r;
    },
    timeoutMs,
    `task run ${id} settled`,
  );

const mappingOf = (taskId: string, subject: TriggerSubject) =>
  db
    .selectFrom("automation_conversations")
    .selectAll()
    .where("automation_id", "=", taskId)
    .where("subject_kind", "=", subject.kind)
    .where("subject_id", "=", subject.id)
    .executeTakeFirst();

const conversationsOf = (taskId: string) =>
  db
    .selectFrom("conversations")
    .select(["id", "subject", "deleted_at"])
    .where("automation_id", "=", taskId)
    .orderBy("created_at")
    .execute();

type UserMessage = Extract<ConversationEvent, { type: "user_message" }>;
const userMessages = async (conv: string): Promise<UserMessage[]> =>
  (await eventsOf(db, conv)).filter((e): e is UserMessage => e.type === "user_message");

const subject = (id: string, title = `Item ${id}`): TriggerSubject => ({
  kind: "item",
  id,
  title,
  url: `https://items.example/${id}`,
});

describe("subject mode", () => {
  it("first event creates the subject conversation and links it", async () => {
    scriptRules([]);
    const t = await automation();
    const s = subject("A-1", "Fix login");
    const { run, eventIds } = await eventRun(t, s, ["Alice opened it."]);
    await firer().fire(run.id);

    const mapping = await mappingOf(t.id, s);
    expect(mapping).toBeDefined();
    const convs = await conversationsOf(t.id);
    expect(convs).toHaveLength(1);
    const conv = convs[0]?.id as string;
    expect(mapping?.conversation_id).toBe(conv);
    expect(mapping?.org_id).toBe(orgId);
    // the subject without its link: the link may change, the conversation stays the subject's
    expect(convs[0]?.subject).toEqual({
      source: PLUGIN,
      kind: "item",
      id: "A-1",
      title: "Fix login",
    });
    expect(await runOf(run.id)).toMatchObject({ conversationId: conv });
    expect((await settled(run.id)).status).toBe("completed");

    const [msg] = await userMessages(conv);
    expect(msg?.payload.content).toEqual([{ type: "text", text: "handle it" }]);
    expect(msg?.payload.automationEvent).toEqual({
      automationId: t.id,
      automationRunId: run.id,
      automationName: "Triage",
      source: PLUGIN,
      events: [
        {
          id: eventIds[0],
          type: "item.created",
          subject: {
            kind: "item",
            id: "A-1",
            title: "Fix login",
            url: "https://items.example/A-1",
          },
          summary: "Alice opened it.",
        },
      ],
    });
    expect(msg?.payload.schedule).toBeUndefined();

    // the conversation view lists its subject
    const res = await owner({ method: "GET", url: `/api/v1/orgs/${orgId}/conversations/${conv}` });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { conversation: { subject: unknown } }).conversation.subject).toEqual({
      source: PLUGIN,
      kind: "item",
      id: "A-1",
      title: "Fix login",
    });
  });

  it("second event queues into the subject conversation", async () => {
    scriptRules([
      {
        when: { lastUserIncludes: "HOLD-first" },
        reply: { text: "first done", barrier: { name: "first", count: 99, timeoutMs: 30_000 } },
      },
    ]);
    const t = await automation();
    const s = subject("B-1");
    const first = await eventRun(t, s, ["HOLD-first"]);
    await firer().fire(first.run.id);
    const conv = (await mappingOf(t.id, s))?.conversation_id as string;
    await waitFor(async () => (await runsOf(db, conv)).some((r) => r.status === "running"));

    // another subject runs side by side: no overlap skip across subjects
    const other = await eventRun(t, subject("B-2"), ["another item"]);
    await firer().fire(other.run.id);
    expect((await settled(other.run.id)).status).toBe("completed");
    expect((await mappingOf(t.id, subject("B-2")))?.conversation_id).not.toBe(conv);

    const second = await eventRun(t, s, ["second change"]);
    await firer().fire(second.run.id);
    const queued = await db
      .selectFrom("conversation_queue")
      .select(["client_message_id", "automation_event", "schedule"])
      .where("conversation_id", "=", conv)
      .execute();
    expect(queued).toHaveLength(1);
    expect(queued[0]?.automation_event).toMatchObject({
      automationRunId: second.run.id,
      events: [{ id: second.eventIds[0] }],
    });
    expect(queued[0]?.schedule).toBeNull();
    expect(await runOf(second.run.id)).toMatchObject({ status: "pending", conversationId: conv });
    // the running run did not absorb it
    expect(await userMessages(conv)).toHaveLength(1);

    openBarrier("first");
    expect((await settled(first.run.id)).status).toBe("completed");
    const done = await settled(second.run.id);
    expect(done.status).toBe("completed");
    const msgs = await userMessages(conv);
    expect(msgs.map((m) => m.payload.automationEvent?.automationRunId)).toEqual([
      first.run.id,
      second.run.id,
    ]);
    // one conversation per subject: the second run made none
    expect((await conversationsOf(t.id)).map((c) => c.id).filter((id) => id === conv)).toHaveLength(
      1,
    );
    expect(await conversationsOf(t.id)).toHaveLength(2);
    scriptRules([]);
  });

  it("run carries trigger_event_id and automation_run_id", async () => {
    scriptRules([
      {
        when: { lastUserIncludes: "Reported by an extension" },
        reply: { text: "saw the event block" },
      },
    ]);
    const t = await automation();
    const s = subject("C-1", "Coalesced item");
    const { run, eventIds } = await eventRun(t, s, ["first change", "second change"]);
    await firer().fire(run.id);
    const done = await settled(run.id);
    expect(done.status).toBe("completed");
    const kernelRun = await db
      .selectFrom("runs")
      .select(["automation_run_id", "trigger_event_id", "conversation_id"])
      .where("id", "=", done.runId as string)
      .executeTakeFirstOrThrow();
    expect(kernelRun.automation_run_id).toBe(run.id);
    // the most recent cause of the coalesced events
    expect(kernelRun.trigger_event_id).toBe(eventIds[1]);

    const events = await eventsOf(db, kernelRun.conversation_id);
    const started = events.find((e) => e.type === "run_started");
    expect(started?.type === "run_started" && started.payload.trigger).toBe("automation_event");
    const [msg] = await userMessages(kernelRun.conversation_id);
    expect(msg?.payload.automationEvent?.events.map((e) => e.id)).toEqual(eventIds);
    // the model saw the block rendered from the marker
    const reply = events.find((e) => e.type === "assistant_message");
    expect(JSON.stringify(reply?.payload)).toContain("saw the event block");
    const call = events.find((e) => e.type === "model_call");
    expect(call?.type === "model_call" && call.payload.request.automationEventSeqs).toEqual([
      msg?.seq,
    ]);
    scriptRules([]);
  });

  it("event run is unattended with the automation's unattended_ask override", async () => {
    scriptRules([]);
    await k.app
      .get(OrgSettingsService)
      .update(orgId, { automations: { unattendedAsk: "fail" } }, ownerId);
    const config = k.app.get(KernelConfigService);
    expect((await readAutomationSettings(db, config, orgId)).unattendedAsk).toBe("fail");

    const t = await automation();
    await sql`UPDATE capybara.automations SET unattended_ask = 'wait' WHERE id = ${t.id}`.execute(
      raw,
    );
    const { run } = await eventRun(t, subject("D-1"), ["something happened"]);
    await firer().fire(run.id);
    const done = await settled(run.id);
    const runId = done.runId as string;
    expect(await unattendedRunOf(db, config, orgId, runId)).toMatchObject({
      taskId: t.id,
      taskRunId: run.id,
      trial: false,
      unattendedAsk: "wait",
    });
    expect(await taskGrantsRunOf(db, runId)).toMatchObject({ taskId: t.id, accountId: ownerId });

    // no override: the org's default
    await sql`UPDATE capybara.automations SET unattended_ask = NULL WHERE id = ${t.id}`.execute(
      raw,
    );
    expect(await unattendedRunOf(db, config, orgId, runId)).toMatchObject({
      unattendedAsk: "fail",
    });
  });

  it("a deleted or missing mapped conversation gets a new conversation and the mapping follows", async () => {
    scriptRules([]);
    const t = await automation();
    const s = subject("E-1");
    const first = await eventRun(t, s, ["first"]);
    await firer().fire(first.run.id);
    await settled(first.run.id);
    const old = (await mappingOf(t.id, s))?.conversation_id as string;
    const del = await owner({
      method: "DELETE",
      url: `/api/v1/orgs/${orgId}/conversations/${old}`,
    });
    expect(del.statusCode, del.body).toBeLessThan(300);

    const second = await eventRun(t, s, ["second"]);
    await firer().fire(second.run.id);
    expect((await settled(second.run.id)).status).toBe("completed");
    const fresh = (await mappingOf(t.id, s))?.conversation_id as string;
    expect(fresh).not.toBe(old);
    expect((await runOf(second.run.id)).conversationId).toBe(fresh);
    expect(
      (await userMessages(fresh)).map((m) => m.payload.automationEvent?.automationRunId),
    ).toEqual([second.run.id]);

    // the mapping names a conversation that no longer exists (no foreign key)
    await db
      .updateTable("automation_conversations")
      .set({ conversation_id: randomUUID() })
      .where("automation_id", "=", t.id)
      .execute();
    const third = await eventRun(t, s, ["third"]);
    await firer().fire(third.run.id);
    expect((await settled(third.run.id)).status).toBe("completed");
    const newest = (await mappingOf(t.id, s))?.conversation_id as string;
    expect([old, fresh]).not.toContain(newest);
    expect(
      await db.selectFrom("conversations").select("id").where("id", "=", newest).execute(),
    ).toHaveLength(1);
    const live = (await conversationsOf(t.id)).filter((c) => c.deleted_at === null);
    expect(live.map((c) => c.id).sort()).toEqual([fresh, newest].sort());
  });
  it("a recorded or mapped conversation with no message yet still takes the task's model and effort", async () => {
    scriptRules([]);
    const t = await automation();
    await db
      .updateTable("automations")
      .set({ model: JSON.stringify({ provider: "model-fake", model: "fake-1" }), effort: "high" })
      .where("id", "=", t.id)
      .execute();
    const empty = () =>
      k.app.get(ConversationsService).create(orgId, ownerId, agentId, {}, { source: "web" });

    // mapped: a start that created and mapped the conversation stopped before its message
    const mappedConv = await empty();
    const ms = subject("F-1");
    await db
      .insertInto("automation_conversations")
      .values({
        org_id: orgId,
        automation_id: t.id,
        subject_kind: ms.kind,
        subject_id: ms.id,
        conversation_id: mappedConv.id,
      })
      .execute();
    const a = await eventRun(t, ms, ["mapped"]);
    // recorded: the run already names its conversation (a retried start)
    const recordedConv = await empty();
    const b = await eventRun(t, subject("F-2"), ["recorded"]);
    await db
      .updateTable("automation_runs")
      .set({ conversation_id: recordedConv.id })
      .where("id", "=", b.run.id)
      .execute();

    for (const [run, conv] of [
      [a.run, mappedConv.id],
      [b.run, recordedConv.id],
    ] as const) {
      await firer().fire(run.id);
      await settled(run.id);
      expect((await runOf(run.id)).conversationId).toBe(conv);
      const events = await eventsOf(db, conv);
      const switched = events.find((e) => e.type === "model_switched");
      const message = events.find((e) => e.type === "user_message");
      expect(switched?.payload).toMatchObject({
        model: { provider: "model-fake", model: "fake-1" },
        effort: "high",
      });
      expect((switched?.seq ?? 0) < (message?.seq ?? 0)).toBe(true);
      const call = events.find((e) => e.type === "model_call");
      expect(call?.type === "model_call" && call.payload.model).toBe("fake-1");
    }

    // a later run of the subject switches nothing
    const later = await eventRun(t, ms, ["later"]);
    await firer().fire(later.run.id);
    await settled(later.run.id);
    expect(
      (await eventsOf(db, mappedConv.id)).filter((e) => e.type === "model_switched"),
    ).toHaveLength(1);
  });

  it("two runs of one new subject fired at once make one conversation and one mapping", async () => {
    scriptRules([]);
    const t = await automation();
    const s = subject("G-1");
    const first = await eventRun(t, s, ["first"]);
    const second = await eventRun(t, s, ["second"]);
    await Promise.all([firer().fire(first.run.id), firer().fire(second.run.id)]);
    await Promise.all([settled(first.run.id), settled(second.run.id)]);
    const convs = await conversationsOf(t.id);
    expect(convs).toHaveLength(1);
    const mappings = await db
      .selectFrom("automation_conversations")
      .select("conversation_id")
      .where("automation_id", "=", t.id)
      .execute();
    expect(mappings).toEqual([{ conversation_id: convs[0]?.id }]);
    expect((await runOf(first.run.id)).status).toBe("completed");
    expect((await runOf(second.run.id)).status).toBe("completed");
    expect(
      (await userMessages(convs[0]?.id as string))
        .map((m) => m.payload.automationEvent?.automationRunId)
        .sort(),
    ).toEqual([first.run.id, second.run.id].sort());
  });
});
