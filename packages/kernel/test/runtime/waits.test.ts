import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { ApiError } from "../../src/errors.js";
import type { Kernel } from "../../src/kernel.js";
import { RUN_QUEUE_NAME } from "../../src/runtime/run-queue.js";
import { MAINTENANCE_QUEUE_NAME, waitTimeoutJobId } from "../../src/runtime/waits.js";
import {
  APPROVAL_CANCELLED_TEXT,
  APPROVAL_DENIED_TEXT,
  approvalExpiredText,
  INPUT_CANCELLED_TEXT,
  TOO_MANY_INPUT_REQUESTS_TEXT,
} from "../../src/tools/pipeline.js";
import { memState } from "../fixtures/plugins/mem-connector/index.js";
import { truncateTables } from "../helpers/db.js";
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
  runsOf,
  session,
  sleep,
  startKernel,
  waitFor,
  waitForEvent,
  waitForTerminal,
} from "../helpers/runs.js";

/**
 * Task 9：运行等待人处理（审批 / 输入请求）时暂停，处理后从 LangGraph checkpoint 续跑。
 * 单副本端到端（model-fake 脚本工具调用 + mem-connector 的插件工具）；双副本见 waits-dual.test.ts。
 */

const MEM_CONNECTOR = fileURLToPath(
  new URL("../fixtures/plugins/mem-connector/index.ts", import.meta.url),
);

let pgc: TestContainer;
let rd: TestContainer;
let k: Kernel;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let maint: Queue;
let runQueue: Queue;

let req: Req;
let orgId: string;
let ownerId: string;
let agentId: string;

const ECHO = 'tool:mem-connector__echo:{"text":"hi"}';
const resultsOf = (evs: ConversationEvent[]) =>
  evs.flatMap((e) => (e.type === "tool_result" ? [e.payload] : []));
const ofType = <T extends ConversationEvent["type"]>(evs: ConversationEvent[], type: T) =>
  evs.filter((e): e is Extract<ConversationEvent, { type: T }> => e.type === type);

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      // 组织并发 1：验证等待中的运行不占配额
      { extensions: [MODEL_FAKE, MEM_CONNECTOR], runtime: { orgConcurrency: 1, maxRunSeconds: 3 } },
    ),
  );
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  redis = new Redis(rd.url);
  maint = new Queue(MAINTENANCE_QUEUE_NAME, { connection: new Redis(rd.url) });
  runQueue = new Queue(RUN_QUEUE_NAME, { connection: new Redis(rd.url) });
}, 120_000);

