import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EventLog } from "../../src/conversations/event-log.js";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { withOrgScope } from "../../src/infra/database/org-scope.js";
import { OUTBOX_DISPATCH_FAILS } from "../../src/infra/outbox/outbox.dispatcher.js";
import { ModelPurposesService } from "../../src/models/purposes.js";
import type { IdleArmSkip } from "../../src/runtime/context/idle-compaction-rules.js";
import { CONVERSATION_LOCK_TTL_MS } from "../../src/runtime/conversation-lock.js";
import { IdleArm } from "../../src/runtime/idle-arm.js";
import {
  IDLE_COMPACTION_JOB,
  idleCompactionJobId,
} from "../../src/runtime/idle-compaction-jobs.js";
import { MAINTENANCE_QUEUE_NAME } from "../../src/runtime/maintenance-queue.js";
import { ProviderRegistry } from "../../src/runtime/providers.js";
import { ExecutionRevoked } from "../../src/runtime/run-execution.js";
import { type IdleCompactionIntent, RunFinish } from "../../src/runtime/run-finish.js";
import { RUN_HOOKS, type RunHooks } from "../../src/runtime/run-worker.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
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
  waitForTerminal,
} from "../helpers/runs.js";

/**
 * Arming idle compaction at a chat run's finish (idle compaction spec §4.2, plan S4–S7): the run
 * worker decides outside any transaction (`IdleArm.decide`) and the terminal transaction owes one
 * delayed `idle-compaction` job on the maintenance queue, `armedSeq` = the `run_finished` seq, due
 * at the cache expiry's fire time. The maintenance queue's adds fail here (the
 * `OUTBOX_DISPATCH_FAILS` seam), so the owed row stays in the outbox and no job reaches BullMQ.
 *
 * model-fake declares `[300, 3600]` (refreshOnHit, request_start) and passes the in-context gate
 * table; with the org's `promptCache.longTtl` on its calls ask for the 1 h tier. The size floor is
 * the settings' lowest (50,000 tokens, ratio 0.1 on a 400k window: decision D6), reached by about
 * 220k characters of seeded user text. Not covered here (Task 4's unit tests are): a sub-agent
 * conversation's run, a `budget` stop (sub-agents only) and a model outside the gate table
 * (every model-fake model is in it).
 */

let pgc: TestContainer;
let rd: TestContainer;
let k: TestKernel;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let maintenance: Queue;
let owner: Req;
let ownerId: string;

/** Org names are unique per account: one per setup. */
let orgCount = 0;
/** What the worker does with the run lock held, after `run_started` (a test sets it). */
let onRunning: ((runId: string, conversationId: string) => Promise<void>) | undefined;
const hooks: RunHooks = {
  beforeRunning: async (runId, conversationId) => onRunning?.(runId, conversationId),
  // The production lease, not the 2 s test default (`runConfig`'s `jobLockMs`): this file takes
  // over no stalled run, and `finishAfter` waits for the worker's own finish. A lease lost in the
  // decision window (an event loop stalled past the short lease's renewal deadline on a loaded
  // runner) ends the execution `interrupted` by design; the requeued job then finds the run
  // terminal (or its conversation deleted) and never finishes it, so the wait never ended (#1098).
  lockTtlMs: CONVERSATION_LOCK_TTL_MS,
};

/** About 220k characters: with the reply, the last call is over 50,000 tokens. */
const LONG_TEXT = "lorem ipsum dolor sit amet ".repeat(8_200);

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  redis = new Redis(rd.url, { maxRetriesPerRequest: null });
  maintenance = new Queue(MAINTENANCE_QUEUE_NAME, { connection: redis });
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensions: [MODEL_FAKE],
        // one step: a tool call ends the run `max_steps` (after the wrap-up call)
        runtime: { maxSteps: 1 },
        extensionConfig: {
          "model-fake": {
            models: [
              { id: "fake-1", contextWindow: 400_000 },
              { id: "fake-nc", contextWindow: 400_000, cache: "none" },
              // compaction models: eligible (200k), and one whose window leaves no useful chunk
              { id: "fake-c", contextWindow: 200_000, cache: "none" },
              { id: "fake-c-small", contextWindow: 32_000, cache: "none" },
            ],
          },
        },
      },
    ),
    {
      overrides: [
        { provide: OUTBOX_DISPATCH_FAILS, useValue: (q: string) => q === MAINTENANCE_QUEUE_NAME },
        { provide: RUN_HOOKS, useValue: hooks },
      ],
    },
  );
});

