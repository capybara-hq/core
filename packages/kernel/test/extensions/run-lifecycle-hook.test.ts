import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { RunLifecyclePayload, TriggerEvent, TriggerSubject } from "@capybara-hq/plugin-sdk";
import {
  fakeExtensionEntry,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { SchedulerRegistry } from "@nestjs/schedule";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TriggerDispatcher } from "../../src/automations/events/dispatcher.js";
import { TriggerEventSweepJob } from "../../src/automations/events/sweep.job.js";
import { AUTOMATION_SCAN_JOB, TRIGGER_EVENT_SWEEP_JOB } from "../../src/automations/job-ids.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { LifecycleHooks } from "../../src/extensions/lifecycle-hooks.js";
import { RUN_LIFECYCLE_JOB, runLifecycleJobId } from "../../src/extensions/run-lifecycle-owe.js";
import { withOrgScope } from "../../src/infra/database/org-scope.js";
import { OUTBOX_DISPATCH_FAILS } from "../../src/infra/outbox/outbox.dispatcher.js";
import { MAINTENANCE_QUEUE_NAME } from "../../src/runtime/maintenance-queue.js";
import { RunFinish } from "../../src/runtime/run-finish.js";
import { memState } from "../fixtures/plugins/mem-connector/index.js";
import { truncateTables } from "../helpers/db.js";
import { onlyBuiltins } from "../helpers/disabled-tools.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createConv,
  createOrgWithProviders,
  PW,
  postMessage,
  type Req,
  runConfig,
  runsOf,
  session,
  startKernel,
  type TestKernel,
  waitFor,
  waitForEvent,
  waitForTerminal,
} from "../helpers/runs.js";

/**
 * `run.lifecycle` (collaboration spec §4.8): the plugin named by a conversation's `subject.source`
 * hears, durably and observe-only, that a run started, waited on a person, resumed, finished,
 * failed or was aborted; the source plugin of a directed event hears `offer_declined` when the
 * work was not run (the person's rule is off, they declined the offer, their acceptance automation
 * is paused, the offer expired, or the event stayed undelivered). Only a plugin that declares the
 * hook and is enabled in the org (when owed and when delivered) is told; a conversation without a
 * subject tells nobody.
 */

const MEM_CONNECTOR = fileURLToPath(
  new URL("../fixtures/plugins/mem-connector/index.ts", import.meta.url),
);
const RUN_PLUGIN = "fake-run-lifecycle";
const SOURCE = "fake-trigger-source";
const ECHO = 'tool:plugin__mem-connector__echo:{"text":"hi"}';
const ITEM: TriggerSubject = { kind: "item", id: "ITEM-1", title: "First item" };

let pgc: TestContainer;
let rd: TestContainer;
let k: TestKernel;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let owner: Req;
let ownerId: string;
let orgId: string;
let agentId: string;
let seq = 0;

interface RunProbe {
  calls: RunLifecyclePayload[];
  failTimes?: number;
}
const runProbe = (): RunProbe => {
  const g = globalThis as { __fakeRunLifecycle?: RunProbe };
  g.__fakeRunLifecycle ??= { calls: [] };
  return g.__fakeRunLifecycle;
};
interface SourceProbe {
  emit?: (e: TriggerEvent) => Promise<{ eventId: string; duplicate: boolean }>;
  lifecycle?: RunLifecyclePayload[];
}
const sourceProbe = (): SourceProbe => {
  const g = globalThis as { __fakeTriggerSource?: SourceProbe };
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
        extensions: [
          MODEL_FAKE,
          MEM_CONNECTOR,
          fakeExtensionEntry(RUN_PLUGIN),
          fakeExtensionEntry(SOURCE),
        ],
        auth: { cookieSecure: false },
      },
    ),
    {
      // directed events are dispatched by the tests; their automation runs are not needed
      overrides: [
        {
          provide: OUTBOX_DISPATCH_FAILS,
          useValue: (queue: string) => queue === MAINTENANCE_QUEUE_NAME,
        },
      ],
    },
  );
  k.app.get(SchedulerRegistry).getCronJob(TRIGGER_EVENT_SWEEP_JOB).stop();
  k.app.get(SchedulerRegistry).getCronJob(AUTOMATION_SCAN_JOB).stop();
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
});

afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

const enable = async (plugin: string) => {
  const res = await owner({
    method: "PUT",
    url: `/api/v1/orgs/${orgId}/extensions/${plugin}`,
    payload: { enabled: true },
  });
  expect(res.statusCode, res.body).toBe(200);
};

