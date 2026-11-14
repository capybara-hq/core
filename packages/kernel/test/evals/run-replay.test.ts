import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EventLog } from "../../src/conversations/event-log.js";
import type { ConversationEvent, EventPayload } from "../../src/conversations/events.js";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { REPLAY_NO_RECORDING } from "../../src/evals/recorded-tools.js";
import type { EvalReplayHooks, RunReplayResult } from "../../src/evals/run-replay.js";
import type { EvalResultView, EvalRunView } from "../../src/evals/runs.service.js";
import type { EvalSetView } from "../../src/evals/sets.service.js";
import type { TrajectoryDetail, TrajectoryListItem } from "../../src/evals/trajectory.service.js";
import { EVAL_REPLAY_HOOKS } from "../../src/evals/worker.js";
import { INPUT_SKIPPED_TEXT } from "../../src/tools/pipeline.js";
import { readFakeSandboxOps } from "../fixtures/plugins/sandbox-fake/index.js";
import { toolsCountState } from "../fixtures/plugins/tools-count/index.js";
import { eventLogFor, legacyDbFor } from "../helpers/conversations.js";
import { onlyBuiltins } from "../helpers/disabled-tools.js";
import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
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
  waitForTerminal,
} from "../helpers/runs.js";

/**
 * 整轮回放（T5，C6 / Review Focus 3）：在 `kind = 'eval'` 的隐藏对话里跑真实 loop，工具结果只回放原运行记录的，
 * 任何真实工具、沙箱、连接器或审批都不触发。
 */

const TOOLS_COUNT = fileURLToPath(
  new URL("../fixtures/plugins/tools-count/index.ts", import.meta.url),
);
const SANDBOX_FAKE = fileURLToPath(
  new URL("../fixtures/plugins/sandbox-fake/index.ts", import.meta.url),
);

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;
let eventLog: EventLog;
let root: string;
/** 置为 true 时，下一个用例在种子写好之后、loop 开始之前模拟崩溃一次。 */
let crashOnce = false;
let crashes = 0;
/** 置为 true 时，下一个用例在种子写好之后把评测运行置为取消、再模拟崩溃一次。 */
let cancelThenCrash = false;
/** 模拟检查 / 计费时的 DB 故障：剩余次数（-1 = 一直失败）。 */
let checkFailures = 0;
let chargeFailures = 0;
let checkFailed = 0;
let chargeFailed = 0;
/** 置为 true 时删除评测对话一律失败。 */
let deleteFails = false;
/** Runs once after the next case is seeded (before its replay resolves any model). */
let onSeeded: (() => Promise<void>) | undefined;

let owner: Req;
let admin: Req;
let adminId: string;
let orgId: string;
let agentId: string;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = legacyDbFor(raw);
  eventLog = eventLogFor(db, { publish: async () => {} });
  root = await mkdtemp(join(tmpdir(), "cap-run-replay-"));
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensions: [MODEL_FAKE, TOOLS_COUNT, SANDBOX_FAKE],
        extensionConfig: {
          "sandbox-fake": { root },
          "model-fake": { models: [{ id: "fake-1" }, { id: "fake-2" }] },
        },
        evals: { orgConcurrency: 2 },
      },
    ),
    {
      // the replay and judge test hooks are a provider override (a test seam)
      overrides: [
        {
          provide: EVAL_REPLAY_HOOKS,
          useValue: {
            async afterRunSeeded(evalRunId) {
              if (onSeeded) {
                const f = onSeeded;
                onSeeded = undefined;
                await f();
              }
              if (cancelThenCrash) {
                cancelThenCrash = false;
                await db
                  .updateTable("eval_runs")
                  .set({ status: "cancelled", finished_at: new Date() })
                  .where("id", "=", evalRunId)
                  .execute();
                throw new Error("simulated crash after seeding (run cancelled meanwhile)");
              }
              if (!crashOnce) return;
              crashOnce = false;
              crashes++;
              throw new Error("simulated crash after seeding");
            },
            async beforeCheck() {
              if (checkFailures === 0) return;
              if (checkFailures > 0) checkFailures--;
              checkFailed++;
              throw new Error("simulated PG error in the request check");
            },
            async beforeDeleteConversation() {
              if (deleteFails)
                throw new Error("simulated PG error while deleting the eval conversation");
            },
            async beforeCharge() {
              if (chargeFailures === 0) return;
              if (chargeFailures > 0) chargeFailures--;
              chargeFailed++;
              throw new Error("simulated PG error while charging");
            },
          } satisfies EvalReplayHooks,
        },
      ],
    },
  );
  const accounts = accountsFor(db);
  const ownerId = (await accounts.createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  adminId = (await accounts.createLocal({ login: "admin", password: PW, displayName: "A" })).id;
  owner = await session(k, "owner");
  orgId = await createOrg(owner);
  await testMembers(db).add(orgId, adminId, "admin", ownerId);
  admin = await session(k, "admin");
  const en = await owner({
    method: "PUT",
    url: `/api/v1/orgs/${orgId}/extensions/tools-count`,
    payload: { enabled: true },
  });
  expect(en.statusCode, en.body).toBe(200);
  const res = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Replayer",
        instructions: "Use tools.",
        model: { provider: "model-fake", model: "fake-1" },
        disabledTools: onlyBuiltins([
          { kind: "plugin", plugin: "tools-count", name: "count" },
          { kind: "plugin", plugin: "tools-count", name: "ask" },
          { kind: "builtin", name: "Bash" },
        ]),
      },
      visibility: "org",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  agentId = (res.json() as { agent: { id: string } }).agent.id;
}, 180_000);

afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
  if (root) await rm(root, { recursive: true, force: true });
});

const setsUrl = () => `/api/v1/orgs/${orgId}/eval-sets`;
const runsUrl = () => `/api/v1/orgs/${orgId}/eval-runs`;

async function createSet(): Promise<string> {
  const res = await admin({ method: "POST", url: setsUrl(), payload: { agentId, name: "Run" } });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { set: EvalSetView }).set.id;
}

async function addCase(setId: string, conversationId: string, runId: string): Promise<void> {
  const res = await admin({
    method: "POST",
    url: `${setsUrl()}/${setId}/cases`,
    payload: { conversationId, runId },
  });
  expect(res.statusCode, res.body).toBe(201);
}

async function startRun(setId: string, body: Record<string, unknown>): Promise<EvalRunView> {
  const res = await admin({
    method: "POST",
    url: `${setsUrl()}/${setId}/runs`,
    payload: { mode: "run", candidate: {}, judge: false, ...body },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { run: EvalRunView }).run;
}

async function getRun(runId: string): Promise<EvalRunView> {
  const res = await admin({ method: "GET", url: `${runsUrl()}/${runId}` });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { run: EvalRunView }).run;
}

async function results(runId: string): Promise<EvalResultView[]> {
  const res = await admin({ method: "GET", url: `${runsUrl()}/${runId}/results?limit=200` });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { results: EvalResultView[] }).results;
}

const finished = (runId: string, timeoutMs = 30_000) =>
  waitFor(
    async () => {
      const r = await getRun(runId);
      return ["queued", "running"].includes(r.status) ? null : r;
    },
    timeoutMs,
    "eval run finished",
    100,
  );

const approvalsCount = async () =>
  Number(
    (
      await db
        .selectFrom("approvals")
        .select((eb) => eb.fn.countAll().as("n"))
        .executeTakeFirstOrThrow()
    ).n,
  );

type Baseline = {
  toolCalls: { name: string; input: unknown }[];
  finalContent: unknown[];
  stopReason: string | null;
};

/**
 * 直接写日志的一次原运行（用于对照记录与模型现在给出的调用）：
 * user_message（`text`）→ run_started → 第 1 步 model_call（absorbedUpToSeq = 该消息）→
 * [可选：运行中途到达的插话] → 第 1 步回复（`recorded` 里的工具调用）→ 每个调用的开始与结果 →
 * 第 2 步 model_call（absorbedUpToSeq = 插话或原消息）→ 文本回复 → run_finished。
 */
