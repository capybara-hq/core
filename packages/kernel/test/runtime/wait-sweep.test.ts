import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { AccountsService } from "../../src/identity/accounts.js";
import { createKernel, type Kernel } from "../../src/kernel.js";
import { createLogger } from "../../src/log.js";
import { RUN_QUEUE_NAME } from "../../src/runtime/run-queue.js";
import {
  MAINTENANCE_QUEUE_NAME,
  WAIT_SWEEP_EVERY_MS,
  WAIT_SWEEP_JOB,
  WAIT_SWEEP_SCHEDULER_ID,
  type WaitSweepResult,
  waitTimeoutJobId,
} from "../../src/runtime/waits.js";
import { approvalExpiredText } from "../../src/tools/pipeline.js";
import { memState } from "../fixtures/plugins/mem-connector/index.js";
import { truncateTables } from "../helpers/db.js";
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
  waitFor,
  waitForEvent,
  waitForRunJobDone,
  waitForTerminal,
} from "../helpers/runs.js";

/**
 * Task 22：等待的兜底扫描（维护队列每 10 分钟一次）。
 * 1. 过期仍 pending 的审批 / 输入请求（超时任务丢失）→ 按超时处理并续跑；
 * 2. 等待已全部处理、续跑却丢了（决定提交后崩溃 / 投递回滚）的 waiting 运行 → 续跑（超过宽限期才处理）；
 * 3. 运行已终态、仍 pending 的审批 / 输入请求 → 取消（写决定 / 回答事件）。
 * 双副本同时扫描：每项修复恰好一次。
 */

const MEM_CONNECTOR = fileURLToPath(
  new URL("../fixtures/plugins/mem-connector/index.ts", import.meta.url),
);

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelDb;
let maint: Queue;
let runQueue: Queue;
let kA: Kernel;
let kB: Kernel;
/** 两个副本各自的 warn 日志（只收扫描写的行）。 */
const logs: { A: Record<string, unknown>[]; B: Record<string, unknown>[] } = { A: [], B: [] };

let req: Req;
let orgId: string;
let ownerId: string;
let agentId: string;

const ECHO = 'tool:mem-connector__echo:{"text":"hi"}';
const ASK = 'tool:mem-connector__ask:{"rounds":1}';
const ofType = <T extends ConversationEvent["type"]>(evs: ConversationEvent[], type: T) =>
  evs.filter((e): e is Extract<ConversationEvent, { type: T }> => e.type === type);

async function boot(name: "A" | "B"): Promise<Kernel> {
  const logger = createLogger("warn", {
    write: (line) => {
      const rec = JSON.parse(line) as Record<string, unknown>;
      if (String(rec.msg).startsWith("wait sweep")) logs[name].push(rec);
    },
  });
  const k = await createKernel(
    runConfig({ pg: pgc.url, redis: rd.url }, { plugins: [MODEL_FAKE, MEM_CONNECTOR] }),
    { env: {}, logger },
  );
  await k.start();
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
  maint = new Queue(MAINTENANCE_QUEUE_NAME, { connection: new Redis(rd.url) });
  runQueue = new Queue(RUN_QUEUE_NAME, { connection: new Redis(rd.url) });
  kA = await boot("A");
  kB = await boot("B");
}, 120_000);

afterAll(async () => {
  await maint?.close();
  await runQueue?.close();
  await kA?.stop();
  await kB?.stop();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

beforeEach(async () => {
  await truncateTables(raw, "capybara.accounts, capybara.orgs, capybara.audit_events");
  const owner = await new AccountsService(db).createLocal({
    login: "owner",
    password: PW,
    displayName: "O",
  });
  ownerId = owner.id;
  memState().echoCalls = 0;
  memState().askCalls = [];
  logs.A.length = 0;
  logs.B.length = 0;
  req = await session(kA, "owner");
  orgId = await createOrg(req);
  const en = await req({
    method: "PUT",
    url: `/api/v1/orgs/${orgId}/plugins/mem-connector`,
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
        tools: [
          { kind: "plugin", plugin: "mem-connector", name: "echo" },
          { kind: "plugin", plugin: "mem-connector", name: "ask" },
        ],
        toolPolicies: { "mem-connector__echo": "ask" },
      },
      visibility: "org",
    },
  });
  expect(ag.statusCode, ag.body).toBe(201);
  agentId = (ag.json() as { agent: { id: string } }).agent.id;
});