beforeEach(async () => {
  runProbe().calls.length = 0;
  delete runProbe().failTimes;
  sourceProbe().lifecycle = [];
  memState().echoCalls = 0;
  await truncateTables(raw, "capybara.accounts, capybara.orgs, capybara.outbox");
  ownerId = (
    await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "Olga" })
  ).id;
  owner = await session(k, "owner");
  orgId = await createOrgWithProviders(k, owner, "Acme");
  for (const p of [RUN_PLUGIN, SOURCE, "mem-connector"]) await enable(p);
  const ag = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Watcher",
        instructions: "Work.",
        model: { provider: "model-fake", model: "fake-1" },
        disabledTools: onlyBuiltins([{ kind: "plugin", plugin: "mem-connector", name: "echo" }]),
        toolPolicies: { "plugin__mem-connector__echo": "ask" },
      },
      visibility: "org",
    },
  });
  expect(ag.statusCode, ag.body).toBe(201);
  agentId = (ag.json() as { agent: { id: string } }).agent.id;
});

/** A conversation of the agent, with `source` as its subject's plugin (none: no subject). */
async function subjectConv(source: string | null): Promise<string> {
  const id = await createConv(owner, orgId, agentId);
  if (source !== null) {
    await db
      .updateTable("conversations")
      .set({ subject: JSON.stringify({ source, kind: "item", id: "ITEM-1", title: "First" }) })
      .where("id", "=", id)
      .execute();
  }
  return id;
}

const phases = () => runProbe().calls.map((c) => c.phase);
const delivered = (n: number) =>
  waitFor(async () => (runProbe().calls.length >= n ? runProbe().calls : null), 20_000, "hooks");