async function seedRun(
  convId: string,
  runId: string,
  text: string,
  recorded: { name: string; input: unknown; content: string }[],
  /**
   * A message, a finished background task (background Bash §4.4) or a sub-agent delivery (agent
   * map spec §5.2), landing during step 1.
   */
  interjection?:
    | string
    | { finished: EventPayload<"background_task_finished"> }
    | { delivery: EventPayload<"subagent_delivery"> },
  catalog?: EventPayload<"skills_catalog">,
  runContext?: EventPayload<"run_context">,
  pluginContexts: EventPayload<"plugin_context">[] = [],
): Promise<{ userSeq: number; interjectionSeq: number | null }> {
  const [msg] = await eventLog.append(convId, [
    {
      type: "user_message",
      payload: { content: [{ type: "text", text }], authorAccountId: adminId },
    },
  ]);
  const userSeq = msg?.seq ?? 0;
  await db
    .insertInto("runs")
    .values({
      id: runId,
      conversation_id: convId,
      status: "completed",
      agent_version: 1,
      trigger_account_id: adminId,
      trigger_seq: userSeq,
      started_at: new Date(),
      finished_at: new Date(),
    })
    .execute();
  const call = (step: number, absorbedUpToSeq: number) => ({
    type: "model_call" as const,
    runId,
    payload: {
      step,
      attempt: 1,
      provider: "model-fake",
      model: "fake-1",
      fallback: false,
      request: {
        fromSeq: 1,
        toSeq: 1_000_000,
        summarySeq: null,
        systemHash: "h",
        reminderSeqs: [],
        tools: [],
        params: {},
        absorbedUpToSeq,
        maxOutputTokens: 1000,
      },
    },
  });
  const usage = (step: number) => ({
    type: "usage" as const,
    runId,
    payload: {
      step,
      provider: "model-fake",
      model: "fake-1",
      inputTokens: 10,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
  });
  await eventLog.append(convId, [
    {
      type: "run_started",
      runId,
      payload: {
        agentVersion: 1,
        model: { provider: "model-fake", model: "fake-1" },
        triggerAccountId: adminId,
      },
    },
    ...(catalog !== undefined
      ? [{ type: "skills_catalog" as const, runId, payload: catalog }]
      : []),
    ...(runContext !== undefined
      ? [{ type: "run_context" as const, runId, payload: runContext }]
      : []),
    ...pluginContexts.map((payload) => ({ type: "plugin_context" as const, runId, payload })),
    call(1, userSeq),
  ]);
  let interjectionSeq: number | null = null;
  if (interjection !== undefined) {
    const [m] = await eventLog.append(convId, [
      typeof interjection === "string"
        ? {
            type: "user_message",
            payload: { content: [{ type: "text", text: interjection }], authorAccountId: adminId },
          }
        : "finished" in interjection
          ? { type: "background_task_finished", payload: interjection.finished }
          : { type: "subagent_delivery", payload: interjection.delivery },
    ]);
    interjectionSeq = m?.seq ?? null;
  }
  await eventLog.append(convId, [
    {
      type: "assistant_message",
      runId,
      payload: {
        step: 1,
        content: recorded.map((r, i) => ({
          type: "tool_call",
          id: `rec-${runId}-${i}`,
          name: r.name,
          input: r.input,
        })),
        stopReason: "tool_use",
      },
    },
    usage(1),
    ...recorded.flatMap((r, i) => [
      {
        type: "tool_call_started" as const,
        runId,
        payload: { step: 1, callId: `rec-${runId}-${i}`, toolKey: r.name, specHash: "s" },
      },
      {
        type: "tool_result" as const,
        runId,
        payload: {
          step: 1,
          callId: `rec-${runId}-${i}`,
          toolKey: r.name,
          content: r.content,
          isError: false,
        },
      },
    ]),
    call(2, interjectionSeq ?? userSeq),
    {
      type: "assistant_message",
      runId,
      payload: {
        step: 2,
        content: [{ type: "text", text: "original end" }],
        stopReason: "end_turn",
      },
    },
    usage(2),
    {
      type: "run_finished",
      runId,
      payload: { reason: "completed", consumedUpToSeq: interjectionSeq ?? userSeq },
    },
  ]);
  return { userSeq, interjectionSeq };
}

/** A finished background task's payload (as the finisher writes it). */
const finishedTask = (taskId: string): EventPayload<"background_task_finished"> => ({
  taskId,
  description: `Task ${taskId}`,
  status: "completed",
  exitCode: 0,
  elapsedMs: 4_000,
  lastLines: "ok\n",
  outputPath: `/workspace/.capybara/tasks/${taskId}.out`,
  reported: false,
});

/** A sub-agent's finish delivered to its parent (agent map spec §5.2, as the writer logs it). */
const delivery = (subagentId: string, text: string): EventPayload<"subagent_delivery"> => ({
  subagentId,
  childRunId: `run-${subagentId}`,
  description: `Part ${subagentId}`,
  kind: "finished",
  text,
  status: "completed",
  handedBack: false,
  triggerAccountId: adminId,
});

/**
 * A wake run written to the log (background Bash §3, agent map spec §5.3): the conversation's
 * finished task (or, with `delivery`, a sub-agent delivery) after the last consumed message is the
 * run's boundary (`trigger_seq`); step 1 absorbs it and answers.
 */
async function seedWakeRun(
  convId: string,
  runId: string,
  taskId: string,
  opts: {
    /** Recorded as `run_started.triggerSeq` (recordings before fix round 1 have none). */
    recordTrigger?: boolean;
    /** Finishes logged after the boundary, before the run started. */
    after?: EventPayload<"background_task_finished">[];
    /** A sub-agent wake (`trigger: "subagent"`): the boundary is this delivery. */
    delivery?: EventPayload<"subagent_delivery">;
  } = {},
): Promise<number> {
  const [f] = await eventLog.append(convId, [
    opts.delivery !== undefined
      ? { type: "subagent_delivery", payload: opts.delivery }
      : { type: "background_task_finished", payload: finishedTask(taskId) },
  ]);
  const seq = f?.seq ?? 0;
  const later = await eventLog.append(
    convId,
    (opts.after ?? []).map((payload) => ({ type: "background_task_finished" as const, payload })),
  );
  const absorbed = later.at(-1)?.seq ?? seq;
  await db
    .insertInto("runs")
    .values({
      id: runId,
      conversation_id: convId,
      status: "completed",
      agent_version: 1,
      trigger_account_id: adminId,
      trigger_seq: seq,
      started_at: new Date(),
      finished_at: new Date(),
    })
    .execute();
  await eventLog.append(convId, [
    {
      type: "run_started",
      runId,
      payload: {
        agentVersion: 1,
        model: { provider: "model-fake", model: "fake-1" },
        triggerAccountId: adminId,
        trigger: opts.delivery !== undefined ? "subagent" : "background_task",
        ...(opts.recordTrigger !== false && { triggerSeq: seq }),
      },
    },
    {
      type: "model_call",
      runId,
      payload: {
        step: 1,
        attempt: 1,
        provider: "model-fake",
        model: "fake-1",
        fallback: false,
        request: {
          fromSeq: 1,
          toSeq: 1_000_000,
          summarySeq: null,
          systemHash: "h",
          reminderSeqs: [],
          tools: [],
          params: {},
          absorbedUpToSeq: absorbed,
          maxOutputTokens: 1000,
        },
      },
    },
    {
      type: "assistant_message",
      runId,
      payload: { step: 1, content: [{ type: "text", text: "noted" }], stopReason: "end_turn" },
    },
    {
      type: "usage",
      runId,
      payload: {
        step: 1,
        provider: "model-fake",
        model: "fake-1",
        inputTokens: 10,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    },
    { type: "run_finished", runId, payload: { reason: "completed", consumedUpToSeq: absorbed } },
  ]);
  return seq;
}

async function trajectory(conversationId: string): Promise<TrajectoryDetail> {
  const res = await admin({
    method: "GET",
    url: `/api/v1/orgs/${orgId}/trajectories/${conversationId}`,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as TrajectoryDetail;
}

const evalEvents = (r: EvalResultView) => eventsOf(db, r.evalConversationId as string);

describe("整轮回放", { timeout: 60_000 }, () => {
  it("候选等于基线：工具序列与原运行一致、unmatched 0，工具处理函数 0 次、没有审批、没有沙箱调用", async () => {
    // 原运行是真实运行：工具确实执行了一次
    const conv = await createConv(admin, orgId, agentId);
    await postMessage(admin, orgId, conv, 'tool:plugin__tools-count__count:{"n":7}');
    await waitForTerminal(db, conv);
    expect(toolsCountState().count).toBe(1);
    const [src] = await db
      .selectFrom("runs")
      .select("id")
      .where("conversation_id", "=", conv)
      .execute();
    const setId = await createSet();
    await addCase(setId, conv, src?.id as string);

    const before = {
      ...toolsCountState(),
      approvals: await approvalsCount(),
      sandbox: (await readFakeSandboxOps(root)).length,
    };
    const run = await startRun(setId, {});
    const done = await finished(run.id);
    expect(done.status).toBe("completed");
    const [r] = await results(run.id);
    expect(r?.status, JSON.stringify(r?.error)).toBe("done");
    const cand = r?.candidate as RunReplayResult;
    const base = r?.baseline as Baseline;
    expect(cand.unmatched).toBe(0);
    expect(r?.drift).toEqual([]);
    expect(cand.outcome).toBe("completed");
    expect(cand.toolCalls).toEqual([{ name: "plugin__tools-count__count", input: { n: 7 } }]);
    expect(cand.toolCalls).toEqual(base.toolCalls);
    expect(cand.finalContent).toEqual(base.finalContent);
    expect(cand.stopReason).toBe("end_turn");
    expect(cand.steps).toBe(2);
    expect(cand.conversationId).toBe(r?.evalConversationId);

    // 没有执行任何真实工具、没有审批、没有沙箱操作
    expect(toolsCountState()).toEqual({ count: before.count, ask: before.ask });
    expect(await approvalsCount()).toBe(before.approvals);
    expect((await readFakeSandboxOps(root)).length).toBe(before.sandbox);

    // 评测对话：kind = eval、属于该评测运行；工具结果取自记录；每次请求的用量都计入预算
    const ec = await db
      .selectFrom("conversations")
      .select(["kind", "eval_run_id"])
      .where("id", "=", cand.conversationId)
      .executeTakeFirstOrThrow();
    expect(ec).toEqual({ kind: "eval", eval_run_id: run.id });
    const evs = await evalEvents(r as EvalResultView);
    const tr = evs.filter((e) => e.type === "tool_result");
    expect(tr.map((e) => (e.payload as { content: string }).content)).toEqual(["counted 7"]);
    // 种子事件保留原 seq：新的 run_started 与原运行的 run_started 同一个 seq
    const orig = await eventsOf(db, conv);
    const origStart = orig.find((e) => e.type === "run_started");
    const evalStart = evs.find((e) => e.type === "run_started");
    expect(evalStart?.seq).toBe(origStart?.seq);
    for (const e of orig.filter((x) => x.seq < (origStart?.seq ?? 0))) {
      expect(evs.find((x) => x.seq === e.seq)?.payload).toEqual(e.payload);
    }
    const used = evs
      .filter((e): e is Extract<ConversationEvent, { type: "usage" }> => e.type === "usage")
      .reduce(
        (a, e) =>
          a +
          e.payload.inputTokens +
          e.payload.outputTokens +
          e.payload.cacheReadTokens +
          e.payload.cacheWriteTokens,
        0,
      );
    expect(used).toBeGreaterThan(0);
    expect(done.tokensUsed).toBe(used);
    expect(evs.at(-1)?.type).toBe("run_finished");

    // 隐藏对话：不在「我的对话」、按 id 也取不到；轨迹用 kind=eval 能列出
    const mine = await admin({ method: "GET", url: `/api/v1/orgs/${orgId}/conversations` });
    const ids = (mine.json() as { conversations: { id: string }[] }).conversations.map((c) => c.id);
    expect(ids).toContain(conv);
    expect(ids).not.toContain(cand.conversationId);
    const one = await admin({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/conversations/${cand.conversationId}`,
    });
    expect(one.statusCode).toBe(404);
    const traj = async (q: string) =>
      (
        (await admin({ method: "GET", url: `/api/v1/orgs/${orgId}/trajectories${q}` })).json() as {
          items: TrajectoryListItem[];
        }
      ).items.map((i) => i.conversationId);
    expect(await traj("?kind=eval")).toContain(cand.conversationId);
    expect(await traj("")).not.toContain(cand.conversationId);
  });

  it("a run on a person's model switch replays on that model; a candidate model replacing it reports model_switched", async () => {
    const conv = await createConv(admin, orgId, agentId);
    const sent = await admin({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/conversations/${conv}/messages`,
      payload: { text: "echo:switched run", model: { provider: "model-fake", model: "fake-2" } },
    });
    expect(sent.statusCode, sent.body).toBe(202);
    await waitForTerminal(db, conv);
    const [src] = await db
      .selectFrom("runs")
      .select("id")
      .where("conversation_id", "=", conv)
      .execute();
    const setId = await createSet();
    await addCase(setId, conv, src?.id as string);
    const evalModels = async (r: EvalResultView) =>
      (await evalEvents(r))
        .filter((e) => e.type === "model_call")
        .map((e) => (e.payload as { model: string }).model);

    const same = await startRun(setId, {});
    expect((await finished(same.id)).status).toBe("completed");
    const [a] = await results(same.id);
    expect(a?.status, JSON.stringify(a?.error)).toBe("done");
    expect(a?.drift).toEqual([]);
    expect(await evalModels(a as EvalResultView)).toEqual(["fake-2"]);

    const other = await startRun(setId, {
      candidate: { model: { provider: "model-fake", model: "fake-1" } },
    });
    expect((await finished(other.id)).status).toBe("completed");
    const [b] = await results(other.id);
    expect(b?.status, JSON.stringify(b?.error)).toBe("done");
    expect(b?.drift).toEqual(["model_switched"]);
    expect(await evalModels(b as EvalResultView)).toEqual(["fake-1"]);
  });

  it("a candidate model disabled in the case's org after the check is refused by the replay itself (spec B §5.3)", async () => {
    const conv = await createConv(admin, orgId, agentId);
    await postMessage(admin, orgId, conv, "echo:to replay");
    await waitForTerminal(db, conv);
    const [src] = await db
      .selectFrom("runs")
      .select("id")
      .where("conversation_id", "=", conv)
      .execute();
    const setId = await createSet();
    await addCase(setId, conv, src?.id as string);
    const disable = (models: string[], enable: string[] = []) =>
      admin({
        method: "PATCH",
        url: `/api/v1/orgs/${orgId}/models/model-fake/disabled`,
        payload: { disable: models, enable },
      });
    // the run's candidate check passes (fake-2 enabled), then the org disables it
    onSeeded = async () => {
      expect((await disable(["fake-2"])).statusCode).toBe(200);
    };
    try {
      const run = await startRun(setId, {
        candidate: { model: { provider: "model-fake", model: "fake-2" } },
      });
      await finished(run.id);
      const [r] = await results(run.id);
      expect(r?.status).toBe("error");
      expect(JSON.stringify(r?.error)).toContain("fake-2 is disabled");
    } finally {
      onSeeded = undefined;
      expect((await disable([], ["fake-2"])).statusCode).toBe(200);
    }
  });

  it("Review Focus 3：参数不同或没有记录的工具都不执行；模型收到英文错误，结果标 unmatched", async () => {
    const setId = await createSet();
    // 记录的是 n=1，模型现在给 n=2；第二个用例让模型调用从未记录过的 Bash
    const c1 = await createConv(admin, orgId, agentId);
    await seedRun(c1, "rf3-args", 'tool:plugin__tools-count__ask:{"n":2}', [
      { name: "plugin__tools-count__ask", input: { n: 1 }, content: "recorded ask" },
    ]);
    const c2 = await createConv(admin, orgId, agentId);
    await seedRun(c2, "rf3-sandbox", 'tool:Bash:{"command":"touch /workspace/pwned"}', [
      { name: "plugin__tools-count__count", input: { n: 1 }, content: "recorded count" },
    ]);
    await addCase(setId, c1, "rf3-args");
    await addCase(setId, c2, "rf3-sandbox");

    const before = {
      ...toolsCountState(),
      approvals: await approvalsCount(),
      sandbox: (await readFakeSandboxOps(root)).length,
    };
    const run = await startRun(setId, {});
    expect((await finished(run.id)).status).toBe("completed");
    const rs = await results(run.id);
    expect(rs).toHaveLength(2);
    for (const r of rs) {
      expect(r.status, JSON.stringify(r.error)).toBe("done");
      const cand = r.candidate as RunReplayResult;
      expect(cand.unmatched).toBe(1);
      expect(r.drift).toContain("tool_unmatched");
      const evs = await evalEvents(r);
      const [result] = evs.filter((e) => e.type === "tool_result");
      expect(result?.payload).toMatchObject({ content: REPLAY_NO_RECORDING, isError: true });
      // 模型下一步收到的就是这条英文错误（model-fake 回显工具结果）
      const text = cand.finalContent.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      expect(text).toContain(REPLAY_NO_RECORDING);
    }
    const names = rs.map((r) => (r.candidate as RunReplayResult).toolCalls[0]?.name).sort();
    expect(names).toEqual(["Bash", "plugin__tools-count__ask"]);
    expect(toolsCountState()).toEqual({ count: before.count, ask: before.ask });
    expect(await approvalsCount()).toBe(before.approvals);
    expect((await readFakeSandboxOps(root)).length).toBe(before.sandbox);
    // 也没有写审批相关事件
    for (const r of rs) {
      expect((await evalEvents(r)).some((e) => e.type === "approval_requested")).toBe(false);
    }
    // 没匹配到的调用 specHash 为空串：轨迹照常构建，工具调用带着英文错误结果
    for (const r of rs) {
      const started = (await evalEvents(r)).find((e) => e.type === "tool_call_started");
      expect((started?.payload as { specHash: string } | undefined)?.specHash).toBe("");
      const tr = await trajectory(r.evalConversationId as string);
      const call = tr.runs.at(-1)?.steps[0]?.toolCalls[0];
      expect(call?.result).toEqual({ content: REPLAY_NO_RECORDING, isError: true });
      expect(call?.startedAt).not.toBeNull();
    }
  });

  it("Bash matching ignores description: old recordings match new calls and the reverse", async () => {
    const setId = await createSet();
    // recorded before UI refresh B (no description); the model now passes one
    const c1 = await createConv(admin, orgId, agentId);
    await seedRun(c1, "desc-old", 'tool:Bash:{"command":"echo hi","description":"Say hi"}', [
      { name: "Bash", input: { command: "echo hi" }, content: "hi\n[exit code: 0]" },
    ]);
    // recorded with a description; the model now passes a different one
    const c2 = await createConv(admin, orgId, agentId);
    await seedRun(
      c2,
      "desc-new",
      'tool:Bash:{"command":"echo yo","description":"Another wording"}',
      [
        {
          name: "Bash",
          input: { command: "echo yo", description: "Greet" },
          content: "yo\n[exit code: 0]",
        },
      ],
    );
    await addCase(setId, c1, "desc-old");
    await addCase(setId, c2, "desc-new");
    const sandboxBefore = (await readFakeSandboxOps(root)).length;
    const run = await startRun(setId, {});
    expect((await finished(run.id)).status).toBe("completed");
    const rs = await results(run.id);
    expect(rs).toHaveLength(2);
    const contents: string[] = [];
    for (const r of rs) {
      expect(r.status, JSON.stringify(r.error)).toBe("done");
      expect((r.candidate as RunReplayResult).unmatched).toBe(0);
      expect(r.drift).not.toContain("tool_unmatched");
      const [result] = (await evalEvents(r)).filter((e) => e.type === "tool_result");
      expect(result?.payload).toMatchObject({ isError: false });
      contents.push((result?.payload as { content?: string } | undefined)?.content ?? "");
    }
    expect(contents.sort()).toEqual(["hi\n[exit code: 0]", "yo\n[exit code: 0]"]);
    expect((await readFakeSandboxOps(root)).length).toBe(sandboxBefore);
  });

  it("an rc recording replays against the current names: legacyKeyMatch, no tool-call difference, nothing executed", async () => {
    const setId = await createSet();
    // recorded by the release candidate: sandbox_edit with path / oldText / newText, an extension
    // tool by its <plugin>__<tool> key; the model now calls Edit with file_path and so on
    const c1 = await createConv(admin, orgId, agentId);
    await seedRun(
      c1,
      "legacy-edit",
      'tool:Edit:{"file_path":"/workspace/a.txt","old_string":"a","new_string":"b","replace_all":true}',
      [
        {
          name: "sandbox_edit",
          input: { path: "/workspace/a.txt", oldText: "a", newText: "b", replaceAll: true },
          content: "Edited /workspace/a.txt: replaced 2 occurrences.",
        },
      ],
    );
    const c2 = await createConv(admin, orgId, agentId);
    await seedRun(c2, "legacy-ext", "tool:plugin__tools-count__count:{}", [
      { name: "tools-count__count", input: {}, content: "recorded count" },
    ]);
    const c3 = await createConv(admin, orgId, agentId);
    await seedRun(c3, "new-edit", 'tool:Edit:{"file_path":"/workspace/z.txt","old_string":"a"}', [
      { name: "Edit", input: { file_path: "/workspace/z.txt", old_string: "a" }, content: "ok" },
    ]);
    await addCase(setId, c1, "legacy-edit");
    // an rc case snapshot holds the rc definition: its enabled list named the extension tool (the
    // evidence the rc key maps by; tools default-on spec §2 keeps reading it from snapshots)
    const stored = await db
      .selectFrom("agent_versions")
      .select(["version", "definition"])
      .where("agent_id", "=", agentId)
      .orderBy("version", "desc")
      .executeTakeFirstOrThrow();
    const setDefinition = (definition: unknown) =>
      db
        .updateTable("agent_versions")
        .set({ definition: JSON.stringify(definition) })
        .where("agent_id", "=", agentId)
        .where("version", "=", stored.version)
        .execute();
    await setDefinition({
      ...(stored.definition as Record<string, unknown>),
      tools: [{ kind: "plugin", plugin: "tools-count", name: "count" }],
    });
    await addCase(setId, c2, "legacy-ext");
    await setDefinition(stored.definition);
    await addCase(setId, c3, "new-edit");
    const sandboxBefore = (await readFakeSandboxOps(root)).length;
    const run = await startRun(setId, {});
    expect((await finished(run.id)).status).toBe("completed");
    const rs = await results(run.id);
    expect(rs).toHaveLength(3);
    type Call = { name: string; input: unknown };
    const byCandidate = (name: string) => {
      const r = rs.find((x) => (x.candidate as RunReplayResult).toolCalls[0]?.name === name);
      if (!r) throw new Error(`no result whose candidate called ${name}`);
      return r;
    };
    for (const r of rs) {
      expect(r.status, JSON.stringify(r.error)).toBe("done");
      expect((r.candidate as RunReplayResult).unmatched).toBe(0);
      expect(r.drift).not.toContain("tool_unmatched");
      const diff = r.diff as { toolCallsMatch: boolean; toolCalls: { kind: string }[] };
      expect(diff.toolCallsMatch).toBe(true);
      expect(diff.toolCalls.map((t) => t.kind)).toEqual(["same"]);
      const [result] = (await evalEvents(r)).filter((e) => e.type === "tool_result");
      expect(result?.payload).toMatchObject({ isError: false });
    }
    const baselineCalls = (r: EvalResultView) => (r.baseline as { toolCalls: Call[] }).toolCalls;
    // sandbox_edit {path, oldText, ...} read as Edit {file_path, old_string, ...}
    const edits = rs.filter((r) => (r.candidate as RunReplayResult).toolCalls[0]?.name === "Edit");
    expect(edits).toHaveLength(2);
    const legacyEdit = edits.find((r) =>
      JSON.stringify(baselineCalls(r)[0]?.input).includes('"replace_all":true'),
    );
    expect(legacyEdit && (legacyEdit.candidate as RunReplayResult).legacyKeyMatch).toBe(true);
    expect(legacyEdit && baselineCalls(legacyEdit)).toEqual([
      {
        name: "Edit",
        input: {
          file_path: "/workspace/a.txt",
          old_string: "a",
          new_string: "b",
          replace_all: true,
        },
      },
    ]);
    // the extension tool recorded as tools-count__count
    const ext = byCandidate("plugin__tools-count__count");
    expect((ext.candidate as RunReplayResult).legacyKeyMatch).toBe(true);
    expect(baselineCalls(ext)[0]?.name).toBe("plugin__tools-count__count");
    // a recording already in the current names is not a legacy match
    const current = edits.find((r) => r !== legacyEdit);
    expect(current).toBeDefined();
    expect((current?.candidate as RunReplayResult | undefined)?.legacyKeyMatch).toBeUndefined();
    expect((await readFakeSandboxOps(root)).length).toBe(sandboxBefore);
  });

  it("the run's skills snapshot is copied with pinned and toolMap unchanged (phase B)", async () => {
    const setId = await createSet();
    const conv = await createConv(admin, orgId, agentId);
    const catalog: EventPayload<"skills_catalog"> = {
      skills: [
        {
          id: "s1",
          name: "brainstorming",
          description: "Use before building.",
          version: 2,
          source: "skills/x/",
          plugin: "superpowers",
        },
      ],
      pinned: [
        { id: "s1", version: 2, name: "brainstorming", source: "skills/x/", body: "Pinned body." },
      ],
      toolMap: "Some skills name Claude Code tools.",
    };
    await seedRun(
      conv,
      "pinned-copy",
      'tool:plugin__tools-count__count:{"n":1}',
      [{ name: "plugin__tools-count__count", input: { n: 1 }, content: "recorded count" }],
      undefined,
      catalog,
    );
    await addCase(setId, conv, "pinned-copy");
    const run = await startRun(setId, {});
    expect((await finished(run.id)).status).toBe("completed");
    const [r] = await results(run.id);
    expect(r?.status, JSON.stringify(r?.error)).toBe("done");
    const copied = (await evalEvents(r as EvalResultView)).filter(
      (e) => e.type === "skills_catalog",
    );
    expect(copied.map((e) => e.payload)).toEqual([catalog]);
  });

  it("the run's run_context is copied unchanged; the replay records no new one (run context §8)", async () => {
    const setId = await createSet();
    const conv = await createConv(admin, orgId, agentId);
    const runContext: EventPayload<"run_context"> = {
      agent: { name: "Recorded name" },
      org: { name: "Recorded org" },
      date: "2020-01-02",
      timeZone: "Asia/Shanghai",
      locale: "zh",
    };
    await seedRun(
      conv,
      "ctx-copy",
      'tool:plugin__tools-count__count:{"n":1}',
      [{ name: "plugin__tools-count__count", input: { n: 1 }, content: "recorded count" }],
      undefined,
      undefined,
      runContext,
    );
    await addCase(setId, conv, "ctx-copy");
    const run = await startRun(setId, {});
    expect((await finished(run.id)).status).toBe("completed");
    const [r] = await results(run.id);
    expect(r?.status, JSON.stringify(r?.error)).toBe("done");
    const copied = (await evalEvents(r as EvalResultView)).filter((e) => e.type === "run_context");
    expect(copied.map((e) => e.payload)).toEqual([runContext]);
  });

  it("the run's plugin_context events are copied unchanged, earlier ones stay seeds (memory spec §6.1)", async () => {
    const setId = await createSet();
    const conv = await createConv(admin, orgId, agentId);
    const ctx = (plugin: string, text: string): EventPayload<"plugin_context"> => ({
      plugin,
      text,
      hash: createHash("sha256").update(text).digest("hex"),
    });
    const earlier = ctx("notes", "- an earlier note");
    await eventLog.append(conv, [{ type: "plugin_context", payload: earlier }]);
    const recorded = [ctx("memory", "- prefers tea"), ctx("notes", "")];
    await seedRun(
      conv,
      "plugin-ctx-copy",
      'tool:plugin__tools-count__count:{"n":1}',
      [{ name: "plugin__tools-count__count", input: { n: 1 }, content: "recorded count" }],
      undefined,
      undefined,
      undefined,
      recorded,
    );
    await addCase(setId, conv, "plugin-ctx-copy");
    const run = await startRun(setId, {});
    expect((await finished(run.id)).status).toBe("completed");
    const [r] = await results(run.id);
    expect(r?.status, JSON.stringify(r?.error)).toBe("done");
    const copied = (await evalEvents(r as EvalResultView)).filter(
      (e) => e.type === "plugin_context",
    );
    expect(copied.map((e) => e.payload)).toEqual([earlier, ...recorded]);
    // the earlier one is a seed (no run); the run's are the replay run's own
    expect(copied[0]?.runId).toBeNull();
    expect(new Set(copied.slice(1).map((e) => e.runId)).size).toBe(1);
    expect(copied[1]?.runId).not.toBeNull();
  });

  /** A fork invocation's run (phase D) written by hand: dispatch, report (optional), one reply. */
  async function seedForkRun(convId: string, runId: string, report: boolean): Promise<number> {
    const [msg] = await eventLog.append(convId, [
      {
        type: "user_message",
        payload: {
          content: [{ type: "text", text: 'The user ran the skill "review" in a sub-agent.' }],
          authorAccountId: adminId,
          skill: {
            id: "s1",
            version: 1,
            source: "skills/x/",
            name: "review",
            arguments: "",
            mode: "fork",
            agentType: "general-purpose",
          },
        },
      },
    ]);
    const seq = msg?.seq ?? 0;
    await db
      .insertInto("runs")
      .values({
        id: runId,
        conversation_id: convId,
        status: report ? "completed" : "aborted",
        agent_version: 1,
        trigger_account_id: adminId,
        trigger_seq: seq,
        started_at: new Date(),
        finished_at: new Date(),
      })
      .execute();
    await eventLog.append(convId, [
      {
        type: "run_started",
        runId,
        payload: {
          agentVersion: 1,
          model: { provider: "model-fake", model: "fake-1" },
          triggerAccountId: adminId,
        },
      },
      {
        type: "subagent_dispatched",
        runId,
        payload: {
          step: 0,
          callId: `skill-${seq}`,
          subagentId: "child",
          childRunId: "child-run",
          agentType: "general-purpose",
          description: "review",
          resumed: false,
          model: { provider: "model-fake", model: "fake-1" },
          invokedSeq: seq,
        },
      },
      ...(report
        ? [
            {
              type: "skill_fork_result" as const,
              runId,
              payload: {
                invokedSeq: seq,
                subagentId: "child",
                childRunId: "child-run",
                text: 'Report from the sub-agent that ran the skill "review":\n\nrecorded report',
              },
            },
            {
              type: "model_call" as const,
              runId,
              payload: {
                step: 1,
                attempt: 1,
                provider: "model-fake",
                model: "fake-1",
                fallback: false,
                request: {
                  fromSeq: 1,
                  toSeq: 1_000_000,
                  summarySeq: null,
                  systemHash: "h",
                  reminderSeqs: [],
                  tools: [],
                  params: {},
                  absorbedUpToSeq: seq,
                  maxOutputTokens: 1000,
                },
              },
            },
            {
              type: "assistant_message" as const,
              runId,
              payload: {
                step: 1,
                content: [{ type: "text" as const, text: "original answer" }],
                stopReason: "end_turn" as const,
              },
            },
            {
              type: "run_finished" as const,
              runId,
              payload: { reason: "completed" as const, consumedUpToSeq: seq },
            },
          ]
        : [
            {
              type: "skill_fork_result" as const,
              runId: "other",
              payload: { invokedSeq: seq + 1000, text: "unrelated" },
            },
            {
              type: "run_aborted" as const,
              runId,
              payload: { byAccountId: adminId, reason: "user" as const },
            },
          ]),
    ]);
    return seq;
  }

  const subagentConversations = async () =>
    Number(
      (
        await db
          .selectFrom("conversations")
          .select((eb) => eb.fn.countAll().as("n"))
          .where("kind", "=", "subagent")
          .executeTakeFirstOrThrow()
      ).n,
    );

  it("a fork invocation's run replays its recorded report and never dispatches a sub-agent (phase D)", async () => {
    const setId = await createSet();
    const conv = await createConv(admin, orgId, agentId);
    const seq = await seedForkRun(conv, "fork-replay", true);
    await addCase(setId, conv, "fork-replay");
    const before = await subagentConversations();
    const run = await startRun(setId, {});
    expect((await finished(run.id)).status).toBe("completed");
    const [r] = await results(run.id);
    expect(r?.status, JSON.stringify(r?.error)).toBe("done");
    const evs = await evalEvents(r as EvalResultView);
    const ofRun = evs.filter((e) => e.seq > seq);
    expect(ofRun.filter((e) => e.type === "subagent_dispatched")).toEqual([]);
    const report = ofRun.filter((e) => e.type === "skill_fork_result");
    expect(report.map((e) => e.payload)).toEqual([
      {
        invokedSeq: seq,
        subagentId: "child",
        childRunId: "child-run",
        text: 'Report from the sub-agent that ran the skill "review":\n\nrecorded report',
      },
    ]);
    const call = ofRun.find((e) => e.type === "model_call");
    expect((call?.seq ?? 0) > (report[0]?.seq ?? Number.POSITIVE_INFINITY)).toBe(true);
    expect(await subagentConversations()).toBe(before);
  });

  it("a fork run recorded without its report replays to its end with no model call (phase D)", async () => {
    const setId = await createSet();
    const conv = await createConv(admin, orgId, agentId);
    const seq = await seedForkRun(conv, "fork-stopped", false);
    await addCase(setId, conv, "fork-stopped");
    const run = await startRun(setId, {});
    expect((await finished(run.id)).status).toBe("completed");
    const [r] = await results(run.id);
    expect(r?.status, JSON.stringify(r?.error)).toBe("done");
    const evs = (await evalEvents(r as EvalResultView)).filter((e) => e.seq > seq);
    expect(evs.filter((e) => e.type === "model_call")).toEqual([]);
    expect(evs.filter((e) => e.type === "skill_fork_result")).toEqual([]);
    expect(evs.filter((e) => e.type === "subagent_dispatched")).toEqual([]);
    expect(evs.some((e) => e.type === "run_finished")).toBe(true);
  });

  it("运行中途的插话在原吸收步骤喂入：出现在第 1 步工具结果之后、第 2 步请求之前", async () => {
    const setId = await createSet();
    const conv = await createConv(admin, orgId, agentId);
    await seedRun(
      conv,
      "interject",
      'tool:plugin__tools-count__count:{"n":3}',
      [{ name: "plugin__tools-count__count", input: { n: 3 }, content: "counted 3" }],
      "echo:interjected",
    );
    await addCase(setId, conv, "interject");
    const run = await startRun(setId, {});
    expect((await finished(run.id)).status).toBe("completed");
    const [r] = await results(run.id);
    expect(r?.status, JSON.stringify(r?.error)).toBe("done");
    const cand = r?.candidate as RunReplayResult;
    expect(cand.unmatched).toBe(0);
    const evs = await evalEvents(r as EvalResultView);
    const userMsgs = evs.filter((e) => e.type === "user_message");
    const inter = userMsgs.find((e) =>
      JSON.stringify(e.payload).includes("echo:interjected"),
    ) as ConversationEvent;
    expect(inter).toBeDefined();
    const calls = evs.filter(
      (e): e is Extract<ConversationEvent, { type: "model_call" }> => e.type === "model_call",
    );
    const step1 = calls.find((c) => c.payload.step === 1);
    const step2 = calls.find((c) => c.payload.step === 2);
    const result1 = evs.find((e) => e.type === "tool_result");
    expect(inter.seq).toBeGreaterThan(result1?.seq ?? Number.POSITIVE_INFINITY);
    expect(inter.seq).toBeLessThan(step2?.seq ?? 0);
    // 第 1 步没有吸收插话，第 2 步吸收了
    expect(step1?.payload.request.absorbedUpToSeq).toBeLessThan(inter.seq);
    expect(step2?.payload.request.absorbedUpToSeq).toBe(inter.seq);
    const text = cand.finalContent.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    expect(text).toBe("interjected");
  });

  it("a run whose input request was skipped by a message replays the recorded skipped result and feeds the message at its step; the tool never runs", async () => {
    const setId = await createSet();
    const conv = await createConv(admin, orgId, agentId);
    await seedRun(
      conv,
      "skipped",
      "tool:plugin__tools-count__ask:{}",
      [{ name: "plugin__tools-count__ask", input: {}, content: INPUT_SKIPPED_TEXT }],
      "echo:moved on",
    );
    await addCase(setId, conv, "skipped");
    const run = await startRun(setId, {});
    expect((await finished(run.id)).status).toBe("completed");
    const [r] = await results(run.id);
    expect(r?.status, JSON.stringify(r?.error)).toBe("done");
    const cand = r?.candidate as RunReplayResult;
    expect(cand.unmatched).toBe(0);
    const evs = await evalEvents(r as EvalResultView);
    expect(evs.flatMap((e) => (e.type === "tool_result" ? [e.payload.content] : []))).toEqual([
      INPUT_SKIPPED_TEXT,
    ]);
    // replays never create questions
    expect(evs.some((e) => e.type === "question_asked")).toBe(false);
    const text = cand.finalContent.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    expect(text).toBe("moved on");
  });

  it("a finished background task absorbed mid-run is fed at the step that absorbed it; no task starts (background Bash §4.4)", async () => {
    const setId = await createSet();
    const conv = await createConv(admin, orgId, agentId);
    const taskId = "bt_replay";
    await seedRun(
      conv,
      "bg-mid",
      'tool:plugin__tools-count__count:{"n":4}',
      [{ name: "plugin__tools-count__count", input: { n: 4 }, content: "counted 4" }],
      { finished: finishedTask(taskId) },
    );
    await addCase(setId, conv, "bg-mid");
    const before = toolsCountState().count;
    const run = await startRun(setId, {});
    expect((await finished(run.id)).status).toBe("completed");
    const [r] = await results(run.id);
    expect(r?.status, JSON.stringify(r?.error)).toBe("done");
    expect((r as EvalResultView).candidate as RunReplayResult).toMatchObject({ unmatched: 0 });
    const evs = await evalEvents(r as EvalResultView);
    const fed = evs.filter((e) => e.type === "background_task_finished");
    expect(fed.map((e) => e.payload)).toEqual([finishedTask(taskId)]);
    const calls = evs.filter(
      (e): e is Extract<ConversationEvent, { type: "model_call" }> => e.type === "model_call",
    );
    const step1 = calls.find((c) => c.payload.step === 1);
    const step2 = calls.find((c) => c.payload.step === 2);
    const result1 = evs.find((e) => e.type === "tool_result");
    const f = fed[0] as ConversationEvent;
    // fed after step 1's tool results, absorbed by step 2 as in the original
    expect(f.seq).toBeGreaterThan(result1?.seq ?? Number.POSITIVE_INFINITY);
    expect(f.seq).toBeLessThan(step2?.seq ?? 0);
    expect(step1?.payload.request.absorbedUpToSeq).toBeLessThan(f.seq);
    expect(step2?.payload.request.absorbedUpToSeq).toBe(f.seq);
    // a replay starts, polls and stops no task, and executes no tool
    const tasks = await db
      .selectFrom("background_tasks")
      .select("id")
      .where("conversation_id", "=", r?.evalConversationId as string)
      .execute();
    expect(tasks).toEqual([]);
    expect(toolsCountState().count).toBe(before);
  });

  it("a wake run is seeded from its finished background task, not the last message (background Bash §3)", async () => {
    const setId = await createSet();
    const conv = await createConv(admin, orgId, agentId);
    await seedRun(conv, "bg-before", "echo:first", []);
    const wakeSeq = await seedWakeRun(conv, "bg-wake", "bt_wakeup");
    await addCase(setId, conv, "bg-wake");
    const run = await startRun(setId, {});
    expect((await finished(run.id)).status).toBe("completed");
    const [r] = await results(run.id);
    expect(r?.status, JSON.stringify(r?.error)).toBe("done");
    const evalConv = r?.evalConversationId as string;
    const row = await db
      .selectFrom("runs")
      .select("trigger_seq")
      .where("conversation_id", "=", evalConv)
      .executeTakeFirstOrThrow();
    expect(Number(row.trigger_seq)).toBe(wakeSeq);
    const evs = await eventsOf(db, evalConv);
    const step1 = evs.find(
      (e): e is Extract<ConversationEvent, { type: "model_call" }> =>
        e.type === "model_call" && e.payload.step === 1 && e.seq > wakeSeq,
    );
    // the seeded finish (its original seq) is what the replayed run's first step absorbed
    expect(step1?.payload.request.absorbedUpToSeq).toBe(wakeSeq);
    expect(
      evs.find((e) => e.seq === wakeSeq && e.type === "background_task_finished"),
    ).toBeDefined();
    const fin = evs.find((e) => e.type === "run_finished" && e.seq > (step1?.seq ?? 0));
    expect(
      ((fin as ConversationEvent).payload as EventPayload<"run_finished">).consumedUpToSeq,
    ).toBe(wakeSeq);
  });

  it("a wake run's recorded boundary wins; without one the newest finish that could wake, never a person's stop", async () => {
    const evalTrigger = async (runId: string, opts: Parameters<typeof seedWakeRun>[3]) => {
      const setId = await createSet();
      const conv = await createConv(admin, orgId, agentId);
      await seedRun(conv, `${runId}-before`, "echo:first", []);
      const seq = await seedWakeRun(conv, runId, `bt_${runId}`, opts);
      await addCase(setId, conv, runId);
      const run = await startRun(setId, {});
      expect((await finished(run.id)).status).toBe("completed");
      const [r] = await results(run.id);
      expect(r?.status, JSON.stringify(r?.error)).toBe("done");
      const row = await db
        .selectFrom("runs")
        .select("trigger_seq")
        .where("conversation_id", "=", r?.evalConversationId as string)
        .executeTakeFirstOrThrow();
      return { seq, trigger: Number(row.trigger_seq) };
    };
    // recorded: the boundary, though a newer finish came before the run started
    const a = await evalTrigger("bg-rec", { after: [finishedTask("bt_newer")] });
    expect(a.trigger).toBe(a.seq);
    // not recorded: the newest finish that could wake, skipping a person's stop after it
    const b = await evalTrigger("bg-heur", {
      recordTrigger: false,
      after: [{ ...finishedTask("bt_stopped"), status: "stopped", stoppedBy: "person" }],
    });
    expect(b.trigger).toBe(b.seq);
  });

  it('a wake run with trigger "subagent" is seeded from triggerSeq (agent map spec §8)', async () => {
    const setId = await createSet();
    const conv = await createConv(admin, orgId, agentId);
    await seedRun(conv, "sa-before", "echo:first", []);
    const wakeSeq = await seedWakeRun(conv, "sa-wake", "unused", {
      delivery: delivery("child-wake", "all parts done"),
    });
    await addCase(setId, conv, "sa-wake");
    const run = await startRun(setId, {});
    expect((await finished(run.id)).status).toBe("completed");
    const [r] = await results(run.id);
    expect(r?.status, JSON.stringify(r?.error)).toBe("done");
    const evalConv = r?.evalConversationId as string;
    const row = await db
      .selectFrom("runs")
      .select("trigger_seq")
      .where("conversation_id", "=", evalConv)
      .executeTakeFirstOrThrow();
    // the recorded boundary (the delivery), not the consumed message before it
    expect(Number(row.trigger_seq)).toBe(wakeSeq);
    const evs = await eventsOf(db, evalConv);
    const step1 = evs.find(
      (e): e is Extract<ConversationEvent, { type: "model_call" }> =>
        e.type === "model_call" && e.payload.step === 1 && e.seq > wakeSeq,
    );
    expect(step1?.payload.request.absorbedUpToSeq).toBe(wakeSeq);
    expect(evs.find((e) => e.seq === wakeSeq && e.type === "subagent_delivery")).toBeDefined();
    const fin = evs.find((e) => e.type === "run_finished" && e.seq > (step1?.seq ?? 0));
    expect(
      ((fin as ConversationEvent).payload as EventPayload<"run_finished">).consumedUpToSeq,
    ).toBe(wakeSeq);
  });

  it("a delivery absorbed mid-run is fed at its step (agent map spec §5.2)", async () => {
    const setId = await createSet();
    const conv = await createConv(admin, orgId, agentId);
    const d = delivery("child-mid", "part one done");
    await seedRun(
      conv,
      "sa-mid",
      'tool:plugin__tools-count__count:{"n":5}',
      [{ name: "plugin__tools-count__count", input: { n: 5 }, content: "counted 5" }],
      { delivery: d },
    );
    await addCase(setId, conv, "sa-mid");
    const run = await startRun(setId, {});
    expect((await finished(run.id)).status).toBe("completed");
    const [r] = await results(run.id);
    expect(r?.status, JSON.stringify(r?.error)).toBe("done");
    expect((r as EvalResultView).candidate as RunReplayResult).toMatchObject({ unmatched: 0 });
    const evs = await evalEvents(r as EvalResultView);
    const fed = evs.filter((e) => e.type === "subagent_delivery");
    expect(fed.map((e) => e.payload)).toEqual([d]);
    const calls = evs.filter(
      (e): e is Extract<ConversationEvent, { type: "model_call" }> => e.type === "model_call",
    );
    const step1 = calls.find((c) => c.payload.step === 1);
    const step2 = calls.find((c) => c.payload.step === 2);
    const result1 = evs.find((e) => e.type === "tool_result");
    const f = fed[0] as ConversationEvent;
    // fed after step 1's tool results, absorbed by step 2 as in the original
    expect(f.seq).toBeGreaterThan(result1?.seq ?? Number.POSITIVE_INFINITY);
    expect(f.seq).toBeLessThan(step2?.seq ?? 0);
    expect(step1?.payload.request.absorbedUpToSeq).toBeLessThan(f.seq);
    expect(step2?.payload.request.absorbedUpToSeq).toBe(f.seq);
  });

  it("replay never dispatches, sends or hands back (recorded results only)", async () => {
    const setId = await createSet();
    const conv = await createConv(admin, orgId, agentId);
    const recorded = [
      {
        name: "Agent",
        input: { description: "Part A", prompt: "do part A" },
        content: "Started sub-agent child-a in the background.",
      },
      {
        name: "SendMessage",
        input: { to: "child-a", message: "also check B" },
        content: "Message delivered to child-a (running).",
      },
      {
        name: "SubagentHandback",
        input: { message: "interim report" },
        content: "Report delivered to your caller.",
      },
    ];
    await seedRun(
      conv,
      "sa-tools",
      `tools:${JSON.stringify(recorded.map(({ name, input }) => ({ name, input })))}`,
      recorded,
    );
    await addCase(setId, conv, "sa-tools");
    const outside = async () => {
      const [convs, dispatches, events] = await Promise.all([
        db
          .selectFrom("conversations")
          .select((eb) => eb.fn.countAll().as("n"))
          .where("kind", "=", "subagent")
          .executeTakeFirstOrThrow(),
        db
          .selectFrom("subagent_dispatches")
          .select((eb) => eb.fn.countAll().as("n"))
          .executeTakeFirstOrThrow(),
        db
          .selectFrom("conversation_events as e")
          .innerJoin("conversations as c", "c.id", "e.conversation_id")
          .select((eb) => eb.fn.countAll().as("n"))
          .where("c.kind", "!=", "eval")
          .executeTakeFirstOrThrow(),
      ]);
      return [Number(convs.n), Number(dispatches.n), Number(events.n)];
    };
    const before = await outside();
    const run = await startRun(setId, {});
    expect((await finished(run.id)).status).toBe("completed");
    const [r] = await results(run.id);
    expect(r?.status, JSON.stringify(r?.error)).toBe("done");
    const cand = (r as EvalResultView).candidate as RunReplayResult;
    expect(cand.unmatched).toBe(0);
    expect(cand.toolCalls.map((c) => c.name)).toEqual(["Agent", "SendMessage", "SubagentHandback"]);
    const evs = await evalEvents(r as EvalResultView);
    // the recorded results came back; no child, no dispatch, no delivery, no event elsewhere
    expect(
      evs.flatMap((e) =>
        e.type === "tool_result" ? [(e.payload as { content: string }).content] : [],
      ),
    ).toEqual(recorded.map((x) => x.content));
    expect(evs.filter((e) => e.type.startsWith("subagent_"))).toEqual([]);
    expect(await outside()).toEqual(before);
  });

  it("a compact run's case is never replayed: no step, no tool, no eval conversation (context compaction §4.7)", async () => {
    const setId = await createSet();
    const conv = await createConv(admin, orgId, agentId);
    // a normal run of the same conversation, the set's one replayable case
    await postMessage(admin, orgId, conv, "echo:before the compact run");
    await waitForTerminal(db, conv);
    const [normal] = await db
      .selectFrom("runs")
      .select("id")
      .where("conversation_id", "=", conv)
      .execute();
    await addCase(setId, conv, normal?.id as string);

    // the compact run as the kernel writes it: no user message, no model step, chunked usages
    const startedAt = new Date();
    await db
      .insertInto("runs")
      .values({
        id: "compact-run-1",
        conversation_id: conv,
        status: "completed",
        compact: true,
        agent_version: 1,
        trigger_account_id: adminId,
        trigger_seq: "1",
        started_at: startedAt,
        finished_at: startedAt,
      })
      .execute();
    const chunkUsage = (chunk: number) => ({
      type: "usage" as const,
      runId: "compact-run-1",
      payload: {
        step: 0,
        provider: "model-fake",
        model: "fake-1",
        inputTokens: 1000,
        outputTokens: 100,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        purpose: "compaction" as const,
        chunk,
        chunks: 2,
      },
    });
    await eventLog.append(conv, [
      {
        type: "run_started",
        runId: "compact-run-1",
        payload: {
          agentVersion: 1,
          model: { provider: "model-fake", model: "fake-1" },
          triggerAccountId: adminId,
          trigger: "compact",
        },
      },
      {
        type: "compaction_summary",
        runId: "compact-run-1",
        payload: { coversUpToSeq: 1, text: "summary", savedTokens: 900 },
      },
      chunkUsage(1),
      chunkUsage(2),
      {
        type: "run_finished",
        runId: "compact-run-1",
        payload: { reason: "completed", consumedUpToSeq: 1 },
      },
    ]);
    await addCase(setId, conv, "compact-run-1");

    const run = await startRun(setId, {});
    // the compact case has no plan, so it is not scheduled: one case, one result
    expect(run.casesTotal).toBe(1);
    const done = await finished(run.id);
    expect(done.status).toBe("completed");
    const rows = await results(run.id);
    expect(rows).toHaveLength(1);
    const compactCase = await db
      .selectFrom("eval_cases")
      .select("id")
      .where("source_run_id", "=", "compact-run-1")
      .executeTakeFirstOrThrow();
    const compactResults = await db
      .selectFrom("eval_results")
      .select("id")
      .where("case_id", "=", compactCase.id)
      .execute();
    expect(compactResults).toEqual([]);
    // nothing was dispatched for it: no eval conversation, no step
    const evalConvs = await db
      .selectFrom("conversations")
      .select(["id", "eval_run_id"])
      .where("eval_run_id", "=", run.id)
      .execute();
    expect(evalConvs).toHaveLength(1);
    expect(rows[0]?.caseId).not.toBe(compactCase.id);
  });

  it("达到 token 上限：loop 在下一次请求前停下，结果 skipped，运行 capped", async () => {
    const setId = await createSet();
    const conv = await createConv(admin, orgId, agentId);
    await seedRun(conv, "capped", 'tool:plugin__tools-count__count:{"n":4}', [
      { name: "plugin__tools-count__count", input: { n: 4 }, content: "counted 4" },
    ]);
    await addCase(setId, conv, "capped");
    const run = await startRun(setId, { tokenCap: 1 });
    const done = await finished(run.id);
    expect(done.status).toBe("capped");
    // 运行一越限就是 capped；回放要到下一次请求前才发现并停下，等结果落定
    const [r] = await waitFor(
      async () => {
        const rs = await results(run.id);
        return rs.every((x) => !["pending", "running"].includes(x.status)) ? rs : null;
      },
      20_000,
      "result settled",
      100,
    );
    expect(r?.status).toBe("skipped");
    const ec = await db
      .selectFrom("conversations")
      .select("id")
      .where("eval_run_id", "=", run.id)
      .execute();
    expect(ec).toHaveLength(1);
    await waitForTerminal(db, ec[0]?.id as string);
    const evs = await eventsOf(db, ec[0]?.id as string);
    // 第一次请求之后就越限：只发了一次请求
    expect(evs.filter((e) => e.type === "usage")).toHaveLength(1);
    expect(evs.at(-1)?.type).toBe("run_aborted");
    // 轨迹说明为什么停下
    expect(evs.at(-1)?.payload).toEqual({
      byAccountId: null,
      reason: "eval_stopped",
      detail: "capped",
    });
    expect((await trajectory(ec[0]?.id as string)).runs.at(-1)?.end).toEqual({
      kind: "aborted",
      detail: "capped",
    });
    expect(done.tokensUsed).toBeGreaterThan(1);
  });

  it("上限恰好等于一次完整回放的用量：最后一次请求越限，回放已做完，结果 done、运行 capped", async () => {
    const setId = await createSet();
    const conv = await createConv(admin, orgId, agentId);
    await seedRun(conv, "exact", 'tool:plugin__tools-count__count:{"n":6}', [
      { name: "plugin__tools-count__count", input: { n: 6 }, content: "counted 6" },
    ]);
    await addCase(setId, conv, "exact");
    // 先量出一次完整回放的用量（确定性：model-fake 的用量只取决于请求内容）
    const probe = await startRun(setId, {});
    const full = await finished(probe.id);
    expect(full.status).toBe("completed");
    const run = await startRun(setId, { tokenCap: full.tokensUsed });
    const done = await finished(run.id);
    expect(done.status).toBe("capped");
    expect(done.tokensUsed).toBe(full.tokensUsed);
    const [r] = await waitFor(
      async () => {
        const rs = await results(run.id);
        return rs.every((x) => !["pending", "running"].includes(x.status)) ? rs : null;
      },
      20_000,
      "result settled",
      100,
    );
    expect(r?.status, JSON.stringify(r?.error)).toBe("done");
    expect((r?.candidate as RunReplayResult | undefined)?.outcome).toBe("completed");
    expect((r?.candidate as RunReplayResult | undefined)?.steps).toBe(2);
  });

  it("删除评测集：评测对话一并删除", async () => {
    const setId = await createSet();
    const conv = await createConv(admin, orgId, agentId);
    await seedRun(conv, "purge", 'tool:plugin__tools-count__count:{"n":8}', [
      { name: "plugin__tools-count__count", input: { n: 8 }, content: "counted 8" },
    ]);
    await addCase(setId, conv, "purge");
    const run = await startRun(setId, {});
    expect((await finished(run.id)).status).toBe("completed");
    const convs = () =>
      db.selectFrom("conversations").select("id").where("eval_run_id", "=", run.id).execute();
    expect(await convs()).toHaveLength(1);
    const del = await admin({ method: "DELETE", url: `${setsUrl()}/${setId}` });
    expect(del.statusCode, del.body).toBe(204);
    expect(await convs()).toHaveLength(0);
  });

  it("崩溃后运行已停下：重试跳过该用例时删掉崩溃留下的、还在执行的评测对话", async () => {
    const setId = await createSet();
    const conv = await createConv(admin, orgId, agentId);
    await seedRun(conv, "leftover", 'tool:plugin__tools-count__count:{"n":6}', [
      { name: "plugin__tools-count__count", input: { n: 6 }, content: "counted 6" },
    ]);
    await addCase(setId, conv, "leftover");
    cancelThenCrash = true;
    const run = await startRun(setId, {});
    await waitFor(
      async () => {
        const rs = await results(run.id);
        return rs[0]?.status === "skipped" ? rs : null;
      },
      30_000,
      "result skipped",
      100,
    );
    expect((await getRun(run.id)).status).toBe("cancelled");
    const convs = await db
      .selectFrom("conversations")
      .select("id")
      .where("eval_run_id", "=", run.id)
      .execute();
    expect(convs).toEqual([]);
    expect((await results(run.id))[0]?.evalConversationId).toBeNull();
  });

  it("崩溃后从头重跑：旧的评测对话被删掉，只剩一份结果", async () => {
    const setId = await createSet();
    const conv = await createConv(admin, orgId, agentId);
    await seedRun(conv, "crash", 'tool:plugin__tools-count__count:{"n":5}', [
      { name: "plugin__tools-count__count", input: { n: 5 }, content: "counted 5" },
    ]);
    await addCase(setId, conv, "crash");
    crashOnce = true;
    const run = await startRun(setId, {});
    expect((await finished(run.id, 45_000)).status).toBe("completed");
    expect(crashes).toBe(1);
    const rs = await results(run.id);
    expect(rs).toHaveLength(1);
    expect(rs[0]?.status).toBe("done");
    const convs = await db
      .selectFrom("conversations")
      .select("id")
      .where("eval_run_id", "=", run.id)
      .execute();
    expect(convs.map((c) => c.id)).toEqual([rs[0]?.evalConversationId]);
    expect((rs[0]?.candidate as RunReplayResult | undefined)?.unmatched).toBe(0);
  });

  it("请求前检查出 DB 错误：按崩溃交给 BullMQ 重试，从头重跑后 done", async () => {
    const setId = await createSet();
    const conv = await createConv(admin, orgId, agentId);
    await seedRun(conv, "dberr", 'tool:plugin__tools-count__count:{"n":4}', [
      { name: "plugin__tools-count__count", input: { n: 4 }, content: "counted 4" },
    ]);
    await addCase(setId, conv, "dberr");
    checkFailed = 0;
    checkFailures = 1;
    const run = await startRun(setId, {});
    expect((await finished(run.id, 45_000)).status).toBe("completed");
    expect(checkFailed).toBe(1);
    const rs = await results(run.id);
    expect(rs).toHaveLength(1);
    expect(rs[0]?.status, JSON.stringify(rs[0]?.error)).toBe("done");
    const convs = await db
      .selectFrom("conversations")
      .select("id")
      .where("eval_run_id", "=", run.id)
      .execute();
    expect(convs.map((c) => c.id)).toEqual([rs[0]?.evalConversationId]);
  });

  it("计费一直写不进去：尝试用尽后结果记 error，评测对话被删掉", async () => {
    const setId = await createSet();
    const conv = await createConv(admin, orgId, agentId);
    await seedRun(conv, "chargeerr", 'tool:plugin__tools-count__count:{"n":3}', [
      { name: "plugin__tools-count__count", input: { n: 3 }, content: "counted 3" },
    ]);
    await addCase(setId, conv, "chargeerr");
    chargeFailed = 0;
    chargeFailures = -1;
    try {
      const run = await startRun(setId, {});
      const rs = await waitFor(
        async () => {
          const x = await results(run.id);
          return x.every((r) => !["pending", "running"].includes(r.status)) ? x : null;
        },
        45_000,
        "result settled",
        100,
      );
      expect(rs).toHaveLength(1);
      expect(rs[0]?.status).toBe("error");
      expect((rs[0]?.error as { code?: string } | null)?.code).toBe("eval.internal");
      expect(rs[0]?.evalConversationId).toBeNull();
      // 3 次尝试（attempts: 3），每次都在第一次计费处崩溃
      expect(chargeFailed).toBeGreaterThanOrEqual(3);
      expect((await finished(run.id)).status).toBe("completed");
      const convs = await db
        .selectFrom("conversations")
        .select("id")
        .where("eval_run_id", "=", run.id)
        .execute();
      expect(convs).toHaveLength(0);
    } finally {
      chargeFailures = 0;
    }
  });

  it("尝试用尽后删除评测对话也失败：结果照常记 error，运行照常结束", async () => {
    const setId = await createSet();
    const conv = await createConv(admin, orgId, agentId);
    await seedRun(conv, "delerr", 'tool:plugin__tools-count__count:{"n":2}', [
      { name: "plugin__tools-count__count", input: { n: 2 }, content: "counted 2" },
    ]);
    await addCase(setId, conv, "delerr");
    chargeFailures = -1;
    deleteFails = true;
    try {
      const run = await startRun(setId, {});
      const rs = await waitFor(
        async () => {
          const x = await results(run.id);
          return x.every((r) => !["pending", "running"].includes(r.status)) ? x : null;
        },
        45_000,
        "result settled",
        100,
      );
      expect(rs[0]?.status).toBe("error");
      expect((rs[0]?.error as { code?: string } | null)?.code).toBe("eval.internal");
      expect(rs[0]?.evalConversationId).toBeNull();
      expect((await finished(run.id)).status).toBe("completed");
      // 删不掉的评测对话留下（随评测集删除清掉）
      const convs = await db
        .selectFrom("conversations")
        .select("id")
        .where("eval_run_id", "=", run.id)
        .execute();
      expect(convs).toHaveLength(1);
    } finally {
      chargeFailures = 0;
      deleteFails = false;
    }
  });
});