async function runStatus(runId: string): Promise<string> {
  const r = await db
    .selectFrom("runs")
    .select("status")
    .where("id", "=", runId)
    .executeTakeFirstOrThrow();
  return r.status;
}

/**
 * Starts a conversation, posts the message and waits until the run has fully suspended; returns the
 * conversation, run and wait ids. Seeing `status = 'waiting'` is not enough: after setting waiting,
 * `Waits.suspend` still schedules the timeout job and re-checks whether the wait was already settled
 * (and resumes if so). A test that changes the approval before that re-check gets a legitimate
 * resume. So also wait for the run job to leave the run queue (removeOnComplete: the job completes
 * only after the worker returns from `suspend`; see `waitForRunJobDone`).
 */
async function waiting(
  text: string,
  type: "approval_requested" | "question_asked",
): Promise<{ convId: string; runId: string; waitId: string }> {
  const convId = await createConv(req, orgId, agentId);
  await postMessage(req, orgId, convId, text);
  const event = await waitForEvent(db, convId, (e) => e.type === type, 10_000, type);
  const runId = event.runId as string;
  await waitFor(async () => (await runStatus(runId)) === "waiting", 10_000, "run waiting");
  await waitForRunJobDone(db, runQueue, runId);
  const p = event.payload as { approvalId?: string; questionId?: string };
  return { convId, runId, waitId: (p.approvalId ?? p.questionId) as string };
}

/** 模拟超时任务丢失：删掉延迟任务，并把到期时间改到过去。 */
async function loseTimeout(table: "approvals" | "questions", id: string): Promise<void> {
  await (await maint.getJob(waitTimeoutJobId(id)))?.remove();
  if (table === "approvals") {
    await sql`UPDATE capybara.approvals SET expires_at = now() - interval '1 second',
      created_at = now() - interval '24 hours' WHERE id = ${id}`.execute(raw);
  } else {
    await sql`UPDATE capybara.questions SET expires_at = now() - interval '1 second'
      WHERE id = ${id}`.execute(raw);
  }
}

/** 模拟「决定已提交、续跑丢失」：审批直接置 approved（不经续跑钩子），waiting 时长超过宽限期。 */
async function loseResume(approvalId: string, runId: string, waitedMinutes = 2): Promise<void> {
  await sql`UPDATE capybara.approvals SET status = 'approved', scope = 'once',
    decided_by = ${ownerId}, decided_at = now() WHERE id = ${approvalId}`.execute(raw);
  await sql`UPDATE capybara.runs SET waiting_since = now() - ${waitedMinutes}::integer * interval '1 minute'
    WHERE id = ${runId}`.execute(raw);
}

const sum = (rs: WaitSweepResult[]): WaitSweepResult =>
  rs.reduce(
    (a, r) => ({
      expired: a.expired + r.expired,
      resumed: a.resumed + r.resumed,
      cancelled: a.cancelled + r.cancelled,
    }),
    { expired: 0, resumed: 0, cancelled: 0 },
  );