describe("run.lifecycle: runs", () => {
  it("a subject conversation's run produces started then finished, for its plugin only", async () => {
    const conv = await subjectConv(RUN_PLUGIN);
    await postMessage(owner, orgId, conv, "hello");
    const calls = await delivered(2);
    expect(calls.map((c) => c.phase)).toEqual(["started", "finished"]);
    const [run] = await runsOf(db, conv);
    const row = await db
      .selectFrom("runs")
      .select("agent_version")
      .where("id", "=", run?.id as string)
      .executeTakeFirstOrThrow();
    expect(calls[0]).toEqual({
      orgId,
      accountId: ownerId,
      agentId,
      agentVersion: row.agent_version,
      conversationId: conv,
      runId: run?.id,
      phase: "started",
      subject: { kind: "item", id: "ITEM-1" },
    });
    expect(calls[1]).toMatchObject({ runId: run?.id, conversationId: conv, phase: "finished" });
    // the other subscribing plugin of the org is not the subject's: it hears nothing
    expect(sourceProbe().lifecycle).toEqual([]);
  });

  it("a run waiting on an approval produces waiting, then resumed once decided, then finished", async () => {
    const conv = await subjectConv(RUN_PLUGIN);
    await postMessage(owner, orgId, conv, ECHO);
    const asked = await waitForEvent(
      db,
      conv,
      (e) => e.type === "approval_requested",
      15_000,
      "approval",
    );
    const waiting = (await delivered(2))[1];
    expect(waiting).toMatchObject({
      phase: "waiting",
      waitingOn: "approval",
      runId: asked.runId,
      conversationId: conv,
    });
    const approvalId = (asked.payload as { approvalId: string }).approvalId;
    const res = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/approvals/${approvalId}/decision`,
      payload: { decision: "approve" },
    });
    expect(res.statusCode, res.body).toBe(200);
    await delivered(4);
    expect(phases()).toEqual(["started", "waiting", "resumed", "finished"]);
    expect(runProbe().calls[2]).toMatchObject({
      phase: "resumed",
      waitingOn: "approval",
      runId: asked.runId,
      conversationId: conv,
    });
    expect(
      runLifecycleJobId({ id: asked.runId as string, phase: "resumed", waitId: approvalId }),
    ).toBe(`hook-run-lifecycle-${asked.runId}-resumed-${approvalId}`);
  });

  it("drops a delivery at its time when the org switched the plugin off after it was owed", async () => {
    const off = await owner({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/extensions/${RUN_PLUGIN}`,
      payload: { enabled: false },
    });
    expect(off.statusCode, off.body).toBe(200);
    await k.app.get(LifecycleHooks).process(
      {
        mount: "run.lifecycle",
        plugin: RUN_PLUGIN,
        payload: {
          orgId,
          accountId: ownerId,
          agentId,
          agentVersion: 1,
          conversationId: randomUUID(),
          runId: randomUUID(),
          phase: "started",
          subject: { kind: "item", id: "ITEM-1" },
        },
      },
      new AbortController().signal,
    );
    expect(runProbe().calls).toEqual([]);
  });

  it("a stopped run produces aborted", async () => {
    const conv = await subjectConv(RUN_PLUGIN);
    await postMessage(owner, orgId, conv, ECHO);
    await waitForEvent(db, conv, (e) => e.type === "approval_requested", 15_000, "approval");
    await delivered(2);
    const res = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/conversations/${conv}/abort`,
    });
    expect(res.statusCode, res.body).toBe(202);
    await waitForTerminal(db, conv);
    await delivered(3);
    expect(phases()).toEqual(["started", "waiting", "aborted"]);
  });

  it("a compact run's end is not told (it was never announced)", async () => {
    const conv = await subjectConv(RUN_PLUGIN);
    const runId = randomUUID();
    await db
      .insertInto("runs")
      .values({
        id: runId,
        conversation_id: conv,
        status: "running",
        agent_version: 1,
        trigger_account_id: ownerId,
        trigger_seq: 0,
        compact: true,
      })
      .execute();
    const toSeq = await k.app.get(RunFinish).finish({
      conversationId: conv,
      runId,
      status: "completed",
      consumed: null,
      event: { type: "run_finished", payload: { reason: "completed", consumedUpToSeq: 0 } },
    });
    expect(toSeq).not.toBeNull();
    const owed = await db
      .selectFrom("outbox")
      .select("job_id")
      .where("job_name", "=", RUN_LIFECYCLE_JOB)
      .execute();
    expect(owed).toEqual([]);
    expect(runProbe().calls).toEqual([]);
  });

  it("a conversation without a subject produces nothing", async () => {
    const plain = await subjectConv(null);
    await postMessage(owner, orgId, plain, "hello");
    await waitForTerminal(db, plain);
    const withSubject = await subjectConv(RUN_PLUGIN);
    await postMessage(owner, orgId, withSubject, "hello");
    await delivered(2);
    // every payload so far is the subject conversation's; the plain run owed no job
    expect(runProbe().calls.every((c) => c.conversationId === withSubject)).toBe(true);
    const [run] = await runsOf(db, plain);
    const rows = await db
      .selectFrom("outbox")
      .select("job_id")
      .where("job_name", "=", RUN_LIFECYCLE_JOB)
      .where("job_id", "like", `%${run?.id}%`)
      .execute();
    expect(rows).toEqual([]);
  });

  it("a plugin the org switched off, or not subscribed, is told nothing", async () => {
    const off = await owner({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/extensions/${RUN_PLUGIN}`,
      payload: { enabled: false },
    });
    expect(off.statusCode, off.body).toBe(200);
    const conv = await subjectConv(RUN_PLUGIN);
    await postMessage(owner, orgId, conv, "hello");
    await waitForTerminal(db, conv);
    const [run] = await runsOf(db, conv);
    const owed = await db
      .selectFrom("outbox")
      .select("job_id")
      .where("job_name", "=", RUN_LIFECYCLE_JOB)
      .where("job_id", "like", `%${run?.id}%`)
      .execute();
    expect(owed).toEqual([]);
    expect(runProbe().calls).toEqual([]);
  });

  it("owes each delivery in the run's transaction under a deterministic id, and retries a failing handler", async () => {
    runProbe().failTimes = 1;
    const conv = await subjectConv(RUN_PLUGIN);
    await postMessage(owner, orgId, conv, "hello");
    // `started` throws once (recorded, then retried by the queue), so it appears twice
    await waitFor(
      async () => (phases().filter((p) => p === "started").length >= 2 ? true : null),
      30_000,
      "started retried",
    );
    await delivered(3);
    expect(phases()).toContain("finished");
    // the run still completed: a hook failure never affects it
    const [run] = await runsOf(db, conv);
    expect(run?.status).toBe("completed");
    expect(runLifecycleJobId({ id: run?.id as string, phase: "started" })).toBe(
      `hook-run-lifecycle-${run?.id}-started`,
    );
  });
});