afterAll(async () => {
  await maint?.close();
  await runQueue?.close();
  await k?.stop();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

beforeEach(async () => {
  await truncateTables(raw, "capybara.accounts, capybara.orgs, capybara.audit_events");
  const owner = await accountsFor(db).createLocal({
    login: "owner",
    password: PW,
    displayName: "O",
  });
  ownerId = owner.id;
  const st = memState();
  st.echoCalls = 0;
  st.askCalls = [];
  req = await session(k, "owner");
  orgId = await createOrg(req);
  const en = await req({
    method: "PUT",
    url: `/api/v1/orgs/${orgId}/extensions/mem-connector`,
    payload: { enabled: true },
  });
  expect(en.statusCode, en.body).toBe(200);
  agentId = await createToolAgent(req, orgId);
});

async function createToolAgent(r: Req, org: string): Promise<string> {
  const ag = await r({
    method: "POST",
    url: `/api/v1/orgs/${org}/agents`,
    payload: {
      definition: {
        name: "Helper",
        instructions: "Be helpful.",
        model: { provider: "model-fake", model: "fake-1" },
        tools: [
          { kind: "plugin", plugin: "mem-connector", name: "echo" },
          { kind: "plugin", plugin: "mem-connector", name: "ask" },
        ],
        // echo 需要审批；ask 默认放行（只请求用户输入）
        toolPolicies: { "mem-connector__echo": "ask" },
      },
      visibility: "org",
    },
  });
  expect(ag.statusCode, ag.body).toBe(201);
  return (ag.json() as { agent: { id: string } }).agent.id;
}

async function runStatus(runId: string): Promise<string> {
  const r = await db
    .selectFrom("runs")
    .select("status")
    .where("id", "=", runId)
    .executeTakeFirstOrThrow();
  return r.status;
}

/** 发消息并等到运行进入 waiting，返回 runId 与等待事件。 */
async function startAndWait(
  convId: string,
  text: string,
  type: "approval_requested" | "question_asked",
): Promise<{ runId: string; event: ConversationEvent }> {
  await postMessage(req, orgId, convId, text);
  const event = await waitForEvent(db, convId, (e) => e.type === type, 10_000, type);
  const runId = event.runId as string;
  await waitFor(async () => (await runStatus(runId)) === "waiting", 10_000, "run waiting");
  // `waiting` is set at the start of suspend(); it then schedules the timeout and re-checks whether
  // the wait is already settled (resuming if so). suspend() runs inside the run job, so wait for the
  // job to finish: only then is the run idle in `waiting`, and a decision written directly to the
  // database stays un-resumed (otherwise suspend's re-check can resume it under CI load).
  await waitFor(async () => (await runQueue.getActiveCount()) === 0, 10_000, "run job finished");
  return { runId, event };
}

const approvalIdOf = (e: ConversationEvent) =>
  (e as Extract<ConversationEvent, { type: "approval_requested" }>).payload.approvalId;
const questionIdOf = (e: ConversationEvent) =>
  (e as Extract<ConversationEvent, { type: "question_asked" }>).payload.questionId;

function decide(id: string, decision: "approve" | "deny", r: Req = req) {
  return r({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/approvals/${id}/decision`,
    payload: { decision },
  });
}

async function checkpointCount(runId: string): Promise<number> {
  const r = await sql<{
    n: string;
  }>`SELECT count(*)::text AS n FROM capybara.lg_checkpoints WHERE thread_id = ${runId}`.execute(
    raw,
  );
  return Number(r.rows[0]?.n ?? 0);
}

/** 让超时任务立即执行（把审批 / 输入请求的 expires_at 改到现在，再提前延迟任务）。 */
async function fireTimeout(table: "approvals" | "questions", id: string): Promise<void> {
  if (table === "approvals") {
    // 创建时间同时前移 24h：超时说明里的小时数按审批实际的等待时长计算
    await sql`UPDATE capybara.approvals SET expires_at = now(), created_at = now() - interval '24 hours'
      WHERE id = ${id}`.execute(raw);
  } else {
    await sql`UPDATE capybara.questions SET expires_at = now() WHERE id = ${id}`.execute(raw);
  }
  const job = await waitFor(() => maint.getJob(waitTimeoutJobId(id)), 5_000, "timeout job");
  await job.promote();
}

describe("审批等待", () => {
  it("ask → run 变 waiting，锁与配额已释放（满配额组织里另一会话可立刻运行），checkpoint 保留", async () => {
    const convA = await createConv(req, orgId, agentId);
    const { runId, event } = await startAndWait(convA, ECHO, "approval_requested");
    // 暂停时不写 tool_call_started（尚未开始执行）
    const evs = await eventsOf(db, convA);
    expect(ofType(evs, "tool_call_started")).toEqual([]);
    expect(resultsOf(evs)).toEqual([]);
    expect(memState().echoCalls).toBe(0);
    expect(await k.runs.lock.holder(convA)).toBeNull();
    expect(await checkpointCount(runId)).toBeGreaterThan(0);
    const approval = await db
      .selectFrom("approvals")
      .selectAll()
      .where("id", "=", approvalIdOf(event))
      .executeTakeFirstOrThrow();
    expect(approval).toMatchObject({ run_id: runId, status: "pending", requested_for: ownerId });
    // 超时任务已投递（延迟到 expires_at）
    const job = await maint.getJob(waitTimeoutJobId(approval.id));
    expect(job).toBeTruthy();
    expect(await job?.isDelayed()).toBe(true);

    // 组织并发为 1：等待中的运行不占配额，另一会话立刻完成
    const convB = await createConv(req, orgId, agentId);
    await postMessage(req, orgId, convB, "echo:quick");
    await waitForTerminal(db, convB, 1, 5_000);
    expect(await runStatus(runId)).toBe("waiting");
  });

  it("批准后从 checkpoint 续跑：写 tool_call_started 后执行，模型拿到结果；超过 maxRunSeconds 的等待不计入运行时长", async () => {
    const convId = await createConv(req, orgId, agentId);
    const { runId, event } = await startAndWait(convId, ECHO, "approval_requested");
    // maxRunSeconds = 3：等待 3.5s 后再批准，续跑不应按超时结束
    await sleep(3_500);
    const res = await decide(approvalIdOf(event), "approve");
    expect(res.statusCode, res.body).toBe(200);
    await waitForTerminal(db, convId, 1);
    const evs = await eventsOf(db, convId);
    expect(memState().echoCalls).toBe(1);
    const order = evs
      .filter((e) =>
        ["approval_requested", "approval_decided", "tool_call_started", "tool_result"].includes(
          e.type,
        ),
      )
      .map((e) => e.type);
    expect(order).toEqual([
      "approval_requested",
      "approval_decided",
      "tool_call_started",
      "tool_result",
    ]);
    expect(resultsOf(evs)).toMatchObject([{ content: '{"text":"hi"}', isError: false }]);
    const fin = ofType(evs, "run_finished");
    expect(fin.map((e) => e.payload.reason)).toEqual(["completed"]);
    const last = ofType(evs, "assistant_message").at(-1);
    expect(last?.payload.content).toEqual([{ type: "text", text: 'Tool result: {"text":"hi"}' }]);
    // 同一个运行：只有一个 runs 行、一条 run_started
    expect(await runsOf(db, convId)).toEqual([{ id: runId, status: "completed" }]);
    expect(ofType(evs, "run_started")).toHaveLength(1);
    // 终态事件写入后 worker 才删除 checkpoint
    await waitFor(async () => (await checkpointCount(runId)) === 0, 5_000, "checkpoint deleted");
  }, 20_000);

  it("拒绝后模型拿到拒绝说明，工具不执行", async () => {
    const convId = await createConv(req, orgId, agentId);
    const { event } = await startAndWait(convId, ECHO, "approval_requested");
    expect((await decide(approvalIdOf(event), "deny")).statusCode).toBe(200);
    await waitForTerminal(db, convId, 1);
    const evs = await eventsOf(db, convId);
    expect(memState().echoCalls).toBe(0);
    expect(ofType(evs, "tool_call_started")).toEqual([]);
    expect(resultsOf(evs)).toMatchObject([{ content: APPROVAL_DENIED_TEXT, isError: true }]);
    expect(APPROVAL_DENIED_TEXT).toBe("The user denied this tool call.");
    expect(ofType(evs, "assistant_message").at(-1)?.payload.content).toEqual([
      { type: "text", text: `Tool result: ${APPROVAL_DENIED_TEXT}` },
    ]);
  });

  it("超时按拒绝：超时任务把审批置 expired、写 approval_decided{expired}，续跑后模型拿到超时说明", async () => {
    const convId = await createConv(req, orgId, agentId);
    const { event } = await startAndWait(convId, ECHO, "approval_requested");
    const id = approvalIdOf(event);
    await fireTimeout("approvals", id);
    await waitForTerminal(db, convId, 1);
    const evs = await eventsOf(db, convId);
    expect(ofType(evs, "approval_decided").map((e) => e.payload)).toEqual([
      { approvalId: id, callId: expect.any(String), decision: "expired", byAccountId: null },
    ]);
    expect(approvalExpiredText(24)).toBe("Approval timed out after 24h; treated as denied.");
    expect(resultsOf(evs)).toMatchObject([{ content: approvalExpiredText(24), isError: true }]);
    expect(memState().echoCalls).toBe(0);
    // 已过期的审批不能再处理
    const late = await decide(id, "approve");
    expect(late.statusCode).toBe(409);
  });

  it("等待期间发两条消息：不新建 run，续跑后都被吸收，只有一个 run", async () => {
    const convId = await createConv(req, orgId, agentId);
    const { runId, event } = await startAndWait(convId, ECHO, "approval_requested");
    await postMessage(req, orgId, convId, "echo:first");
    const second = await postMessage(req, orgId, convId, "echo:second");
    await sleep(300);
    expect(await runsOf(db, convId)).toEqual([{ id: runId, status: "waiting" }]);
    expect((await decide(approvalIdOf(event), "approve")).statusCode).toBe(200);
    await waitForTerminal(db, convId, 1);
    await sleep(500);
    const evs = await eventsOf(db, convId);
    expect(await runsOf(db, convId)).toEqual([{ id: runId, status: "completed" }]);
    const fin = ofType(evs, "run_finished");
    expect(fin).toHaveLength(1);
    expect(fin[0]?.payload.consumedUpToSeq).toBeGreaterThanOrEqual(second);
    // 第二步请求吸收了两条插话
    const calls = ofType(evs, "model_call");
    expect(calls.at(-1)?.payload.request.absorbedUpToSeq).toBeGreaterThanOrEqual(second);
  });

  it("等待期间中止：审批置 cancelled、写 approval_decided 与取消说明的 tool_result，run aborted，checkpoint 删除", async () => {
    const convId = await createConv(req, orgId, agentId);
    const { runId, event } = await startAndWait(convId, ECHO, "approval_requested");
    const id = approvalIdOf(event);
    const res = await req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/conversations/${convId}/abort`,
    });
    expect(res.statusCode, res.body).toBe(202);
    expect((res.json() as { runId: string }).runId).toBe(runId);
    await waitForTerminal(db, convId, 1);
    const evs = await eventsOf(db, convId);
    expect(ofType(evs, "run_aborted").map((e) => e.payload)).toEqual([
      { byAccountId: ownerId, reason: "user" },
    ]);
    expect(ofType(evs, "approval_decided").map((e) => e.payload.decision)).toEqual(["cancelled"]);
    expect(resultsOf(evs)).toMatchObject([{ content: APPROVAL_CANCELLED_TEXT, isError: true }]);
    expect(APPROVAL_CANCELLED_TEXT).toBe("The run was stopped while waiting for approval.");
    expect(await runStatus(runId)).toBe("aborted");
    const row = await db
      .selectFrom("approvals")
      .select("status")
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe("cancelled");
    expect(await checkpointCount(runId)).toBe(0);
    // 已取消的审批不能再处理；超时任务到点也什么都不做
    expect((await decide(id, "approve")).statusCode).toBe(409);
    await fireTimeout("approvals", id);
    await sleep(500);
    expect(ofType(await eventsOf(db, convId), "approval_decided")).toHaveLength(1);
    expect(memState().echoCalls).toBe(0);
  });

  it("丢失唤醒：决定在置 waiting 之前提交（其续跑因运行仍是 running 而落空），suspend 复查后续跑，工具只执行一次", async () => {
    const convId = await createConv(req, orgId, agentId);
    const { runId, event } = await startAndWait(convId, ECHO, "approval_requested");
    const id = approvalIdOf(event);
    // 构造「worker 刚暂停、尚未置 waiting」的时刻：运行退回 running
    await sql`UPDATE capybara.runs SET status = 'running', waiting_since = NULL WHERE id = ${runId}`.execute(
      raw,
    );
    expect((await decide(id, "approve")).statusCode).toBe(200);
    await sleep(200);
    // 决定的续跑落空：运行仍是 running，没有续跑
    expect(await runStatus(runId)).toBe("running");
    expect(memState().echoCalls).toBe(0);
    await k.runs.waits.suspend(runId, convId, {
      kind: "approval",
      id,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    await waitForTerminal(db, convId, 1);
    const evs = await eventsOf(db, convId);
    expect(memState().echoCalls).toBe(1);
    expect(ofType(evs, "run_finished").map((e) => e.runId)).toEqual([runId]);
    expect(resultsOf(evs)).toMatchObject([{ content: '{"text":"hi"}', isError: false }]);
  });

  it("丢失唤醒（输入请求）：回答在置 waiting 之前提交，suspend 复查后续跑", async () => {
    const convId = await createConv(req, orgId, agentId);
    const { runId, event } = await startAndWait(
      convId,
      'tool:mem-connector__ask:{"rounds":1}',
      "question_asked",
    );
    const qid = questionIdOf(event);
    await sql`UPDATE capybara.runs SET status = 'running', waiting_since = NULL WHERE id = ${runId}`.execute(
      raw,
    );
    await k.tools.questions.answer(qid, ownerId, { color: "blue" });
    await sleep(200);
    expect(await runStatus(runId)).toBe("running");
    expect(memState().askCalls).toHaveLength(1);
    await k.runs.waits.suspend(runId, convId, {
      kind: "input",
      id: qid,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    await waitForTerminal(db, convId, 1);
    expect(memState().askCalls).toHaveLength(2);
    expect(resultsOf(await eventsOf(db, convId))).toMatchObject([
      { content: "color=blue after 1", isError: false },
    ]);
  });

  it("决定已提交、续跑尚未发生时中止：已决定的调用也写取消说明（不留给配对守卫补「结果未知」）", async () => {
    const convId = await createConv(req, orgId, agentId);
    const { runId, event } = await startAndWait(convId, ECHO, "approval_requested");
    // 只提交决定、不续跑（模拟决定提交与续跑之间的窗口）
    await sql`UPDATE capybara.approvals SET status = 'approved', decided_at = now()
      WHERE id = ${approvalIdOf(event)}`.execute(raw);
    const res = await req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/conversations/${convId}/abort`,
    });
    expect(res.statusCode).toBe(202);
    expect(await runStatus(runId)).toBe("aborted");
    const evs = await eventsOf(db, convId);
    expect(resultsOf(evs)).toMatchObject([{ content: APPROVAL_CANCELLED_TEXT, isError: true }]);
    expect(memState().echoCalls).toBe(0);
  });

  it("暂停到置 waiting 之间到达的中止（只留在中止标记里）：置 waiting 后补查并按等待中中止处理", async () => {
    const convId = await createConv(req, orgId, agentId);
    const { runId, event } = await startAndWait(convId, ECHO, "approval_requested");
    // 构造「worker 刚暂停、尚未置 waiting」的时刻：运行退回 running，此时的中止没有订阅者
    await sql`UPDATE capybara.runs SET status = 'running' WHERE id = ${runId}`.execute(raw);
    await k.runs.abort.request(runId, ownerId);
    await k.runs.waits.suspend(runId, convId, {
      kind: "approval",
      id: approvalIdOf(event),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(await runStatus(runId)).toBe("aborted");
    const evs = await eventsOf(db, convId);
    expect(ofType(evs, "approval_decided").map((e) => e.payload.decision)).toEqual(["cancelled"]);
    expect(ofType(evs, "run_aborted").map((e) => e.payload.byAccountId)).toEqual([ownerId]);
  });

  it("同一审批多次续跑只有一次生效（条件更新 waiting → queued）", async () => {
    const convId = await createConv(req, orgId, agentId);
    const { runId, event } = await startAndWait(convId, ECHO, "approval_requested");
    const id = approvalIdOf(event);
    // 审批仍 pending：续跑不生效
    expect(await k.runs.waits.resume(runId, id)).toBe(false);
    expect((await decide(id, "approve")).statusCode).toBe(200);
    await waitForTerminal(db, convId, 1);
    // 运行已结束：再续跑也不生效
    const again = await Promise.all([1, 2, 3].map(() => k.runs.waits.resume(runId, id)));
    expect(again).toEqual([false, false, false]);
    expect(memState().echoCalls).toBe(1);
    expect(ofType(await eventsOf(db, convId), "run_finished")).toHaveLength(1);
  });
});

describe("输入请求等待", () => {
  it("工具返回 input_required → questions 行与 question_asked，run waiting；回答后用同一 input 与 ctx.resume 再调用", async () => {
    const convId = await createConv(req, orgId, agentId);
    const { runId, event } = await startAndWait(
      convId,
      'tool:mem-connector__ask:{"rounds":1}',
      "question_asked",
    );
    const qid = questionIdOf(event);
    const q = await db
      .selectFrom("questions")
      .selectAll()
      .where("id", "=", qid)
      .executeTakeFirstOrThrow();
    expect(q).toMatchObject({ run_id: runId, status: "pending" });
    expect(event.payload).toMatchObject({
      step: 1,
      questionId: qid,
      form: { title: "Pick a color" },
      expiresAt: expect.any(String),
    });
    expect(memState().askCalls).toHaveLength(1);

    // 校验：不合规的答案 → validation_failed；非发起人 → forbidden
    await expect(k.tools.questions.answer(qid, ownerId, { color: "green" })).rejects.toMatchObject({
      code: "validation_failed",
    });
    const other = await accountsFor(db).createLocal({
      login: "other",
      password: PW,
      displayName: "X",
    });
    await testMembers(db).add(orgId, other.id, "member", ownerId);
    await expect(k.tools.questions.answer(qid, other.id, { color: "red" })).rejects.toMatchObject({
      code: "forbidden",
    });

    await k.tools.questions.answer(qid, ownerId, { color: "red" });
    // 第二次回答 → 409
    const dup = await k.tools.questions.answer(qid, ownerId, { color: "blue" }).catch((e) => e);
    expect(dup).toBeInstanceOf(ApiError);
    expect((dup as ApiError).code).toBe("question.already_answered");

    await waitForTerminal(db, convId, 1);
    const evs = await eventsOf(db, convId);
    expect(memState().askCalls).toEqual([
      { input: { rounds: 1 }, resume: null },
      { input: { rounds: 1 }, resume: { state: { n: 1 }, answer: { color: "red" } } },
    ]);
    expect(ofType(evs, "question_answered").map((e) => e.payload)).toEqual([
      {
        questionId: qid,
        callId: expect.any(String),
        answer: { color: "red" },
        byAccountId: ownerId,
        outcome: "answered",
      },
    ]);
    // 两次调用各写一次 tool_call_started
    expect(ofType(evs, "tool_call_started")).toHaveLength(2);
    expect(resultsOf(evs)).toMatchObject([{ content: "color=red after 1", isError: false }]);
    expect(await runsOf(db, convId)).toEqual([{ id: runId, status: "completed" }]);
  });

  it("输入请求超时 → ctx.resume.answer = null 再调用一次，由工具决定结果", async () => {
    const convId = await createConv(req, orgId, agentId);
    const { event } = await startAndWait(
      convId,
      'tool:mem-connector__ask:{"rounds":1}',
      "question_asked",
    );
    const qid = questionIdOf(event);
    await fireTimeout("questions", qid);
    await waitForTerminal(db, convId, 1);
    const evs = await eventsOf(db, convId);
    expect(ofType(evs, "question_answered").map((e) => e.payload)).toEqual([
      {
        questionId: qid,
        callId: expect.any(String),
        answer: null,
        byAccountId: null,
        outcome: "expired",
      },
    ]);
    expect(memState().askCalls.at(-1)?.resume).toEqual({ state: { n: 1 }, answer: null });
    expect(resultsOf(evs)).toMatchObject([{ content: "no answer", isError: false }]);
  });

  it("同一调用最多连续请求输入 3 次，第 4 次 → 工具错误", async () => {
    const convId = await createConv(req, orgId, agentId);
    await postMessage(req, orgId, convId, 'tool:mem-connector__ask:{"rounds":5}');
    for (let i = 1; i <= 3; i++) {
      const asked = await waitFor(
        async () => {
          const qs = ofType(await eventsOf(db, convId), "question_asked");
          return qs.length >= i ? qs[i - 1] : null;
        },
        10_000,
        `question ${i}`,
      );
      await waitFor(
        async () => (await runStatus(asked.runId as string)) === "waiting",
        10_000,
        "waiting",
      );
      await k.tools.questions.answer(asked.payload.questionId, ownerId, { color: "blue" });
    }
    await waitForTerminal(db, convId, 1);
    const evs = await eventsOf(db, convId);
    expect(ofType(evs, "question_asked")).toHaveLength(3);
    expect(memState().askCalls).toHaveLength(4);
    expect(TOO_MANY_INPUT_REQUESTS_TEXT).toBe("Tool requested user input too many times.");
    expect(resultsOf(evs)).toMatchObject([
      { content: TOO_MANY_INPUT_REQUESTS_TEXT, isError: true },
    ]);
  });

  it("不合规的表单 → 工具错误，不暂停", async () => {
    const convId = await createConv(req, orgId, agentId);
    await postMessage(req, orgId, convId, 'tool:mem-connector__ask:{"bad":true}');
    await waitForTerminal(db, convId, 1);
    const evs = await eventsOf(db, convId);
    expect(ofType(evs, "question_asked")).toEqual([]);
    const [r] = resultsOf(evs);
    expect(r?.isError).toBe(true);
    expect(r?.content).toContain("invalid input form");
    expect(r?.content).toContain("form must have at least one field");
  });

  it("等待输入时中止：输入请求置 cancelled、写 question_answered{cancelled} 与取消说明，run aborted", async () => {
    const convId = await createConv(req, orgId, agentId);
    const { runId, event } = await startAndWait(
      convId,
      'tool:mem-connector__ask:{"rounds":1}',
      "question_asked",
    );
    const res = await req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/conversations/${convId}/abort`,
    });
    expect(res.statusCode).toBe(202);
    await waitForTerminal(db, convId, 1);
    const evs = await eventsOf(db, convId);
    expect(ofType(evs, "question_answered").map((e) => e.payload)).toEqual([
      {
        questionId: questionIdOf(event),
        callId: expect.any(String),
        answer: null,
        byAccountId: null,
        outcome: "cancelled",
      },
    ]);
    expect(resultsOf(evs)).toMatchObject([{ content: INPUT_CANCELLED_TEXT, isError: true }]);
    expect(await runStatus(runId)).toBe("aborted");
    await expect(
      k.tools.questions.answer(questionIdOf(event), ownerId, { color: "red" }),
    ).rejects.toMatchObject({ code: "question.already_answered" });
  });
});