afterAll(async () => {
  await k?.close();
  await maintenance?.close();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

beforeEach(async () => {
  onRunning = undefined;
  await truncateTables(
    raw,
    "capybara.accounts, capybara.orgs, capybara.audit_events, capybara.outbox, capybara.deployment_settings, capybara.model_purpose_mappings",
  );
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  owner = await session(k, "owner");
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function patchOrg(orgId: string, payload: Record<string, unknown>): Promise<void> {
  const res = await owner({ method: "PATCH", url: `/api/v1/orgs/${orgId}/settings`, payload });
  expect(res.statusCode, res.body).toBe(200);
}

/** Maps the org's `compaction` purpose to the model-fake model `model`. */
async function mapCompaction(orgId: string, model: string): Promise<void> {
  const res = await owner({
    method: "PUT",
    url: `/api/v1/orgs/${orgId}/model-purposes/compaction`,
    payload: { target: { model: { provider: "model-fake", model }, params: {} } },
  });
  expect(res.statusCode, res.body).toBe(200);
}

/**
 * An org with the long cache tier and the lowest size floor; a conversation on `model`; the org's
 * `compaction` purpose mapped to `compactionModel` when given.
 */
async function setup(
  model = "fake-1",
  settings: Record<string, unknown> = {},
  compactionModel?: string,
): Promise<{ orgId: string; conv: string }> {
  const orgId = await createOrgWithProviders(k, owner, `Acme ${++orgCount}`);
  await patchOrg(orgId, {
    promptCache: { longTtl: true },
    compaction: { idleMinTokensFloor: 50_000, idleMinWindowRatio: 0.1 },
    ...settings,
  });
  if (compactionModel !== undefined) await mapCompaction(orgId, compactionModel);
  const agentId = await createAgent(owner, orgId, { provider: "model-fake", model });
  const conv = await createConv(owner, orgId, agentId);
  return { orgId, conv };
}

/**
 * Seeds a long earlier message the next run renders (consumed, so no run of its own starts): the
 * conversation's history is large, the reply stays short.
 */
async function seedLongHistory(orgId: string, conv: string): Promise<void> {
  const [e] = await withOrgScope(orgId, () =>
    k.app.get(EventLog).append(conv, [
      {
        type: "user_message",
        payload: { content: [{ type: "text", text: LONG_TEXT }], authorAccountId: ownerId },
      },
    ]),
  );
  await db
    .updateTable("conversations")
    .set({ consumed_seq: String(e?.seq) })
    .where("id", "=", conv)
    .execute();
}

/** Posts `text` and waits for the run's end; returns the conversation's events. */
async function turn(orgId: string, conv: string, text: string): Promise<ConversationEvent[]> {
  await postMessage(owner, orgId, conv, text);
  await waitForTerminal(db, conv, 1, 30_000);
  return eventsOf(db, conv);
}

const idleRows = () =>
  db
    .selectFrom("outbox")
    .select(["queue", "job_name", "job_id", "data", "run_at", "org_id"])
    .where("job_name", "=", IDLE_COMPACTION_JOB)
    .execute();

/** The reasons `IdleArm` logged a skip for, in order (its debug log, from now on). */
function skipReasons(): () => IdleArmSkip[] {
  const log = (k.app.get(IdleArm) as unknown as { log: { debug: (...a: unknown[]) => void } }).log;
  const debug = vi.spyOn(log, "debug");
  return () =>
    debug.mock.calls
      .filter(([msg]) => msg === "idle compaction not armed")
      .map(([, meta]) => (meta as { reason: IdleArmSkip }).reason);
}

/**
 * Runs one long turn on a fresh conversation and expects no idle compaction job owed, skipped for
 * `reason` (undefined: the decision failed and logged no skip).
 */
async function expectNotArmed(
  reason: IdleArmSkip | undefined,
  opts: {
    model?: string;
    settings?: Record<string, unknown>;
    long?: boolean;
    text?: string;
    compactionModel?: string;
  } = {},
): Promise<ConversationEvent[]> {
  const { orgId, conv } = await setup(opts.model, opts.settings, opts.compactionModel);
  if (opts.long !== false) await seedLongHistory(orgId, conv);
  const reasons = skipReasons();
  const events = await turn(orgId, conv, opts.text ?? "echo:ok");
  expect(events.filter((e) => e.type === "run_finished")).toHaveLength(1);
  expect(await idleRows()).toEqual([]);
  expect(reasons()).toEqual(reason === undefined ? [] : [reason]);
  vi.restoreAllMocks();
  return events;
}

/** The conversation row `IdleArm.decide` takes. */
const convRowOf = (conv: string) =>
  db
    .selectFrom("conversations")
    .select(["id", "org_id", "kind", "account_id"])
    .where("id", "=", conv)
    .executeTakeFirstOrThrow();

/**
 * Runs one long turn whose arm decision passes, doing `between` after the decision and before the
 * terminal transaction; resolves with how the worker's `RunFinish.finish` settled.
 */
async function finishAfter(between: (runId: string, conv: string) => Promise<void>): Promise<{
  orgId: string;
  conv: string;
  runId: string;
  intent: IdleCompactionIntent;
  finished: PromiseSettledResult<number | null>;
}> {
  const { orgId, conv } = await setup();
  await seedLongHistory(orgId, conv);
  const arm = k.app.get(IdleArm);
  const decide = arm.decide.bind(arm);
  const intents: (IdleCompactionIntent | undefined)[] = [];
  let runId = "";
  vi.spyOn(arm, "decide").mockImplementation(async (run, c, outcome) => {
    const intent = await decide(run, c, outcome);
    intents.push(intent);
    runId = run.id;
    await between(run.id, c.id);
    return intent;
  });
  const finisher = k.app.get(RunFinish);
  const finish = finisher.finish.bind(finisher);
  const settled = new Promise<PromiseSettledResult<number | null>>((resolve) => {
    vi.spyOn(finisher, "finish").mockImplementation((a) => {
      const r = finish(a);
      r.then(
        (value) => resolve({ status: "fulfilled", value }),
        (reason: unknown) => resolve({ status: "rejected", reason }),
      );
      return r;
    });
  });
  await postMessage(owner, orgId, conv, "echo:ok");
  const finished = await settled;
  vi.restoreAllMocks();
  // the decision itself armed: only the terminal transaction can have dropped the row
  expect(intents).toEqual([expect.objectContaining({ orgId })]);
  return { orgId, conv, runId, intent: intents[0] as IdleCompactionIntent, finished };
}

describe("arming idle compaction at a run's finish", () => {
  it("a completed message run owes one delayed idle-compaction job, due 0.9 of the 1 h tier after the call", async () => {
    const { orgId, conv } = await setup();
    await seedLongHistory(orgId, conv);
    const events = await turn(orgId, conv, "echo:ok");
    const finished = events.find((e) => e.type === "run_finished");
    const call = events.find((e) => e.type === "model_call");
    const usage = events.find(
      (e) => e.type === "usage" && e.runId === finished?.runId && e.payload.purpose === undefined,
    );
    expect(finished?.payload).toMatchObject({ reason: "completed" });
    expect(call?.payload.request.cacheTtl).toBe(3600);
    if (usage?.type === "usage") {
      const p = usage.payload;
      expect(p.inputTokens + p.cacheReadTokens + p.cacheWriteTokens).toBeGreaterThan(50_000);
    }
    const t0 = (call as ConversationEvent).createdAt.getTime();
    expect(await idleRows()).toEqual([
      {
        queue: MAINTENANCE_QUEUE_NAME,
        job_name: IDLE_COMPACTION_JOB,
        job_id: idleCompactionJobId(finished?.runId as string),
        data: {
          orgId,
          conversationId: conv,
          runId: finished?.runId,
          armedSeq: finished?.seq,
          mode: "cache",
          cacheCallSeq: call?.seq,
          expiresAt: t0 + 3_600_000,
        },
        run_at: new Date(t0 + 3_240_000),
        org_id: orgId,
      },
    ]);
    // the maintenance queue's adds fail: the job waits in the outbox, nothing reached BullMQ
    expect(await maintenance.getJob(idleCompactionJobId(finished?.runId as string))).toBeFalsy();
  });

  it("owes nothing with the 5-minute default tier (longTtl off)", async () => {
    await expectNotArmed("short_ttl", { settings: { promptCache: { longTtl: false } } });
  });

  it("owes nothing on a model that declares no cache", async () => {
    await expectNotArmed("no_cache", { model: "fake-nc" });
  });

  it("owes nothing for a context under the size threshold", async () => {
    await expectNotArmed("small", { long: false });
  });

  it("owes nothing for an automation's run (a scheduled task, an event automation)", async () => {
    for (const trigger of ["schedule", "automation_event"]) {
      await truncateTables(raw, "capybara.outbox");
      onRunning = async (runId) => {
        await sql`UPDATE capybara.conversation_events
          SET payload = jsonb_set(payload, '{trigger}', to_jsonb(${trigger}::text))
          WHERE run_id = ${runId} AND type = 'run_started'`.execute(raw);
      };
      await expectNotArmed("trigger");
    }
  });

  it("owes nothing for a wake run with an automation lineage (S5)", async () => {
    onRunning = async (runId) => {
      await db
        .updateTable("runs")
        .set({ automation_run_id: "automation-run-of-a-test" })
        .where("id", "=", runId)
        .execute();
    };
    await expectNotArmed("automation");
  });

  it("owes nothing when the org turned idle compaction or compaction off", async () => {
    const lowFloor = { idleMinTokensFloor: 50_000, idleMinWindowRatio: 0.1 };
    await expectNotArmed("disabled", {
      settings: { compaction: { ...lowFloor, idleEnabled: false } },
    });
    await expectNotArmed("disabled", {
      settings: { compaction: { ...lowFloor, enabled: false } },
    });
  });

  it("owes nothing when the owner turned idle compaction off", async () => {
    const res = await owner({
      method: "PUT",
      url: "/api/v1/me/preferences",
      payload: { idleCompaction: "off" },
    });
    expect(res.statusCode, res.body).toBe(200);
    await expectNotArmed("personal_off");
  });

  it("a max_steps run whose wrap-up answered its tool result arms; an unanswered tool result after the reply does not (S7)", async () => {
    const { orgId, conv } = await setup();
    await seedLongHistory(orgId, conv);
    // the step limit's wrap-up call (no tools) answers the tool result: a settled end
    const events = await turn(orgId, conv, 'tool:NoSuchTool:{"a":1}');
    const finished = events.find((e) => e.type === "run_finished");
    expect(finished?.payload).toMatchObject({ reason: "max_steps" });
    expect(events.some((e) => e.type === "tool_result")).toBe(true);
    expect((await idleRows()).map((r) => r.job_id)).toEqual([
      idleCompactionJobId(finished?.runId as string),
    ]);

    // the same decision with a tool result after the last reply: unsettled, no intent
    const runId = finished?.runId as string;
    const convRow = await convRowOf(conv);
    const decide = () =>
      withOrgScope(orgId, () => k.app.get(IdleArm).decide({ id: runId }, convRow, "max_steps"));
    expect(await decide()).toMatchObject({ orgId, runAt: expect.any(Number) });
    await withOrgScope(orgId, () =>
      k.app.get(EventLog).append(conv, [
        {
          type: "tool_result",
          runId,
          payload: {
            step: 3,
            callId: "call-unanswered",
            content: "a result the model never saw",
            isError: false,
            toolKey: "NoSuchTool",
          },
        },
      ]),
    );
    expect(await decide()).toBeUndefined();
  });

  it("a failing arm decision (the model registry throws) still finishes the run and owes nothing", async () => {
    const registry = k.app.get(ProviderRegistry);
    const resolve = registry.resolve.bind(registry);
    let armReads = 0;
    vi.spyOn(registry, "resolve").mockImplementation((...args) => {
      // only the arm decision's reads fail; the run's own steps resolve as usual
      if (new Error().stack?.includes("IdleArm")) {
        armReads++;
        return Promise.reject(new Error("model registry unavailable"));
      }
      return resolve(...args);
    });
    const events = await expectNotArmed(undefined);
    expect(events.find((e) => e.type === "run_finished")?.payload).toMatchObject({
      reason: "completed",
    });
    expect(armReads).toBeGreaterThan(0);
  });

  it("owes nothing when the last call's request recorded a fit plan (S7)", async () => {
    const { orgId, conv } = await setup();
    await seedLongHistory(orgId, conv);
    const events = await turn(orgId, conv, "echo:ok");
    const runId = events.find((e) => e.type === "run_finished")?.runId as string;
    const convRow = await convRowOf(conv);
    const decide = () =>
      withOrgScope(orgId, () => k.app.get(IdleArm).decide({ id: runId }, convRow, "completed"));
    expect(await decide()).toMatchObject({ orgId });
    // the in-context build at fire time skips a call whose request carries a fit plan
    await sql`UPDATE capybara.conversation_events
      SET payload = jsonb_set(payload, '{request,fit}', '{"dropped":1}'::jsonb)
      WHERE run_id = ${runId} AND type = 'model_call'`.execute(raw);
    const reasons = skipReasons();
    expect(await decide()).toBeUndefined();
    expect(reasons()).toEqual(["fit_plan"]);
  });

  it("owes nothing when the run was already terminal at its finish", async () => {
    const { finished } = await finishAfter(async (runId) => {
      await db.updateTable("runs").set({ status: "completed" }).where("id", "=", runId).execute();
    });
    expect(finished).toEqual({ status: "fulfilled", value: null });
    expect(await idleRows()).toEqual([]);
  });

  it("owes nothing when the conversation was deleted between the decision and the finish", async () => {
    const { orgId, conv, runId, intent, finished } = await finishAfter(async (_runId, c) => {
      await db
        .updateTable("conversations")
        .set({ deleted_at: new Date() })
        .where("id", "=", c)
        .execute();
    });
    // the worker's execution no longer holds a live conversation: it writes nothing
    expect(finished).toMatchObject({ status: "rejected", reason: expect.any(ExecutionRevoked) });
    expect(await idleRows()).toEqual([]);
    // the terminal transaction itself, with the armed intent: it ends the run, owes no job
    const seq = await withOrgScope(orgId, () =>
      k.app.get(RunFinish).finish({
        conversationId: conv,
        runId,
        status: "completed",
        consumed: null,
        event: { type: "run_finished", payload: { reason: "completed", consumedUpToSeq: 0 } },
        idleCompaction: intent,
      }),
    );
    expect(seq).toEqual(expect.any(Number));
    expect(await idleRows()).toEqual([]);
  });
});

/**
 * Compaction-model mode (compaction model spec §6.1, §6.2): when the org's `compaction` purpose
 * resolves to a usable and eligible model at arm time, the job is due `idleDelayMinutes` after the
 * run's end and carries `mode: "compaction_model"` without the cache fields; the cache lifetime,
 * the quality gate, the fit plan and the settled point do not apply. Otherwise cache mode decides.
 */
describe("arming idle compaction on the compaction model", () => {
  /** The org's compaction settings with `longTtl` off: cache mode alone would arm nothing. */
  const noLongTtl = { promptCache: { longTtl: false } };
  const lowFloor = { idleMinTokensFloor: 50_000, idleMinWindowRatio: 0.1 };

  async function expectCompactionModelRow(
    orgId: string,
    conv: string,
    events: ConversationEvent[],
    delayMinutes: number,
  ): Promise<void> {
    const finished = events.find((e) => e.type === "run_finished") as ConversationEvent;
    const rows = await idleRows();
    expect(rows).toEqual([
      {
        queue: MAINTENANCE_QUEUE_NAME,
        job_name: IDLE_COMPACTION_JOB,
        job_id: idleCompactionJobId(finished.runId as string),
        data: {
          orgId,
          conversationId: conv,
          runId: finished.runId,
          armedSeq: finished.seq,
          mode: "compaction_model",
        },
        run_at: expect.any(Date),
        org_id: orgId,
      },
    ]);
    // `now` is taken just before the terminal transaction (C4): within a second of its event
    const due = finished.createdAt.getTime() + delayMinutes * 60_000;
    const runAt = (rows[0] as { run_at: Date }).run_at.getTime();
    expect(Math.abs(runAt - due)).toBeLessThan(1_000);
  }

  it("with longTtl off and a compaction model mapped, owes a compaction_model job due 30 minutes after the run", async () => {
    const { orgId, conv } = await setup("fake-1", noLongTtl, "fake-c");
    await seedLongHistory(orgId, conv);
    const events = await turn(orgId, conv, "echo:ok");
    expect(events.find((e) => e.type === "run_finished")?.payload).toMatchObject({
      reason: "completed",
    });
    await expectCompactionModelRow(orgId, conv, events, 30);
  });

  it("is due idleDelayMinutes after the run", async () => {
    const { orgId, conv } = await setup(
      "fake-1",
      { ...noLongTtl, compaction: { ...lowFloor, idleDelayMinutes: 5 } },
      "fake-c",
    );
    await seedLongHistory(orgId, conv);
    const events = await turn(orgId, conv, "echo:ok");
    await expectCompactionModelRow(orgId, conv, events, 5);
  });

  it("arms on a conversation model that declares no cache", async () => {
    const { orgId, conv } = await setup("fake-nc", {}, "fake-c");
    await seedLongHistory(orgId, conv);
    const events = await turn(orgId, conv, "echo:ok");
    await expectCompactionModelRow(orgId, conv, events, 30);
  });

  it("still arms a max_steps run with an unanswered tool result after the reply (no settled check)", async () => {
    const { orgId, conv } = await setup("fake-1", noLongTtl, "fake-c");
    await seedLongHistory(orgId, conv);
    const events = await turn(orgId, conv, 'tool:NoSuchTool:{"a":1}');
    const finished = events.find((e) => e.type === "run_finished");
    expect(finished?.payload).toMatchObject({ reason: "max_steps" });
    const runId = finished?.runId as string;
    await withOrgScope(orgId, () =>
      k.app.get(EventLog).append(conv, [
        {
          type: "tool_result",
          runId,
          payload: {
            step: 3,
            callId: "call-unanswered",
            content: "a result the model never saw",
            isError: false,
            toolKey: "NoSuchTool",
          },
        },
      ]),
    );
    const convRow = await convRowOf(conv);
    const before = Date.now();
    const intent = await withOrgScope(orgId, () =>
      k.app.get(IdleArm).decide({ id: runId }, convRow, "max_steps"),
    );
    expect(intent).toEqual({ orgId, mode: "compaction_model", runAt: expect.any(Number) });
    expect((intent?.runAt as number) - before).toBeGreaterThanOrEqual(1_800_000);
    expect((intent?.runAt as number) - Date.now()).toBeLessThanOrEqual(1_800_000);
  });

  it("an ineligible compaction model (32k window) leaves cache mode deciding", async () => {
    await expectNotArmed("short_ttl", { settings: noLongTtl, compactionModel: "fake-c-small" });
    const { orgId, conv } = await setup("fake-1", {}, "fake-c-small");
    await seedLongHistory(orgId, conv);
    await turn(orgId, conv, "echo:ok");
    expect((await idleRows()).map((r) => (r.data as { mode: string }).mode)).toEqual(["cache"]);
  });

  it("a compaction model disabled in the org leaves cache mode deciding", async () => {
    const { orgId, conv } = await setup("fake-1", {}, "fake-c");
    const res = await owner({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/models/model-fake/disabled`,
      payload: { disable: ["fake-c"] },
    });
    expect(res.statusCode, res.body).toBe(200);
    await seedLongHistory(orgId, conv);
    const events = await turn(orgId, conv, "echo:ok");
    const call = events.find((e) => e.type === "model_call");
    const rows = await idleRows();
    expect(rows.map((r) => r.data)).toEqual([
      expect.objectContaining({ mode: "cache", cacheCallSeq: call?.seq }),
    ]);
  });

  it("owes nothing with a compaction model mapped when idle compaction is off, the owner opted out, the run was scheduled or the context is small", async () => {
    await expectNotArmed("disabled", {
      settings: { ...noLongTtl, compaction: { ...lowFloor, idleEnabled: false } },
      compactionModel: "fake-c",
    });
    await expectNotArmed("small", {
      settings: noLongTtl,
      compactionModel: "fake-c",
      long: false,
    });
    onRunning = async (runId) => {
      await sql`UPDATE capybara.conversation_events
        SET payload = jsonb_set(payload, '{trigger}', to_jsonb('schedule'::text))
        WHERE run_id = ${runId} AND type = 'run_started'`.execute(raw);
    };
    await expectNotArmed("trigger", { settings: noLongTtl, compactionModel: "fake-c" });
    onRunning = undefined;
    const res = await owner({
      method: "PUT",
      url: "/api/v1/me/preferences",
      payload: { idleCompaction: "off" },
    });
    expect(res.statusCode, res.body).toBe(200);
    await expectNotArmed("personal_off", { settings: noLongTtl, compactionModel: "fake-c" });
  });

  it("a small context skips before the purpose read (no compaction purpose lookup, no fallback warning)", async () => {
    const purposes = k.app.get(ModelPurposesService);
    const resolve = vi.spyOn(purposes, "resolve");
    const warn = vi.spyOn(
      (k.app.get(IdleArm) as unknown as { log: { warn: (...a: unknown[]) => void } }).log,
      "warn",
    );
    const { orgId, conv } = await setup("fake-1", noLongTtl, "fake-c");
    const reasons = skipReasons();
    await turn(orgId, conv, "echo:ok");
    expect(await idleRows()).toEqual([]);
    expect(reasons()).toEqual(["small"]);
    expect(resolve.mock.calls.filter(([, purpose]) => purpose === "compaction")).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("a failing purpose read (a database error) still finishes the run and owes nothing", async () => {
    const purposes = k.app.get(ModelPurposesService);
    const resolve = purposes.resolve.bind(purposes);
    let reads = 0;
    vi.spyOn(purposes, "resolve").mockImplementation((orgId, purpose) => {
      if (purpose === "compaction") {
        reads++;
        return Promise.reject(new Error("connection terminated unexpectedly"));
      }
      return resolve(orgId, purpose);
    });
    const events = await expectNotArmed(undefined, { compactionModel: "fake-c" });
    expect(events.find((e) => e.type === "run_finished")?.payload).toMatchObject({
      reason: "completed",
    });
    expect(reads).toBeGreaterThan(0);
  });
});