describe("run.lifecycle: offer_declined", () => {
  const dispatch = (eventId: string) =>
    withOrgScope(orgId, () => k.app.get(TriggerDispatcher).dispatch({ orgId, eventId }));

  type Assigned = { eventId: string; dedupeKey: string };

  async function assign(subject: TriggerSubject = ITEM): Promise<Assigned> {
    const emit = sourceProbe().emit;
    if (!emit) throw new Error("fake-trigger-source did not set up");
    const dedupeKey = `key-${randomUUID()}-${++seq}`;
    const r = await emit({
      orgId,
      type: "item.assigned",
      subject,
      facts: { status: "open" },
      summary: "Assigned.",
      dedupeKey,
      audience: { accountId: ownerId, agentId },
      cause: { accountId: ownerId },
    });
    return { eventId: r.eventId, dedupeKey };
  }

  const setRule = async (mode: "auto" | "confirm" | "off") => {
    const res = await owner({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/automations/acceptance`,
      payload: { rules: [{ source: SOURCE, mode }] },
    });
    expect(res.statusCode, res.body).toBe(200);
  };

  const told = () =>
    waitFor(
      async () => ((sourceProbe().lifecycle ?? []).length > 0 ? sourceProbe().lifecycle : null),
      20_000,
      "offer_declined",
    );

  const expected = (reason: string, event: Assigned, subject: TriggerSubject = ITEM) => ({
    orgId,
    accountId: ownerId,
    agentId,
    phase: "offer_declined",
    subject: { kind: subject.kind, id: subject.id },
    reason,
    eventId: event.eventId,
    dedupeKey: event.dedupeKey,
  });

  it("a rule that is off produces offer_declined with reason off, to the event's plugin only", async () => {
    await setRule("off");
    const e = await assign();
    await dispatch(e.eventId);
    expect(await told()).toEqual([expected("off", e)]);
    expect(runProbe().calls).toEqual([]);
  });

  it("a declined offer produces offer_declined with reason declined", async () => {
    await setRule("confirm");
    const e = await assign();
    await dispatch(e.eventId);
    expect(sourceProbe().lifecycle).toEqual([]);
    const offer = await db
      .selectFrom("automation_offers")
      .select("id")
      .where("org_id", "=", orgId)
      .executeTakeFirstOrThrow();
    const res = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/automations/offers/${offer.id}/decline`,
    });
    expect(res.statusCode, res.body).toBe(204);
    expect(await told()).toEqual([expected("declined", e)]);
  });

  it("a paused acceptance automation produces offer_declined with reason paused", async () => {
    await dispatch((await assign()).eventId);
    const a = await db
      .selectFrom("automations")
      .select("id")
      .where("org_id", "=", orgId)
      .where("origin", "=", "acceptance")
      .executeTakeFirstOrThrow();
    const paused = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/automations/${a.id}/pause`,
    });
    expect(paused.statusCode, paused.body).toBe(200);
    const other: TriggerSubject = { kind: "item", id: "ITEM-2", title: "Second" };
    const e = await assign(other);
    await dispatch(e.eventId);
    expect(await told()).toEqual([expected("paused", e, other)]);
  });

  it("an offer the sweep expires produces offer_declined with reason expired", async () => {
    await setRule("confirm");
    const e = await assign();
    await dispatch(e.eventId);
    await db
      .updateTable("automation_offers")
      .set({ created_at: new Date(Date.now() - 8 * 86_400_000) })
      .where("org_id", "=", orgId)
      .execute();
    expect((await k.app.get(TriggerEventSweepJob).sweepAt(new Date())).expiredOffers).toBe(1);
    expect(await told()).toEqual([expected("expired", e)]);
  });

  it("a directed event the sweep gives up on produces offer_declined with reason undelivered", async () => {
    const id = randomUUID();
    await db
      .insertInto("trigger_events")
      .values({
        id,
        org_id: orgId,
        plugin: SOURCE,
        type: "item.assigned",
        subject: JSON.stringify(ITEM),
        facts: JSON.stringify({ status: "open" }),
        summary: "Assigned before.",
        dedupe_key: `emitter-key-${id}`,
        audience: JSON.stringify({ accountId: ownerId, agentId }),
        state: "pending",
        created_at: new Date(Date.now() - 25 * 3_600_000),
      })
      .execute();
    await k.app.get(TriggerEventSweepJob).sweepAt(new Date());
    expect(await told()).toEqual([
      expected("undelivered", { eventId: id, dedupeKey: `emitter-key-${id}` }),
    ]);
  });

  it("a plugin that did not declare run.lifecycle is told nothing", async () => {
    await sql`UPDATE capybara.extension_permission_snapshots
      SET permissions = jsonb_set(permissions, '{permissions,hooks}', '[]'::jsonb)
      WHERE plugin = ${SOURCE}`.execute(raw);
    await setRule("off");
    const { eventId: e } = await assign();
    await dispatch(e);
    const state = await db
      .selectFrom("trigger_events")
      .select("state")
      .where("id", "=", e)
      .executeTakeFirstOrThrow();
    expect(state.state).toBe("dispatched");
    const owed = await db
      .selectFrom("outbox")
      .select("job_id")
      .where("job_id", "=", runLifecycleJobId({ id: e, phase: "offer_declined" }))
      .execute();
    expect(owed).toEqual([]);
    expect(sourceProbe().lifecycle).toEqual([]);
  });
});