describe("等待兜底扫描（单副本）", () => {
  it("每 10 分钟的 job scheduler：id / 任务名不含冒号，两个副本启动后只有一个", async () => {
    expect(WAIT_SWEEP_SCHEDULER_ID).not.toContain(":");
    expect(WAIT_SWEEP_JOB).not.toContain(":");
    expect(WAIT_SWEEP_EVERY_MS).toBe(600_000);
    const s = (await maint.getJobSchedulers()).filter((x) => x.key === WAIT_SWEEP_SCHEDULER_ID);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ name: WAIT_SWEEP_JOB, every: WAIT_SWEEP_EVERY_MS });
  });

  it("超时任务丢失的过期审批 → 按超时处理（approval_decided{expired}）并续跑，模型拿到超时说明", async () => {
    const { convId, runId, waitId } = await waiting(ECHO, "approval_requested");
    await loseTimeout("approvals", waitId);
    expect(await kA.runs.waits.sweep()).toEqual({ expired: 1, resumed: 0, cancelled: 0 });
    await waitForTerminal(db, convId, 1);
    const evs = await eventsOf(db, convId);
    expect(ofType(evs, "approval_decided").map((e) => e.payload)).toEqual([
      { approvalId: waitId, callId: expect.any(String), decision: "expired", byAccountId: null },
    ]);
    expect(ofType(evs, "tool_result").map((e) => e.payload.content)).toEqual([
      approvalExpiredText(24),
    ]);
    expect(await runsOf(db, convId)).toEqual([{ id: runId, status: "completed" }]);
    expect(memState().echoCalls).toBe(0);
    expect(logs.A).toEqual([
      expect.objectContaining({
        level: "warn",
        msg: "wait sweep: expired overdue wait",
        kind: "approval",
        id: waitId,
        runId,
      }),
    ]);
    // 再扫一次：无事可做
    expect(await kA.runs.waits.sweep()).toEqual({ expired: 0, resumed: 0, cancelled: 0 });
  });

  it("超时任务丢失的过期输入请求 → question_answered{expired}，续跑后工具拿到 answer = null", async () => {
    const { convId, waitId } = await waiting(ASK, "question_asked");
    await loseTimeout("questions", waitId);
    expect(await kA.runs.waits.sweep()).toEqual({ expired: 1, resumed: 0, cancelled: 0 });
    await waitForTerminal(db, convId, 1);
    const evs = await eventsOf(db, convId);
    expect(ofType(evs, "question_answered").map((e) => e.payload)).toMatchObject([
      { questionId: waitId, outcome: "expired", answer: null, byAccountId: null },
    ]);
    expect(memState().askCalls.at(-1)).toMatchObject({ resume: { answer: null } });
  });

  it("扫描与超时任务同时处理同一过期审批：恰好一条决定事件、只续跑一次", async () => {
    const { convId, waitId } = await waiting(ECHO, "approval_requested");
    await loseTimeout("approvals", waitId);
    const [r] = await Promise.all([
      kA.runs.waits.sweep(),
      kB.runs.waits.expire("approval", waitId),
    ]);
    expect(r.expired).toBeLessThanOrEqual(1);
    await waitForTerminal(db, convId, 1);
    const evs = await eventsOf(db, convId);
    expect(ofType(evs, "approval_decided")).toHaveLength(1);
    expect(ofType(evs, "tool_result")).toHaveLength(1);
    expect(await runsOf(db, convId)).toEqual([{ id: expect.any(String), status: "completed" }]);
  });

  it("决定已提交、续跑丢失的 waiting 运行：宽限期内不动，超过后续跑一次，工具执行一次", async () => {
    const { convId, runId, waitId } = await waiting(ECHO, "approval_requested");
    // 宽限期内（刚刚还在等待）：可能是正常续跑正在进行，不动
    await loseResume(waitId, runId, 0);
    expect(await kA.runs.waits.sweep()).toEqual({ expired: 0, resumed: 0, cancelled: 0 });
    expect(await runStatus(runId)).toBe("waiting");
    await loseResume(waitId, runId, 2);
    expect(await kA.runs.waits.sweep()).toEqual({ expired: 0, resumed: 1, cancelled: 0 });
    await waitForTerminal(db, convId, 1);
    expect(memState().echoCalls).toBe(1);
    expect(await runsOf(db, convId)).toEqual([{ id: runId, status: "completed" }]);
    expect(logs.A).toEqual([
      expect.objectContaining({ msg: "wait sweep: resumed stuck waiting run", runId }),
    ]);
    expect(await kA.runs.waits.sweep()).toEqual({ expired: 0, resumed: 0, cancelled: 0 });
  });

  it("运行已终态（如暂停时失败）仍 pending 的审批 / 输入请求 → 取消并写决定 / 回答事件，待处理列表变干净", async () => {
    const a = await waiting(ECHO, "approval_requested");
    const q = await waiting(ASK, "question_asked");
    await sql`UPDATE capybara.runs SET status = 'failed', waiting_since = NULL
      WHERE id IN (${a.runId}, ${q.runId})`.execute(raw);
    expect(await kA.runs.waits.sweep()).toEqual({ expired: 0, resumed: 0, cancelled: 2 });

    const aEvs = await eventsOf(db, a.convId);
    expect(ofType(aEvs, "approval_decided").map((e) => e.payload)).toEqual([
      {
        approvalId: a.waitId,
        callId: expect.any(String),
        decision: "cancelled",
        byAccountId: null,
      },
    ]);
    const qEvs = await eventsOf(db, q.convId);
    expect(ofType(qEvs, "question_answered").map((e) => e.payload)).toMatchObject([
      { questionId: q.waitId, outcome: "cancelled", answer: null, byAccountId: null },
    ]);
    const pending = await req({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/approvals?status=pending`,
    });
    expect(pending.statusCode, pending.body).toBe(200);
    expect((pending.json() as { approvals: unknown[] }).approvals).toEqual([]);
    expect(await runStatus(a.runId)).toBe("failed");
    expect(await runStatus(q.runId)).toBe("failed");
    expect(logs.A.map((l) => [l.msg, l.runId]).sort()).toEqual(
      [
        ["wait sweep: cancelled waits of finished run", a.runId],
        ["wait sweep: cancelled waits of finished run", q.runId],
      ].sort(),
    );
    expect(await kA.runs.waits.sweep()).toEqual({ expired: 0, resumed: 0, cancelled: 0 });
  });
});

describe("等待兜底扫描（双副本）", () => {
  it("两个副本同时扫描：过期、续跑、取消三项修复各恰好一次", async () => {
    const overdue = await waiting(ECHO, "approval_requested");
    const stuck = await waiting(ECHO, "approval_requested");
    const finished = await waiting(ECHO, "approval_requested");
    await loseTimeout("approvals", overdue.waitId);
    await loseResume(stuck.waitId, stuck.runId);
    await sql`UPDATE capybara.runs SET status = 'failed', waiting_since = NULL
      WHERE id = ${finished.runId}`.execute(raw);

    const results = await Promise.all([kA.runs.waits.sweep(), kB.runs.waits.sweep()]);
    expect(sum(results)).toEqual({ expired: 1, resumed: 1, cancelled: 1 });

    await waitForTerminal(db, overdue.convId, 1);
    await waitForTerminal(db, stuck.convId, 1);
    const decisions = async (convId: string) =>
      ofType(await eventsOf(db, convId), "approval_decided").map((e) => e.payload.decision);
    expect(await decisions(overdue.convId)).toEqual(["expired"]);
    expect(await decisions(finished.convId)).toEqual(["cancelled"]);
    expect(await runsOf(db, overdue.convId)).toEqual([{ id: overdue.runId, status: "completed" }]);
    expect(await runsOf(db, stuck.convId)).toEqual([{ id: stuck.runId, status: "completed" }]);
    expect(await runStatus(finished.runId)).toBe("failed");
    // 被续跑的那次调用只执行一次
    expect(memState().echoCalls).toBe(1);
    const stuckResults = ofType(await eventsOf(db, stuck.convId), "tool_result");
    expect(stuckResults).toHaveLength(1);
    // 两个副本合计每项修复一行 warn
    expect([...logs.A, ...logs.B].map((l) => l.msg).sort()).toEqual([
      "wait sweep: cancelled waits of finished run",
      "wait sweep: expired overdue wait",
      "wait sweep: resumed stuck waiting run",
    ]);
  });
});
