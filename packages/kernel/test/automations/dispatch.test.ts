import { randomUUID } from "node:crypto";
import type {
  EventFilter,
  TriggerEvent,
  TriggerSource,
  TriggerSubject,
} from "@capybara-hq/plugin-sdk";
import {
  fakeExtensionEntry,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { getQueueToken } from "@nestjs/bullmq";
import type { Queue } from "bullmq";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EventCoalescer } from "../../src/automations/events/coalesce.js";
import {
  TriggerDispatcher,
  TriggerSourceTimeout,
} from "../../src/automations/events/dispatcher.js";
import { coalesceJobId, subjectKey } from "../../src/automations/events/guards.js";
import { type AutomationInsert, AutomationStore } from "../../src/automations/store.js";
import type { Automation } from "../../src/automations/types.js";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { ExtensionPointDefaults } from "../../src/extensions/point-defaults.js";
import { withOrgScope } from "../../src/infra/database/org-scope.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import { OUTBOX_DISPATCH_FAILS } from "../../src/infra/outbox/outbox.dispatcher.js";
import { MAINTENANCE_QUEUE_NAME } from "../../src/runtime/maintenance-queue.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { drainOutbox } from "../helpers/outbox.js";
import {
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
  waitForTerminal,
} from "../helpers/runs.js";

/**
 * The trigger dispatcher and the coalescer (collaboration spec §4.3, §4.7): a stored event is
 * matched to the org's active event automations on its source and type (filter, self-trigger,
 * `visible()`), each delivery that opens a window for an (automation, subject) pair owes that
 * pair's delayed `automation-coalesce` job, and the flush turns the window into one run keyed by
 * its first event. The tests call the dispatcher and the coalescer directly while outbox adds to
 * the maintenance queue fail (`failDispatch`), so owed rows stay to be read; one test runs the
 * real queue end to end and promotes the delayed job instead of waiting for it. The last
 * describe is the whole path through the real queues: an automation made over HTTP, a second agent's
 * tool call emitting through `ctx.triggers.emit`, the coalesced run in the subject conversation.
 */

const PLUGIN = "fake-trigger-source";
const TOOL = `plugin__${PLUGIN}__emit_item_event`;
const ITEM: TriggerSubject = { kind: "item", id: "ITEM-1", title: "First item" };
const OTHER: TriggerSubject = { kind: "item", id: "ITEM-2", title: "Second item" };

let pgc: TestContainer;
let rd: TestContainer;
let k: TestKernel;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let owner: Req;
let ownerId: string;
let orgId: string;
let agentId: string;
let failDispatch = true;
let seq = 0;
const store = new AutomationStore();

interface Probe {
  visible?: string[];
  emit?: (e: TriggerEvent) => Promise<{ eventId: string; duplicate: boolean }>;
}
const probe = () => {
  const g = globalThis as { __fakeTriggerSource?: Probe };
  g.__fakeTriggerSource ??= {};
  return g.__fakeTriggerSource;
};

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensions: [MODEL_FAKE, fakeExtensionEntry(PLUGIN)],
        // the trigger source's deadline (a source that never answers fails the dispatch)
        tools: { timeoutMs: 1500 },
      },
    ),
    {
      overrides: [
        {
          provide: OUTBOX_DISPATCH_FAILS,
          useValue: (queue: string) => failDispatch && queue === MAINTENANCE_QUEUE_NAME,
        },
      ],
    },
  );
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
});

afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

async function newAgent(name: string): Promise<string> {
  const res = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name,
        instructions: "Work.",
        model: { provider: "model-fake", model: "fake-1" },
      },
      visibility: "org",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { agent: { id: string } }).agent.id;
}

beforeEach(async () => {
  failDispatch = true;
  delete probe().visible;
  await truncateTables(raw, "capybara.accounts, capybara.orgs, capybara.outbox");
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  owner = await session(k, "owner");
  orgId = await createOrgWithProviders(k, owner, "Acme");
  const on = await owner({
    method: "PUT",
    url: `/api/v1/orgs/${orgId}/extensions/${PLUGIN}`,
    payload: { enabled: true },
  });
  expect(on.statusCode, on.body).toBe(200);
  agentId = await newAgent("Watcher");
});

