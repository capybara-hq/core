import type { ToolCallContext, TriggerEvent } from "@capybara-hq/plugin-sdk";
import {
  fakeExtensionEntry,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { OUTBOX_DISPATCH_FAILS } from "../../src/infra/outbox/outbox.dispatcher.js";
import { MAINTENANCE_QUEUE_NAME } from "../../src/runtime/maintenance-queue.js";
import { attachCallScope } from "../../src/tools/call-scope.js";
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
  waitForTerminal,
} from "../helpers/runs.js";

/**
 * `ctx.triggers.emit` (collaboration spec §4.2): the kernel validates the event, checks the plugin
 * is enabled in the org, verifies the cause (a tool call context only the pipeline made, a run of
 * the event's org whose trigger event sets the depth; or an active member), stores one
 * `trigger_events` row per (org, plugin, dedupe key) and owes one `trigger-dispatch` job. The
 * emits go through `fake-trigger-source`'s own `ctx.triggers.emit` (its probe) or its tool
 * `emit_item_event`. Outbox adds to the maintenance queue fail while `failDispatch` is set, so the
 * owed rows stay to be counted.
 */

const PLUGIN = "fake-trigger-source";
const TOOL = `plugin__${PLUGIN}__emit_item_event`;

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

type Emit = (e: TriggerEvent) => Promise<{ eventId: string; duplicate: boolean }>;
const probe = () => (globalThis as { __fakeTriggerSource?: { emit?: Emit } }).__fakeTriggerSource;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      { roles: ["api", "worker"], extensions: [MODEL_FAKE, fakeExtensionEntry(PLUGIN)] },
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

/** A new org of the owner with the fake enabled. */
async function orgWithSource(name = "Acme"): Promise<string> {
  const id = await createOrgWithProviders(k, owner, name);
  const on = await owner({
    method: "PUT",
    url: `/api/v1/orgs/${id}/extensions/${PLUGIN}`,
    payload: { enabled: true },
  });
  expect(on.statusCode, on.body).toBe(200);
  return id;
}

beforeEach(async () => {
  failDispatch = true;
  await truncateTables(raw, "capybara.accounts, capybara.orgs, capybara.outbox");
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  owner = await session(k, "owner");
  orgId = await orgWithSource();
  const res = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Emitter",
        instructions: "Emit.",
        model: { provider: "model-fake", model: "fake-1" },
      },
      visibility: "org",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  agentId = (res.json() as { agent: { id: string } }).agent.id;
});

const ev = (over: Partial<TriggerEvent> = {}): TriggerEvent => ({
  orgId,
  type: "item.created",
  subject: { kind: "item", id: "ITEM-1", title: "First item" },
  facts: { status: "open", priority: 2, labels: ["bug"], projectKey: "CORE" },
  summary: "Item ITEM-1 was created.",
  dedupeKey: `key-${++seq}`,
  ...over,
});

/** Emits as the fake extension (its own `ctx.triggers.emit`). */
const emit = (over: Partial<TriggerEvent> = {}) => {
  const fn = probe()?.emit;
  if (!fn) throw new Error("fake-trigger-source did not set up");
  return fn(ev(over));
};

const outboxJobs = (name: string) =>
  db.selectFrom("outbox").selectAll().where("job_name", "=", name).execute();

const countEvents = async (dedupeKey: string) =>
  (await db.selectFrom("trigger_events").select("id").where("dedupe_key", "=", dedupeKey).execute())
    .length;

const eventRow = (id: string) =>
  db.selectFrom("trigger_events").selectAll().where("id", "=", id).executeTakeFirstOrThrow();

const ofType = <T extends ConversationEvent["type"]>(evs: ConversationEvent[], type: T) =>
  evs.filter((e): e is Extract<ConversationEvent, { type: T }> => e.type === type);

/** Runs one conversation whose model calls `emit_item_event` with `input`; its result and run. */
async function emitFromRun(input: Record<string, unknown>) {
  const conv = await createConv(owner, orgId, agentId);
  await postMessage(owner, orgId, conv, `tool:${TOOL}:${JSON.stringify(input)}`);
  await waitForTerminal(db, conv, 1, 20_000);
  const r = ofType(await eventsOf(db, conv), "tool_result").find((e) => e.payload.toolKey === TOOL);
  expect(r, "the tool's result").toBeDefined();
  const run = await db
    .selectFrom("runs")
    .select("id")
    .where("conversation_id", "=", conv)
    .executeTakeFirstOrThrow();
  return { result: JSON.parse(r?.payload.content ?? "null") as Record<string, unknown>, run };
}

