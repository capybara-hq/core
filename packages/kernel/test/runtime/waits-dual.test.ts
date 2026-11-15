import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { emptyCheckpoint } from "@langchain/langgraph-checkpoint";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentLookup } from "../../src/agents/agent-lookup.js";
import { EventLog } from "../../src/conversations/event-log.js";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { KernelDb } from "../../src/infra/database/kernel-db.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import { OrgLock } from "../../src/orgs/org-lock.js";
import { KyselyCheckpointSaver } from "../../src/runtime/checkpointer.js";
import type { LoopContext, LoopOutcome } from "../../src/runtime/loop.js";
import { assistantIdemKey } from "../../src/runtime/model-call.js";
import { RunExecution } from "../../src/runtime/run-execution.js";
import { RunJobs, runJobId } from "../../src/runtime/run-jobs.js";
import { AGENT_LOOP_FACTORY } from "../../src/runtime/run-steps.js";
import { RunWorker } from "../../src/runtime/run-worker.js";
import { MAINTENANCE_QUEUE_NAME, Waits, waitTimeoutJobId } from "../../src/runtime/waits.js";
import { ToolPipeline, type ToolStepContext } from "../../src/tools/pipeline.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { memState } from "../fixtures/plugins/mem-connector/index.js";
import { toolsCountState } from "../fixtures/plugins/tools-count/index.js";
import { truncateTables } from "../helpers/db.js";
import { onlyBuiltins } from "../helpers/disabled-tools.js";
import { asUser, cookieJar } from "../helpers/http.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createAgent,
  createConv,
  createOrg,
  eventsOf,
  gate,
  PW,
  postMessage,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
  waitFor,
  waitForEvent,
  waitForTerminal,
} from "../helpers/runs.js";

/**
 * Task 9 双副本：两个内核实例（各自的连接池、HTTP 应用与 worker，共用 PG / Redis）。
 * - A 副本执行到审批处暂停，A 停机后 B 副本收到审批决定并从 checkpoint 续跑；
 * - 同一审批的超时任务（B 的维护 worker）与人工决定（A 的 HTTP）竞争：恰好一条决定事件、只续跑一次。
 */

const MEM_CONNECTOR = fileURLToPath(
  new URL("../fixtures/plugins/mem-connector/index.ts", import.meta.url),
);

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let maint: Queue;
/**
 * The client `maint` uses. A queue given a client does not close it, so afterAll quits it before
 * Redis stops: an open client without an error listener reports "[ioredis] Unhandled error event"
 * on every reconnect, which can land after Vitest tore the worker down.
 */
let maintRedis: Redis;
const kernels: TestKernel[] = [];

const config = () =>
  runConfig({ pg: pgc.url, redis: rd.url }, { extensions: [MODEL_FAKE, MEM_CONNECTOR] });
const ECHO = 'tool:plugin__mem-connector__echo:{"text":"hi"}';
const ofType = <T extends ConversationEvent["type"]>(evs: ConversationEvent[], type: T) =>
  evs.filter((e): e is Extract<ConversationEvent, { type: T }> => e.type === type);

async function login(k: TestKernel, jar = cookieJar()): Promise<Req> {
  const req = asUser(k.http, jar);
  const res = await req({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { login: "owner", password: PW },
  });
  expect(res.statusCode).toBe(200);
  return req;
}

async function boot(): Promise<TestKernel> {
  const k = await startKernel(config());
  kernels.push(k);
  return k;
}

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  await migrate(pgc.url, {
    schema: "capybara",
    dir: fileURLToPath(new URL("../../src/migrations", import.meta.url)),
  });
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  maintRedis = new Redis(rd.url);
  maint = new Queue(MAINTENANCE_QUEUE_NAME, { connection: maintRedis });
});

afterAll(async () => {
  await maint?.close();
  await maintRedis?.quit();
  for (const k of kernels) await k.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

let orgId: string;
let agentId: string;

beforeEach(async () => {
  for (const k of kernels.splice(0)) await k.close();
  await truncateTables(raw, "capybara.accounts, capybara.orgs, capybara.audit_events");
  await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" });
  memState().echoCalls = 0;
});

async function setup(req: Req): Promise<void> {
  orgId = await createOrg(req);
  const en = await req({
    method: "PUT",
    url: `/api/v1/orgs/${orgId}/extensions/mem-connector`,
    payload: { enabled: true },
  });
  expect(en.statusCode, en.body).toBe(200);
  const ag = await req({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Helper",
        instructions: "Be helpful.",
        model: { provider: "model-fake", model: "fake-1" },
        disabledTools: onlyBuiltins([{ kind: "plugin", plugin: "mem-connector", name: "echo" }]),
        toolPolicies: { "plugin__mem-connector__echo": "ask" },
      },
      visibility: "org",
    },
  });
  expect(ag.statusCode, ag.body).toBe(201);
  agentId = (ag.json() as { agent: { id: string } }).agent.id;
}

