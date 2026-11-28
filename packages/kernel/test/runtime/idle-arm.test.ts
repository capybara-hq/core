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
import { IdleArm } from "../../src/runtime/idle-arm.js";
import {
  IDLE_COMPACTION_JOB,
  idleCompactionJobId,
} from "../../src/runtime/idle-compaction-jobs.js";
import { MAINTENANCE_QUEUE_NAME } from "../../src/runtime/maintenance-queue.js";
import { ProviderRegistry } from "../../src/runtime/providers.js";
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
    "capybara.accounts, capybara.orgs, capybara.audit_events, capybara.outbox, capybara.deployment_settings",
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

/** An org with the long cache tier and the lowest size floor; a conversation on `model`. */
async function setup(
  model = "fake-1",
  settings: Record<string, unknown> = {},
): Promise<{ orgId: string; conv: string }> {
  const orgId = await createOrgWithProviders(k, owner, `Acme ${++orgCount}`);
  await patchOrg(orgId, {
    promptCache: { longTtl: true },
    compaction: { idleMinTokensFloor: 50_000, idleMinWindowRatio: 0.1 },
    ...settings,
  });
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

/** Runs one long turn on a fresh conversation and expects no idle compaction job owed. */
async function expectNotArmed(
  opts: { model?: string; settings?: Record<string, unknown>; long?: boolean; text?: string } = {},
  before?: (orgId: string, conv: string) => Promise<void>,
): Promise<ConversationEvent[]> {
  const { orgId, conv } = await setup(opts.model, opts.settings);
  if (opts.long !== false) await seedLongHistory(orgId, conv);
  await before?.(orgId, conv);
  const events = await turn(orgId, conv, opts.text ?? "echo:ok");
  expect(events.filter((e) => e.type === "run_finished")).toHaveLength(1);
  expect(await idleRows()).toEqual([]);
  return events;
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
    await expectNotArmed({ settings: { promptCache: { longTtl: false } } });
  });

  it("owes nothing on a model that declares no cache", async () => {
    await expectNotArmed({ model: "fake-nc" });
  });

  it("owes nothing for a context under the size threshold", async () => {
    await expectNotArmed({ long: false });
  });

  it("owes nothing for an automation's run (a scheduled task, an event automation)", async () => {
    for (const trigger of ["schedule", "automation_event"]) {
      await truncateTables(raw, "capybara.outbox");
      onRunning = async (runId) => {
        await sql`UPDATE capybara.conversation_events
          SET payload = jsonb_set(payload, '{trigger}', to_jsonb(${trigger}::text))
          WHERE run_id = ${runId} AND type = 'run_started'`.execute(raw);
      };
      await expectNotArmed();
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
    await expectNotArmed();
  });

  it("owes nothing when the org turned idle compaction or compaction off", async () => {
    await expectNotArmed({
      settings: { compaction: { idleEnabled: false, idleMinTokensFloor: 50_000 } },
    });
    await expectNotArmed({
      settings: { compaction: { enabled: false, idleMinTokensFloor: 50_000 } },
    });
  });

  it("owes nothing when the owner turned idle compaction off", async () => {
    const res = await owner({
      method: "PUT",
      url: "/api/v1/me/preferences",
      payload: { idleCompaction: "off" },
    });
    expect(res.statusCode, res.body).toBe(200);
    await expectNotArmed();
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
    const convRow = await db
      .selectFrom("conversations")
      .select(["id", "org_id", "kind", "account_id"])
      .where("id", "=", conv)
      .executeTakeFirstOrThrow();
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
    const events = await expectNotArmed();
    expect(events.find((e) => e.type === "run_finished")?.payload).toMatchObject({
      reason: "completed",
    });
    expect(armReads).toBeGreaterThan(0);
  });
});