/** A call context the pipeline would make for a call of `runId` (its scope attached). */
function pipelineCall(runId: string, conversationId: string): ToolCallContext {
  const call = { orgId, accountId: ownerId, conversationId } as ToolCallContext;
  attachCallScope(call, {
    runId,
    step: 1,
    rootConversationId: conversationId,
    unattended: false,
    agentVersion: 1,
  });
  return call;
}

describe("ctx.triggers.emit", () => {
  it("emit stores one event and owes one dispatch", async () => {
    const r = await emit({ type: "item.created", dedupeKey: "k1" });
    expect(r.duplicate).toBe(false);
    const jobs = await outboxJobs("trigger-dispatch");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      queue: MAINTENANCE_QUEUE_NAME,
      job_id: `trigger-dispatch-${r.eventId}`,
      data: { orgId, eventId: r.eventId },
      org_id: orgId,
      run_at: null,
    });
    expect(await eventRow(r.eventId)).toMatchObject({
      org_id: orgId,
      plugin: PLUGIN,
      type: "item.created",
      subject: { kind: "item", id: "ITEM-1", title: "First item" },
      facts: { status: "open", priority: 2, labels: ["bug"], projectKey: "CORE" },
      summary: "Item ITEM-1 was created.",
      dedupe_key: "k1",
      audience: null,
      cause_account_id: null,
      cause_run_id: null,
      depth: 0,
      state: "pending",
    });
  });

  it("emit is idempotent on dedupeKey", async () => {
    const first = await emit({ dedupeKey: "k2" });
    const again = await emit({ dedupeKey: "k2", summary: "Another text." });
    expect(again).toEqual({ eventId: first.eventId, duplicate: true });
    expect(await countEvents("k2")).toBe(1);
    expect(await outboxJobs("trigger-dispatch")).toHaveLength(1);
  });

  it("emit refuses an undeclared type", async () => {
    await expect(emit({ type: "item.secret" })).rejects.toMatchObject({
      name: "TriggerError",
      code: "type_not_declared",
    });
    expect(await db.selectFrom("trigger_events").select("id").execute()).toEqual([]);
  });

  it("a directed event stores its audience", async () => {
    const r = await emit({ type: "item.assigned", audience: { accountId: ownerId, agentId } });
    expect((await eventRow(r.eventId)).audience).toEqual({ accountId: ownerId, agentId });
  });

  it.each([
    ["a nested fact", { facts: { owner: { id: "a" } } as never }],
    ["a null fact", { facts: { status: null } as never }],
    ["a list fact with a number", { facts: { labels: ["a", 1] } as never }],
    ["a non-finite number", { facts: { priority: Number.NaN } }],
    ["facts as a list", { facts: ["a"] as never }],
    ["65 facts", { facts: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`f${i}`, i])) }],
    ["a fact string over 256 bytes", { facts: { status: "é".repeat(129) } }],
    ["an audience without an agent", { audience: { accountId: "a", agentId: "" } }],
    ["a missing subject title", { subject: { kind: "item", id: "1", title: "" } }],
    ["a summary over 4 KB", { summary: "x".repeat(4097) }],
    ["a cause with neither shape", { cause: {} as never }],
    [
      "a javascript: subject url",
      { subject: { kind: "item", id: "1", title: "t", url: "javascript:alert(1)" } },
    ],
    ["a relative subject url", { subject: { kind: "item", id: "1", title: "t", url: "/items/1" } }],
    [
      "an ftp subject url",
      { subject: { kind: "item", id: "1", title: "t", url: "ftp://e.example/1" } },
    ],
  ])("emit refuses %s as invalid_event", async (_what, over) => {
    await expect(emit(over)).rejects.toMatchObject({ code: "invalid_event" });
  });

  const cap = (n: number) => "a".repeat(n);
  const subject = { kind: "item", id: "ITEM-1", title: "First item" };
  it.each([
    ["subject.kind", 256, (s: string) => ({ subject: { ...subject, kind: s } })],
    ["subject.id", 256, (s: string) => ({ subject: { ...subject, id: s } })],
    ["subject.title", 1024, (s: string) => ({ subject: { ...subject, title: s } })],
    // an https URL of exactly the length asked for
    [
      "subject.url",
      2048,
      (s: string) => ({ subject: { ...subject, url: `https://e.example/${s.slice(18)}` } }),
    ],
    ["dedupeKey", 256, (s: string) => ({ dedupeKey: s })],
    ["a fact name", 256, (s: string) => ({ facts: { [s]: "x" } })],
  ] as [string, number, (s: string) => Partial<TriggerEvent>][])(
    "%s is capped at %i bytes",
    async (_field, max, over) => {
      await expect(emit(over(cap(max)))).resolves.toMatchObject({ duplicate: false });
      await expect(emit(over(cap(max + 1)))).rejects.toMatchObject({ code: "invalid_event" });
    },
  );

  it("the event is read once: a getter cannot change what was validated", async () => {
    let reads = 0;
    const tricky = ev({ dedupeKey: "getter" });
    Object.defineProperty(tricky, "type", {
      enumerable: true,
      get: () => (reads++ === 0 ? "item.created" : "item.secret"),
    });
    const fn = probe()?.emit;
    if (!fn) throw new Error("fake-trigger-source did not set up");
    const r = await fn(tricky);
    expect(reads).toBe(1);
    expect((await eventRow(r.eventId)).type).toBe("item.created");
  });

  it("emit refuses an org where the plugin is not enabled", async () => {
    const other = await createOrgWithProviders(k, owner, "Other");
    await expect(emit({ orgId: other })).rejects.toMatchObject({ code: "org_disabled" });
  });

  it("a person cause must be an active member of the org (depth 0)", async () => {
    const r = await emit({ cause: { accountId: ownerId } });
    expect(await eventRow(r.eventId)).toMatchObject({
      cause_account_id: ownerId,
      cause_run_id: null,
      depth: 0,
    });
    const stranger = await accountsFor(db).createLocal({
      login: "stranger",
      password: PW,
      displayName: "S",
    });
    await expect(emit({ cause: { accountId: stranger.id } })).rejects.toMatchObject({
      code: "invalid_event",
    });
    await sql`UPDATE capybara.accounts SET status = 'disabled' WHERE id = ${ownerId}`.execute(raw);
    await expect(emit({ cause: { accountId: ownerId } })).rejects.toMatchObject({
      code: "invalid_event",
    });
  });

  it("a forged call context is refused", async () => {
    await expect(
      emit({ cause: { call: { orgId, accountId: ownerId } as ToolCallContext } }),
    ).rejects.toMatchObject({ code: "invalid_event" });
  });

  it("a tool call's event records its run and the run's person (depth 0)", async () => {
    const { result, run } = await emitFromRun({
      type: "item.updated",
      subject: { kind: "item", id: "ITEM-2", title: "Second" },
      facts: { status: "done" },
      summary: "Item ITEM-2 was closed.",
      dedupeKey: "from-run",
    });
    expect(result).toMatchObject({ duplicate: false });
    expect(await eventRow(result.eventId as string)).toMatchObject({
      type: "item.updated",
      cause_run_id: run.id,
      cause_account_id: ownerId,
      depth: 0,
    });
  });

  it("a cause from a run inherits depth + 1", async () => {
    const { run } = await emitFromRun({
      type: "item.created",
      subject: { kind: "item", id: "ITEM-3", title: "Third" },
      facts: {},
      summary: "Item ITEM-3 was created.",
      dedupeKey: "seed",
    });
    const conv = (
      await db
        .selectFrom("runs")
        .select("conversation_id")
        .where("id", "=", run.id)
        .executeTakeFirstOrThrow()
    ).conversation_id;
    // the run started from an event of depth 2
    const deep = await emit({ dedupeKey: "deep" });
    await sql`UPDATE capybara.trigger_events SET depth = 2 WHERE id = ${deep.eventId}`.execute(raw);
    await sql`UPDATE capybara.runs SET trigger_event_id = ${deep.eventId} WHERE id = ${run.id}`.execute(
      raw,
    );
    const r = await emit({ cause: { call: pipelineCall(run.id, conv) } });
    expect(await eventRow(r.eventId)).toMatchObject({
      cause_run_id: run.id,
      cause_account_id: ownerId,
      depth: 3,
    });
    // the same run's call names another org: refused, the run is not that org's
    const other = await orgWithSource("Other");
    await expect(
      emit({ orgId: other, cause: { call: pipelineCall(run.id, conv) } }),
    ).rejects.toMatchObject({ code: "invalid_event" });
  });

  it("the owed dispatch is delivered to the maintenance queue", async () => {
    const r = await emit({ dedupeKey: "delivered" });
    failDispatch = false;
    await sql`UPDATE capybara.outbox SET next_attempt_at = now() WHERE dead_at IS NULL`.execute(
      raw,
    );
    await drainOutbox(k.app, { jobId: `trigger-dispatch-${r.eventId}` });
    expect(await outboxJobs("trigger-dispatch")).toEqual([]);
  });
});