async function waitingApproval(req: Req, convId: string): Promise<{ runId: string; id: string }> {
  await postMessage(req, orgId, convId, ECHO);
  const ev = await waitForEvent(db, convId, (e) => e.type === "approval_requested");
  const runId = ev.runId as string;
  await waitFor(
    async () =>
      (await db.selectFrom("runs").select("status").where("id", "=", runId).executeTakeFirst())
        ?.status === "waiting",
    10_000,
    "run waiting",
  );
  return {
    runId,
    id: (ev as Extract<ConversationEvent, { type: "approval_requested" }>).payload.approvalId,
  };
}

describe("双副本续跑", () => {
  // Boots two kernels in turn and stops one, with a run before and after: about 3 s alone; no fixed
  // sleeps, every wait polls its real condition.
  it("A 副本暂停（随后停机），B 副本收到审批决定并从 checkpoint 续跑", async () => {
    const ka = await boot();
    const jar = cookieJar();
    const reqA = await login(ka, jar);
    await setup(reqA);
    const convId = await createConv(reqA, orgId, agentId);
    const { runId, id } = await waitingApproval(reqA, convId);
    // A 停机：之后只有 B 能执行续跑
    await ka.close();
    kernels.splice(kernels.indexOf(ka), 1);
    const kb = await boot();
    const reqB = asUser(kb.http, jar);
    const res = await reqB({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/approvals/${id}/decision`,
      payload: { decision: "approve" },
    });
    expect(res.statusCode, res.body).toBe(200);
    await waitForTerminal(db, convId, 1);
    const evs = await eventsOf(db, convId);
    expect(memState().echoCalls).toBe(1);
    expect(ofType(evs, "run_finished").map((e) => e.runId)).toEqual([runId]);
    expect(ofType(evs, "tool_result").map((e) => e.payload.content)).toEqual(['{"text":"hi"}']);
    // 第一步的模型回复复用（续跑不重新请求第一步）
    expect(ofType(evs, "model_call").map((e) => e.payload.step)).toEqual([1, 2]);
  });

  // Both paths act at once in every round; where the expiry sits (set on the PG clock, which both
  // paths compare under the approval's row lock) decides the winner, so no round sleeps for it.
  // About 1 s alone; the 30 s timeout is for heavy load.
  it("超时任务（B）与人工决定（A）竞争同一审批：恰好一条决定事件，只续跑一次", async () => {
    const ka = await boot();
    const kb = await boot();
    const jar = cookieJar();
    const reqA = await login(ka, jar);
    await setup(reqA);
    // Rounds: well before the expiry (the decision must win), past it (the timeout must win), and
    // right at it (either may win). The expiry is an offset from PG's now().
    const outcomes: string[] = [];
    for (const expiresIn of ["1 hour", "-1 second", "20 milliseconds"]) {
      const convId = await createConv(reqA, orgId, agentId);
      const { runId, id } = await waitingApproval(reqA, convId);
      const job = await waitFor(() => maint.getJob(waitTimeoutJobId(id)), 15_000, "timeout job");
      await sql`UPDATE capybara.approvals SET expires_at = now() + ${expiresIn}::interval
        WHERE id = ${id}`.execute(raw);
      const [decision] = await Promise.all([
        reqA({
          method: "POST",
          url: `/api/v1/orgs/${orgId}/approvals/${id}/decision`,
          payload: { decision: "approve" },
        }),
        job.promote(),
        kb.app.get(Waits).expire("approval", id),
        ka.app.get(Waits).resume(runId, id),
      ]);
      expect([200, 409]).toContain(decision.statusCode);
      await waitForTerminal(db, convId, 1);
      // A timeout job that ran before the expiry delayed itself again until it: promote it until it
      // has run to completion (removeOnComplete), so its late run is covered by the checks below.
      await waitFor(
        async () => {
          const j = await maint.getJob(waitTimeoutJobId(id));
          if (!j) return true;
          if (await j.isDelayed()) await j.promote().catch(() => undefined);
          return false;
        },
        15_000,
        "timeout job finished",
      );
      const evs = await eventsOf(db, convId);
      const decided = ofType(evs, "approval_decided");
      expect(decided).toHaveLength(1);
      expect(ofType(evs, "run_finished")).toHaveLength(1);
      expect(ofType(evs, "tool_result")).toHaveLength(1);
      // 每一步的模型调用各一次：续跑只发生一次
      expect(ofType(evs, "model_call").map((e) => e.payload.step)).toEqual([1, 2]);
      const approved = decided[0]?.payload.decision === "approved";
      expect(decision.statusCode).toBe(approved ? 200 : 409);
      outcomes.push(decided[0]?.payload.decision ?? "");
    }
    expect(outcomes.slice(0, 2)).toEqual(["approved", "expired"]);
  });
});

describe("execution claim ownership across replicas", () => {
  let pg: TestContainer;
  let redis: TestContainer;
  let k: TestKernel;
  let replica: TestKernel;
  let toolContext: ToolStepContext;
  let scenarioA: (ctx: LoopContext) => Promise<LoopOutcome>;
  let scenarioB: (ctx: LoopContext) => Promise<LoopOutcome>;

  let conversationId: string;
  let runId: string;
  beforeAll(async () => {
    [pg, redis] = await Promise.all([startTestPostgres(), startTestRedis()]);
    const config = runConfig(
      { pg: pg.url, redis: redis.url },
      {
        roles: ["api"],
        extensions: [
          MODEL_FAKE,
          fileURLToPath(new URL("../fixtures/plugins/tools-count/index.ts", import.meta.url)),
        ],
      },
    );
    k = await startKernel(config, {
      overrides: [
        {
          provide: AGENT_LOOP_FACTORY,
          useValue: () => ({ run: (ctx: LoopContext) => scenarioA(ctx) }),
        },
      ],
    });
    replica = await startKernel(config, {
      overrides: [
        {
          provide: AGENT_LOOP_FACTORY,
          useValue: () => ({ run: (ctx: LoopContext) => scenarioB(ctx) }),
        },
      ],
    });
    const db = k.app.get(KernelDb);
    const owner = await accountsFor(db.db).createLocal({
      login: "owner",
      password: PW,
      displayName: "O",
    });
    const req = await session(k, "owner");
    const orgId = await createOrg(req);
    const enabled = await req({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/extensions/tools-count`,
      payload: { enabled: true },
    });
    expect(enabled.statusCode, enabled.body).toBe(200);
    const agentId = await createAgent(req, orgId);
    conversationId = await createConv(req, orgId, agentId);
    runId = randomUUID();
    const agent = (await k.app.get(AgentLookup).get(orgId, agentId, owner.id)).definition;
    toolContext = {
      orgId,
      conversationId,
      runId,
      step: 1,
      agentId,
      agentVersion: 1,
      agent,
      accountId: owner.id,
      source: "web",
      ownerAccountId: owner.id,
      role: "owner",
      signal: new AbortController().signal,
    };
    await db
      .insertInto("runs")
      .values({
        id: runId,
        conversation_id: conversationId,
        trigger_account_id: owner.id,
        trigger_seq: "1",
        agent_version: 1,
        status: "queued",
      })
      .execute();
  });
  afterAll(async () => {
    await replica?.close();
    await k?.close();
    await Promise.all([pg?.stop(), redis?.stop()]);
  });

  it("a replacement claim rejects every old transaction before its first write", async () => {
    const execution = k.app.get(RunExecution);
    const log = k.app.get(EventLog);
    const tx = k.app.get(TransactionHost);
    const db = k.app.get(KernelDb);
    const old = await execution.claim(conversationId, runId, randomUUID());
    expect(old).not.toBeNull();
    const replacement = await replica.app
      .get(RunExecution)
      .claim(conversationId, runId, randomUUID());
    expect(replacement).not.toBeNull();
    if (old === null || replacement === null) throw new Error("missing execution claim");
    const append = () =>
      log.append(conversationId, [
        {
          type: "run_failed",
          runId,
          payload: { error: { code: "run.internal", message: "stale" } },
        },
      ]);
    await expect(execution.withClaim(old, () => true, append)).rejects.toThrow("execution revoked");
    // A builtin tool's transaction must be fenced even when it does not append an event.
    await expect(
      execution.withClaim(
        old,
        () => true,
        () =>
          tx.run(async () => {
            await db
              .updateTable("conversations")
              .set({ title: "stale tool side effect" })
              .where("id", "=", conversationId)
              .execute();
          }),
      ),
    ).rejects.toThrow("execution revoked");
    expect(
      (
        await db
          .selectFrom("conversations")
          .select("title")
          .where("id", "=", conversationId)
          .executeTakeFirst()
      )?.title,
    ).not.toBe("stale tool side effect");
    const saver = k.app.get(KyselyCheckpointSaver);
    const config = { configurable: { thread_id: runId } };
    const checkpoint = emptyCheckpoint();
    await replica.app.get(RunExecution).withClaim(
      replacement,
      () => true,
      () =>
        replica.app
          .get(KyselyCheckpointSaver)
          .put(config, checkpoint, { source: "loop", step: 1, parents: {} }, {}),
    );
    await expect(
      execution.withClaim(
        old,
        () => true,
        () => saver.put(config, emptyCheckpoint(), { source: "loop", step: 2, parents: {} }, {}),
      ),
    ).rejects.toThrow("execution revoked");
    await expect(
      execution.withClaim(
        old,
        () => true,
        () => saver.deleteThread(runId),
      ),
    ).rejects.toThrow("execution revoked");
    expect((await saver.getTuple(config))?.checkpoint.id).toBe(checkpoint.id);
    const tool = (
      await k.app.get(ToolRegistry).forAgent(toolContext.orgId, { source: "web" })
    ).tools.find((t) => t.key === "plugin__tools-count__count");
    expect(tool).toBeDefined();
    if (!tool) throw new Error("missing counter tool");
    toolsCountState().count = 0;
    await execution.withClaim(
      old,
      () => true,
      () => k.app.get(ToolPipeline).execute(tool, { n: 1 }, toolContext, "old-call"),
    );
    expect(toolsCountState().count).toBe(0);
    await execution.withClaim(
      replacement,
      () => true,
      () => k.app.get(ToolPipeline).execute(tool, { n: 1 }, toolContext, "new-call"),
    );
    expect(toolsCountState().count).toBe(1);
    const snapshot = await execution.withClaim(
      replacement,
      () => true,
      () =>
        tx.run(
          () =>
            db.selectFrom("runs").select("id").where("id", "=", runId).executeTakeFirstOrThrow(),
          {
            propagation: "requires_new",
            isolationLevel: "repeatable read",
            accessMode: "read only",
          },
        ),
    );
    expect(snapshot.id).toBe(runId);
    await execution.withClaim(replacement, () => true, append);
    await expect(execution.withClaim(replacement, () => false, append)).rejects.toThrow(
      "execution revoked",
    );
  });

  it("a lost acquisition cannot overwrite a replacement claim after waiting for admission", async () => {
    const execution = k.app.get(RunExecution);
    const current = await replica.app.get(RunExecution).claim(conversationId, runId, randomUUID());
    if (!current) throw new Error("missing replacement claim");
    const entered = gate();
    let live = true;
    let pending = Promise.resolve<Awaited<ReturnType<RunExecution["claim"]>>>(null);
    await k.app.get(TransactionHost).run(async () => {
      await k.app
        .get(OrgLock)
        .lockAndAuthorize(toolContext.orgId, toolContext.accountId, "org.update");
      pending = execution.claim(conversationId, runId, randomUUID(), () => {
        entered.open();
        return live;
      });
      await entered.promise;
      live = false;
    });
    const obsolete = await pending;
    expect(obsolete).toBeNull();
    await replica.app.get(RunExecution).withClaim(
      current,
      () => true,
      () => replica.app.get(TransactionHost).run(async () => {}),
    );
  });

  it("admits org writes before conversation locks so offboarding cannot invert their order", async () => {
    const replacement = await replica.app
      .get(RunExecution)
      .claim(conversationId, runId, randomUUID());
    if (!replacement) throw new Error("missing replacement claim");
    const db = k.app.get(KernelDb);
    let workerEntered = false;
    let worker: Promise<void> = Promise.resolve();
    try {
      await k.app.get(TransactionHost).run(async () => {
        // The beginning of offboarding: org authorization, then the member's conversation tree.
        await k.app
          .get(OrgLock)
          .lockAndAuthorize(toolContext.orgId, toolContext.accountId, "org.members.manage");
        worker = replica.app.get(RunExecution).withClaim(
          replacement,
          () => true,
          () =>
            replica.app.get(TransactionHost).run(async () => {
              workerEntered = true;
              // A Platform org write reauthorizes with this same lock inside its service.
              await replica.app
                .get(OrgLock)
                .lockAndAuthorize(toolContext.orgId, toolContext.accountId, "org.update");
            }),
        );
        await waitFor(
          async () =>
            (
              await sql<{ blocked: boolean }>`select exists (
        select 1 from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid()
        and wait_event_type = 'Lock') as blocked`.execute(db.db)
            ).rows[0]?.blocked,
          5_000,
          "worker waiting for org admission",
        );
        expect(workerEntered).toBe(false);
        await db
          .selectFrom("conversations")
          .select("id")
          .where("id", "=", conversationId)
          .forUpdate()
          .execute();
      });
    } finally {
      await worker;
    }
    expect(workerEntered).toBe(true);
  });
  it("a real replacement worker fences a paused old worker before its tool and checkpoint writes", async () => {
    const req = await session(k, "owner");
    const conv = await createConv(req, toolContext.orgId, toolContext.agentId);
    const seq = await postMessage(req, toolContext.orgId, conv, "takeover");
    const job = await waitFor(
      () => k.app.get(RunJobs).getJob(runJobId(conv, seq)),
      5_000,
      "queued takeover job",
    );
    const oldEntered = gate();
    const newEntered = gate();
    const releaseOld = gate();
    const releaseNew = gate();
    const rejected: boolean[] = [];
    const checkpoint = emptyCheckpoint();
    const contextOf = (ctx: LoopContext): ToolStepContext => ({
      ...ctx,
      step: 1,
      accountId: ctx.triggerAccountId,
    });
    const attempt = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
        rejected.push(false);
      } catch (error) {
        rejected.push(error instanceof Error && error.message === "execution revoked");
      }
    };
    scenarioA = async (ctx) => {
      await k.app.get(EventLog).append(conv, [
        {
          type: "assistant_message",
          runId: ctx.runId,
          idemKey: assistantIdemKey(ctx.runId, 1),
          payload: {
            step: 1,
            content: [
              {
                type: "tool_call",
                id: "effect",
                name: "plugin__tools-count__count",
                input: { n: 1 },
              },
            ],
            stopReason: "tool_use",
          },
        },
      ]);
      oldEntered.open();
      await releaseOld.promise;
      await attempt(() => k.app.get(ToolPipeline).runStep(contextOf(ctx)));
      await attempt(() => k.app.get(KyselyCheckpointSaver).deleteThread(ctx.runId));
      await attempt(() =>
        k.app.get(EventLog).append(conv, [
          {
            type: "run_failed",
            runId: ctx.runId,
            payload: { error: { code: "run.internal", message: "stale worker" } },
          },
        ]),
      );
      return { kind: "completed", consumedUpToSeq: seq };
    };
    scenarioB = async (ctx) => {
      await replica.app
        .get(KyselyCheckpointSaver)
        .put(
          { configurable: { thread_id: ctx.runId } },
          checkpoint,
          { source: "loop", step: 1, parents: {} },
          {},
        );
      newEntered.open();
      await releaseNew.promise;
      await replica.app.get(ToolPipeline).runStep(contextOf(ctx));
      return { kind: "completed", consumedUpToSeq: seq };
    };
    const observer = new Redis(redis.url);
    const delayed = vi.spyOn(job, "moveToDelayed").mockResolvedValue(undefined);
    toolsCountState().count = 0;
    const oldRun = k.app
      .get(RunWorker)
      .process(job, undefined)
      .catch((error: unknown) => error);
    let newRun: Promise<unknown> = Promise.resolve();
    try {
      await oldEntered.promise;
      // Force lease expiry without sleeping; B takes the same run on its own pool and worker.
      await observer.del(`capk:conv-run:${conv}`);
      newRun = replica.app.get(RunWorker).process(job, undefined);
      await newEntered.promise;
      releaseOld.open();
      await oldRun;
      expect(rejected).toEqual([true, true, true]);
      expect(toolsCountState().count).toBe(0);
      expect(
        (
          await replica.app
            .get(KyselyCheckpointSaver)
            .getTuple({ configurable: { thread_id: job.data.runId } })
        )?.checkpoint.id,
      ).toBe(checkpoint.id);
      expect(await observer.zcard(`capk:org-runs:${toolContext.orgId}`)).toBe(1);
      releaseNew.open();
      await newRun;
      expect(toolsCountState().count).toBe(1);
      expect(
        (
          await k.app
            .get(KernelDb)
            .selectFrom("runs")
            .select("status")
            .where("id", "=", job.data.runId)
            .executeTakeFirst()
        )?.status,
      ).toBe("completed");
    } finally {
      releaseOld.open();
      releaseNew.open();
      await Promise.allSettled([oldRun, newRun]);
      delayed.mockRestore();
      observer.disconnect();
    }
  });
});