/** An active event automation of the owner on the fake source, stored directly. */
function automation(
  over: Partial<AutomationInsert> & { types?: string[]; filter?: EventFilter } = {},
): Promise<Automation> {
  const { types = ["item.created", "item.updated"], filter = [], ...rest } = over;
  return store.insertTask(db, {
    id: randomUUID(),
    orgId,
    accountId: ownerId,
    agentId,
    name: "Follow items",
    prompt: "Look at the item.",
    trigger: { kind: "event", source: PLUGIN, types, filter },
    mode: "new",
    conversationId: null,
    chat: null,
    model: null,
    effort: null,
    deviceId: null,
    status: "active",
    nextRunAt: null,
    jitterSeconds: 0,
    expiresAt: null,
    ...rest,
  });
}

/** Emits as the fake extension; returns the event id. */
async function emit(over: Partial<TriggerEvent> = {}): Promise<string> {
  const fn = probe().emit;
  if (!fn) throw new Error("fake-trigger-source did not set up");
  const r = await fn({
    orgId,
    type: "item.updated",
    subject: ITEM,
    facts: { status: "open", priority: 2, labels: ["bug"], projectKey: "CORE" },
    summary: "Item ITEM-1 changed.",
    dedupeKey: `key-${++seq}`,
    ...over,
  });
  return r.eventId;
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** The dispatch job's body, in the job's org scope. */
const dispatch = (eventId: string, opts: { finalAttempt?: boolean } = {}) =>
  withOrgScope(orgId, () => k.app.get(TriggerDispatcher).dispatch({ orgId, eventId }, opts));

/** The fake source's provider object, as the dispatcher gets it. */
async function sourceImpl(): Promise<TriggerSource> {
  const { providers } = await k.app
    .get(ExtensionPointDefaults)
    .providersFor<TriggerSource>(orgId, "trigger-source");
  const impl = providers.find((p) => p.extension === PLUGIN)?.impl;
  if (!impl) throw new Error("fake-trigger-source does not serve the org");
  return impl;
}

/** Whether a query of another connection waits on a row lock. */
const lockWaiter = async () =>
  (
    await sql<{ n: number }>`select count(*)::int as n from pg_stat_activity
      where wait_event_type = 'Lock' and query ilike '%automations%'`.execute(raw)
  ).rows[0]?.n === 1;

/** The coalesce job's body for the pair, in the job's org scope. */
const flush = (automationId: string, subject: TriggerSubject = ITEM) =>
  withOrgScope(orgId, () =>
    k.app.get(EventCoalescer).flush({ orgId, automationId, subjectKey: subjectKey(subject) }),
  );

const stateOf = async (eventId: string) =>
  (
    await db
      .selectFrom("trigger_events")
      .select("state")
      .where("id", "=", eventId)
      .executeTakeFirstOrThrow()
  ).state;

const owed = (name: string) =>
  db.selectFrom("outbox").selectAll().where("job_name", "=", name).orderBy("id").execute();

const runsOf = (automationId: string) =>
  db
    .selectFrom("automation_runs")
    .selectAll()
    .where("automation_id", "=", automationId)
    .orderBy("created_at")
    .orderBy("id")
    .execute();

/** The automation's deliveries in the order their events were stored. */
const deliveriesOf = (automationId: string) =>
  db
    .selectFrom("automation_event_deliveries as d")
    .innerJoin("trigger_events as e", "e.id", "d.event_id")
    .select(["d.event_id", "d.subject_key", "d.automation_run_id"])
    .where("d.automation_id", "=", automationId)
    .orderBy("e.created_at")
    .orderBy("e.id")
    .execute();

const patchSettings = async (automations: Record<string, unknown>) => {
  const res = await owner({
    method: "PATCH",
    url: `/api/v1/orgs/${orgId}/settings`,
    payload: { automations },
  });
  expect(res.statusCode, res.body).toBe(200);
};

const ofType = <T extends ConversationEvent["type"]>(evs: ConversationEvent[], type: T) =>
  evs.filter((e): e is Extract<ConversationEvent, { type: T }> => e.type === type);

describe("trigger event dispatch", () => {
  it("fires matching automations once per subject within the window", async () => {
    const a = await automation();
    // another type, and a filter the facts miss: neither gets a delivery
    const created = await automation({ types: ["item.created"] });
    const closed = await automation({ filter: [{ fact: "status", op: "eq", value: "closed" }] });
    const before = Date.now();
    const events = [await emit(), await emit(), await emit()];
    for (const e of events) await dispatch(e);
    const after = Date.now();
    for (const e of events) expect(await stateOf(e)).toBe("dispatched");

    // the first delivery opened the window: one delayed coalesce job for the pair
    const jobs = await owed("automation-coalesce");
    expect(jobs).toHaveLength(1);
    const first = events[0] as string;
    expect(jobs[0]).toMatchObject({
      queue: MAINTENANCE_QUEUE_NAME,
      job_id: `${coalesceJobId(a.id, ITEM)}-${first}`,
      data: { orgId, automationId: a.id, subjectKey: subjectKey(ITEM) },
      org_id: orgId,
    });
    const runAt = new Date(jobs[0]?.run_at as Date).getTime();
    expect(runAt).toBeGreaterThanOrEqual(before + 30_000);
    expect(runAt).toBeLessThanOrEqual(after + 30_000);
    expect(await deliveriesOf(created.id)).toEqual([]);
    expect(await deliveriesOf(closed.id)).toEqual([]);

    await flush(a.id);
    const runs = await runsOf(a.id);
    expect(runs).toHaveLength(1);
    const run = runs[0];
    expect(run).toMatchObject({
      trigger_key: first,
      scheduled_for: null,
      fired_at: null,
      status: "pending",
      trial: false,
      manual: false,
    });
    // the run serves the three events, in the order they were stored
    expect(await deliveriesOf(a.id)).toEqual(
      events.map((e) => ({
        event_id: e,
        subject_key: subjectKey(ITEM),
        automation_run_id: run?.id,
      })),
    );
    expect((await owed("automation-fire")).map((j) => j.job_id)).toEqual([
      `automation-fire-${run?.id}`,
    ]);
    expect((await owed("automation-settle")).map((j) => j.job_id)).toEqual([
      `automation-settle-${run?.id}-unfired`,
    ]);

    // a repeated flush finds nothing waiting
    await flush(a.id);
    expect(await runsOf(a.id)).toHaveLength(1);

    // the next event opens a new window with a job of its own
    const later = await emit();
    await dispatch(later);
    expect((await owed("automation-coalesce")).map((j) => j.job_id)).toEqual([
      `${coalesceJobId(a.id, ITEM)}-${first}`,
      `${coalesceJobId(a.id, ITEM)}-${later}`,
    ]);
    // a retried dispatch of a dispatched event does nothing
    await dispatch(later);
    expect(await owed("automation-coalesce")).toHaveLength(2);
  });

  it("each subject has its own window", async () => {
    const a = await automation();
    const one = await emit({ subject: ITEM });
    const two = await emit({ subject: OTHER });
    await dispatch(one);
    await dispatch(two);
    expect(await owed("automation-coalesce")).toHaveLength(2);
    await flush(a.id, ITEM);
    await flush(a.id, OTHER);
    expect((await runsOf(a.id)).map((r) => r.trigger_key).sort()).toEqual([one, two].sort());
  });

  it("skips owners the source does not admit", async () => {
    const a = await automation();
    probe().visible = [];
    const e = await emit();
    await dispatch(e);
    expect(await stateOf(e)).toBe("dispatched");
    expect(await deliveriesOf(a.id)).toEqual([]);
    expect(await owed("automation-coalesce")).toEqual([]);
    expect(await runsOf(a.id)).toEqual([]);
  });

  it("skips self-triggered events", async () => {
    const self = await automation();
    const other = await automation({ agentId: await newAgent("Reviewer") });
    // the watcher agent's own run emits the event (cause: its tool call)
    const conv = await createConv(owner, orgId, agentId);
    const input = {
      type: "item.updated",
      subject: ITEM,
      facts: { status: "open" },
      summary: "Changed by the agent.",
      dedupeKey: "from-run",
    };
    await postMessage(owner, orgId, conv, `tool:${TOOL}:${JSON.stringify(input)}`);
    await waitForTerminal(db, conv, 1, 20_000);
    const result = ofType(await eventsOf(db, conv), "tool_result").find(
      (r) => r.payload.toolKey === TOOL,
    );
    const { eventId } = JSON.parse(result?.payload.content ?? "{}") as { eventId: string };
    expect(eventId).toBeTruthy();
    await dispatch(eventId);
    expect(await deliveriesOf(self.id)).toEqual([]);
    expect((await deliveriesOf(other.id)).map((d) => d.event_id)).toEqual([eventId]);
  });

  it("stops at depth 8", async () => {
    const a = await automation();
    const ok = await emit();
    const deep = await emit();
    await db.updateTable("trigger_events").set({ depth: 8 }).where("id", "=", ok).execute();
    await db.updateTable("trigger_events").set({ depth: 9 }).where("id", "=", deep).execute();
    await dispatch(deep);
    expect(await stateOf(deep)).toBe("depth_stopped");
    expect(await deliveriesOf(a.id)).toEqual([]);
    await dispatch(ok);
    expect(await stateOf(ok)).toBe("dispatched");
    expect((await deliveriesOf(a.id)).map((d) => d.event_id)).toEqual([ok]);
  });

  it("provider gone: no fire, no retry", async () => {
    const a = await automation();
    const e = await emit();
    const off = await owner({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/extensions/${PLUGIN}`,
      payload: { enabled: false },
    });
    expect(off.statusCode, off.body).toBe(200);
    // the job completes (no throw, so BullMQ does not retry it)
    await expect(dispatch(e)).resolves.toBeUndefined();
    expect(await stateOf(e)).toBe("undelivered");
    expect(await deliveriesOf(a.id)).toEqual([]);
    expect(await owed("automation-coalesce")).toEqual([]);
  });

  it("subject rate limit skips with subject_rate", async () => {
    const a = await automation();
    await patchSettings({ maxEventRunsPerSubjectPerHour: 1 });
    const e1 = await emit();
    await dispatch(e1);
    await flush(a.id);
    const e2 = await emit();
    await dispatch(e2);
    await flush(a.id);
    const runs = await runsOf(a.id);
    expect(runs.map((r) => [r.trigger_key, r.status, r.skip_reason])).toEqual([
      [e1, "pending", null],
      [e2, "skipped", "subject_rate"],
    ]);
    // the skipped run took its event, and owes no fire
    expect((await deliveriesOf(a.id)).map((d) => [d.event_id, d.automation_run_id])).toEqual([
      [e1, runs[0]?.id],
      [e2, runs[1]?.id],
    ]);
    expect((await owed("automation-fire")).map((j) => j.job_id)).toEqual([
      `automation-fire-${runs[0]?.id}`,
    ]);
    // another subject has its own count
    const e3 = await emit({ subject: OTHER });
    await dispatch(e3);
    await flush(a.id, OTHER);
    expect((await runsOf(a.id)).find((r) => r.trigger_key === e3)?.status).toBe("pending");
  });

  it("event source switched off by the org admin fires nothing", async () => {
    const a = await automation();
    await patchSettings({ eventSourcesOff: [PLUGIN] });
    const e = await emit();
    await dispatch(e);
    expect(await stateOf(e)).toBe("undelivered");
    expect(await deliveriesOf(a.id)).toEqual([]);
    expect(await owed("automation-coalesce")).toEqual([]);
  });

  it("a directed event is left pending for acceptance routing", async () => {
    const a = await automation({ types: ["item.assigned"] });
    const e = await emit({ type: "item.assigned", audience: { accountId: ownerId, agentId } });
    await dispatch(e);
    expect(await stateOf(e)).toBe("pending");
    expect(await deliveriesOf(a.id)).toEqual([]);
  });

  it("a filter on a fact the source does not declare never matches", async () => {
    const a = await automation({ filter: [{ fact: "secret", op: "eq", value: "x" }] });
    const e = await emit({ facts: { status: "open", secret: "x" } });
    await dispatch(e);
    expect(await deliveriesOf(a.id)).toEqual([]);
  });

  it("a source whose visible() never answers fails the job at its deadline; the last attempt leaves the event undelivered", async () => {
    const a = await automation();
    const impl = await sourceImpl();
    vi.spyOn(impl, "visible").mockImplementation(() => new Promise<string[]>(() => {}));
    const e = await emit();
    await expect(dispatch(e)).rejects.toBeInstanceOf(TriggerSourceTimeout);
    expect(await stateOf(e)).toBe("pending");
    await expect(dispatch(e, { finalAttempt: true })).resolves.toBeUndefined();
    expect(await stateOf(e)).toBe("undelivered");
    expect(await deliveriesOf(a.id)).toEqual([]);
    expect(await owed("automation-coalesce")).toEqual([]);
  });

  it("two concurrent dispatches of one pair owe one coalesce job", async () => {
    const a = await automation();
    const [e1, e2] = [await emit(), await emit()];
    await Promise.all([dispatch(e1), dispatch(e2)]);
    expect((await deliveriesOf(a.id)).map((d) => d.event_id).sort()).toEqual([e1, e2].sort());
    expect(await owed("automation-coalesce")).toHaveLength(1);
  });

  it("a dispatch that commits after a flush took the row opens a new window", async () => {
    const a = await automation();
    const e1 = await emit();
    await dispatch(e1);
    const e2 = await emit();
    let late: Promise<void> | undefined;
    const host = k.app.get(TransactionHost);
    // the flush's transaction stays open until the dispatch waits on the automation row
    await host.run(async () => {
      await flush(a.id);
      late = host.run(() => dispatch(e2), { propagation: "requires_new" });
      await waitFor(lockWaiter, 20_000, "the dispatch waits on the automation row");
    });
    await late;
    const [run] = await runsOf(a.id);
    expect((await deliveriesOf(a.id)).map((d) => [d.event_id, d.automation_run_id])).toEqual([
      [e1, run?.id],
      [e2, null],
    ]);
    expect((await owed("automation-coalesce")).map((j) => j.job_id)).toEqual([
      `${coalesceJobId(a.id, ITEM)}-${e1}`,
      `${coalesceJobId(a.id, ITEM)}-${e2}`,
    ]);
  });

  it("an automation edited between the match and the delivery gets nothing", async () => {
    const a = await automation();
    const impl = await sourceImpl();
    const visible = impl.visible.bind(impl);
    // the owner narrows the filter while the source is asked
    vi.spyOn(impl, "visible").mockImplementation(async (args) => {
      await store.updateTask(db, a.id, {
        trigger: {
          kind: "event",
          source: PLUGIN,
          types: ["item.updated"],
          filter: [{ fact: "status", op: "eq", value: "closed" }],
        },
      });
      return visible(args);
    });
    const e = await emit();
    await dispatch(e);
    expect(await stateOf(e)).toBe("dispatched");
    expect(await deliveriesOf(a.id)).toEqual([]);
  });

  it("two events 1 s apart produce one run through the queue", async () => {
    failDispatch = false;
    // the run's fire job then skips it (org_disabled) instead of starting it (the event fire path
    // is not built yet)
    await patchSettings({ enabled: false });
    const a = await automation();
    const queue = k.app.get<Queue>(getQueueToken(MAINTENANCE_QUEUE_NAME));
    const e1 = await emit();
    await drainOutbox(k.app, { jobName: "trigger-dispatch" });
    await waitFor(async () => (await stateOf(e1)) === "dispatched", 20_000, "e1 dispatched");
    await drainOutbox(k.app, { jobName: "automation-coalesce" });
    const jobId = `${coalesceJobId(a.id, ITEM)}-${e1}`;
    expect(await queue.getJobState(jobId)).toBe("delayed");
    // a second event of the window, its store 1 s after the first's
    const e2 = await emit();
    await db
      .updateTable("trigger_events")
      .set({ created_at: new Date(Date.now() + 1000) })
      .where("id", "=", e2)
      .execute();
    await drainOutbox(k.app, { jobName: "trigger-dispatch" });
    await waitFor(async () => (await stateOf(e2)) === "dispatched", 20_000, "e2 dispatched");
    const delayed = (await queue.getDelayed()).filter((j) => j.name === "automation-coalesce");
    expect(delayed.map((j) => j.id)).toEqual([jobId]);
    // close the window now instead of waiting for it
    await (await queue.getJob(jobId))?.promote();
    await waitFor(async () => (await runsOf(a.id)).length === 1, 20_000, "the window's run");
    const [run] = await runsOf(a.id);
    expect(run?.trigger_key).toBe(e1);
    expect((await deliveriesOf(a.id)).map((d) => [d.event_id, d.automation_run_id])).toEqual([
      [e1, run?.id],
      [e2, run?.id],
    ]);
    await waitFor(
      async () => (await runsOf(a.id))[0]?.skip_reason === "org_disabled",
      20_000,
      "the fire job's claim",
    );
  });
});

/** The reporter agent's tool call emits an item event; resolves to the stored event's id. */
async function emitViaTool(
  reporter: string,
  over: {
    type: string;
    status: string;
    summary: string;
  },
): Promise<string> {
  const input = {
    type: over.type,
    subject: ITEM,
    facts: { status: over.status, priority: 2, labels: ["bug"], projectKey: "CORE" },
    summary: over.summary,
    dedupeKey: `key-${++seq}`,
  };
  await postMessage(owner, orgId, reporter, `tool:${TOOL}:${JSON.stringify(input)}`);
  const posted = (await eventsOf(db, reporter)).filter((e) => e.type === "user_message").length;
  await waitForTerminal(db, reporter, posted, 20_000);
  const result = (await eventsOf(db, reporter)).findLast(
    (e) => e.type === "tool_result" && e.payload.toolKey === TOOL,
  );
  const content = result?.type === "tool_result" ? result.payload.content : "{}";
  const { eventId } = JSON.parse(content) as { eventId?: string };
  if (!eventId) throw new Error(`the emit failed: ${content}`);
  return eventId;
}

/** Relays the owed dispatch jobs and waits until the events are dispatched. */
async function dispatched(...eventIds: string[]): Promise<void> {
  await drainOutbox(k.app, { jobName: "trigger-dispatch" });
  for (const id of eventIds)
    await waitFor(async () => (await stateOf(id)) === "dispatched", 20_000, `${id} dispatched`);
}

/** Closes the window the event opened: its delayed coalesce job runs now. */
async function closeWindow(automationId: string, firstEventId: string): Promise<void> {
  await drainOutbox(k.app, { jobName: "automation-coalesce" });
  const queue = k.app.get<Queue>(getQueueToken(MAINTENANCE_QUEUE_NAME));
  const jobId = `${coalesceJobId(automationId, ITEM)}-${firstEventId}`;
  expect(await queue.getJobState(jobId)).toBe("delayed");
  await (await queue.getJob(jobId))?.promote();
}

const settledRun = (automationId: string, n: number) =>
  waitFor(
    async () => {
      await drainOutbox(k.app, { jobName: "automation-fire" });
      const runs = await runsOf(automationId);
      return runs.length === n &&
        runs.every((r) => r.status !== "pending" && r.status !== "running")
        ? runs
        : null;
    },
    30_000,
    `${n} settled automation runs`,
  );

type UserMessage = Extract<ConversationEvent, { type: "user_message" }>;
const userMessages = async (conv: string): Promise<UserMessage[]> =>
  (await eventsOf(db, conv)).filter((e): e is UserMessage => e.type === "user_message");

describe("event automations end to end", () => {
  it("two events of a subject coalesce into one run in the subject conversation; a later event joins it", async () => {
    failDispatch = false;
    const reporter = await createConv(owner, orgId, await newAgent("Reporter"));
    const created = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/automations`,
      payload: {
        agentId: agentId,
        name: "Triage",
        prompt: "echo:triaged",
        mode: "subject",
        trigger: {
          kind: "event",
          source: PLUGIN,
          types: ["item.created", "item.updated"],
          filter: [{ fact: "status", op: "eq", value: "open" }],
        },
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const a = (created.json() as { task: { id: string } }).task;

    // a fact that misses the filter fires nothing
    const closed = await emitViaTool(reporter, {
      type: "item.updated",
      status: "closed",
      summary: "ITEM-1 was closed.",
    });
    await dispatched(closed);
    expect(
      await db
        .selectFrom("automation_event_deliveries")
        .select("event_id")
        .where("automation_id", "=", a.id)
        .execute(),
    ).toEqual([]);
    expect(await runsOf(a.id)).toEqual([]);

    // two matching events within one window
    const e1 = await emitViaTool(reporter, {
      type: "item.created",
      status: "open",
      summary: "ITEM-1 was opened.",
    });
    const e2 = await emitViaTool(reporter, {
      type: "item.updated",
      status: "open",
      summary: "ITEM-1 got a label.",
    });
    await dispatched(e1, e2);
    await closeWindow(a.id, e1);
    const [first] = await settledRun(a.id, 1);
    expect(first).toMatchObject({ status: "completed", trigger_key: e1 });
    const conv = first?.conversation_id as string;
    expect(conv).toBeTruthy();

    // one subject conversation: the automation owner's, with the automation's agent
    const convs = await db
      .selectFrom("conversations")
      .select(["id", "account_id", "agent_id", "subject"])
      .where("automation_id", "=", a.id)
      .execute();
    expect(convs).toHaveLength(1);
    expect(convs[0]).toMatchObject({
      id: conv,
      account_id: ownerId,
      agent_id: agentId,
      subject: { source: PLUGIN, kind: "item", id: "ITEM-1" },
    });

    // the coalesced case: one marked user message listing both events in order
    const [msg, ...rest] = await userMessages(conv);
    expect(rest).toEqual([]);
    expect(msg?.payload.automationEvent).toMatchObject({
      automationId: a.id,
      automationRunId: first?.id,
      source: PLUGIN,
    });
    expect(msg?.payload.automationEvent?.events.map((e) => [e.id, e.type])).toEqual([
      [e1, "item.created"],
      [e2, "item.updated"],
    ]);
    const events = await eventsOf(db, conv);
    expect(events.some((e) => e.type === "assistant_message")).toBe(true);

    // the kernel run is linked to the automation run and the latest cause
    const kernelRuns = await db
      .selectFrom("runs")
      .select(["automation_run_id", "trigger_event_id"])
      .where("conversation_id", "=", conv)
      .execute();
    expect(kernelRuns).toEqual([{ automation_run_id: first?.id, trigger_event_id: e2 }]);

    // a third event after the run lands in the same conversation
    const e3 = await emitViaTool(reporter, {
      type: "item.updated",
      status: "open",
      summary: "ITEM-1 was reassigned.",
    });
    await dispatched(e3);
    await closeWindow(a.id, e3);
    const runs = await settledRun(a.id, 2);
    expect(runs[1]).toMatchObject({ status: "completed", conversation_id: conv, trigger_key: e3 });
    const msgs = await userMessages(conv);
    expect(msgs.map((m) => m.payload.automationEvent?.events.map((e) => e.id))).toEqual([
      [e1, e2],
      [e3],
    ]);
    expect(
      await db.selectFrom("conversations").select("id").where("automation_id", "=", a.id).execute(),
    ).toHaveLength(1);
    const linked = await db
      .selectFrom("runs")
      .select(["automation_run_id", "trigger_event_id"])
      .where("conversation_id", "=", conv)
      .orderBy("created_at")
      .execute();
    expect(linked.map((r) => r.trigger_event_id)).toEqual([e2, e3]);
    expect(linked.map((r) => r.automation_run_id)).toEqual(runs.map((r) => r.id));
  });
});
