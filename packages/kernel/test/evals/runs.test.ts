import { fileURLToPath } from "node:url";
import { ModelError } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EventLog } from "../../src/conversations/event-log.js";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import type { EvalEstimate, EvalResultView, EvalRunView } from "../../src/evals/runs.service.js";
import type { EvalSetView } from "../../src/evals/sets.service.js";
import { AccountsService } from "../../src/identity/accounts.js";
import type { Kernel } from "../../src/kernel.js";
import { evalModelState, resetEvalModel } from "../fixtures/plugins/model-eval/index.js";
import { truncateTables } from "../helpers/db.js";
import { testMembers } from "../helpers/members.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createAgent,
  createConv,
  createOrg,
  PW,
  postMessage,
  type Req,
  runConfig,
  session,
  startKernel,
  waitFor,
  waitForTerminal,
} from "../helpers/runs.js";

/**
 * 评测运行（T4，D5 / C7）：估算、启动校验、队列执行、取消与结果分页。用例快照来自真实运行（model-fake）
 * 或直接写日志的两步运行（用量已知，便于核对估算与 token 计数）。
 */

const MODEL_EVAL = fileURLToPath(
  new URL("../fixtures/plugins/model-eval/index.ts", import.meta.url),
);
const EVAL_1 = { provider: "model-eval", model: "eval-1" };
const MAX_TOKEN_CAP = 100_000;
const MAX_CONSECUTIVE_ERRORS = 3;

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelDb;
let k: Kernel;
let eventLog: EventLog;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  eventLog = new EventLog(db, { publish: async () => {} });
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        plugins: [MODEL_FAKE, MODEL_EVAL],
        evals: {
          maxTokenCap: MAX_TOKEN_CAP,
          defaultTokenCap: 50_000,
          orgConcurrency: 2,
          maxConsecutiveErrors: MAX_CONSECUTIVE_ERRORS,
        },
      },
    ),
  );
}, 120_000);
afterAll(async () => {
  await k?.stop();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

let owner: Req;
let admin: Req;
let alice: Req;
let aliceId: string;
let adminId: string;
let orgId: string;
let agentId: string;

const errCode = (res: { json(): unknown }) =>
  (res.json() as { error?: { code?: string } }).error?.code;

const U0 = { inputTokens: 100, outputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 1 };
const U1 = { inputTokens: 200, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 };
const sum = (u: typeof U0) =>
  u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;

/**
 * 直接写日志的一次两步运行：第 0 步先有一次失败的尝试，再成功（回复带工具调用）、工具结果；第 1 步文本回复。
 * 可单步回放的调用 = 2（每步最后一次尝试），原运行的模型调用 = 3。
 */
async function seedTwoStepRun(convId: string, runId: string, version = 1): Promise<void> {
  const [msg] = await eventLog.append(convId, [
    {
      type: "user_message",
      payload: { content: [{ type: "text", text: `question ${runId}` }], authorAccountId: aliceId },
    },
  ]);
  const userSeq = msg?.seq ?? 0;
  await db
    .insertInto("runs")
    .values({
      id: runId,
      conversation_id: convId,
      status: "completed",
      agent_version: version,
      trigger_account_id: aliceId,
      trigger_seq: userSeq,
      started_at: new Date(),
      finished_at: new Date(),
    })
    .execute();
  const request = {
    fromSeq: 1,
    toSeq: 1_000_000,
    summarySeq: null,
    systemHash: "h",
    reminderSeqs: [],
    tools: [],
    params: {},
    absorbedUpToSeq: userSeq,
    maxOutputTokens: 1000,
  };
  const call = (step: number, attempt: number) => ({
    type: "model_call" as const,
    runId,
    payload: {
      step,
      attempt,
      provider: "model-fake",
      model: "fake-1",
      fallback: false,
      request,
    },
  });
  await eventLog.append(convId, [
    {
      type: "run_started",
      runId,
      payload: {
        agentVersion: version,
        model: { provider: "model-fake", model: "fake-1" },
        triggerAccountId: aliceId,
      },
    },
    call(0, 0),
    call(0, 1),
    {
      type: "assistant_message",
      runId,
      payload: {
        step: 0,
        content: [
          { type: "text", text: "looking" },
          { type: "tool_call", id: `c-${runId}`, name: "t", input: {} },
        ],
        stopReason: "tool_use",
      },
    },
    { type: "usage", runId, payload: { step: 0, provider: "model-fake", model: "fake-1", ...U0 } },
    {
      type: "tool_call_started",
      runId,
      payload: { step: 0, callId: `c-${runId}`, toolKey: "t", specHash: "s" },
    },
    {
      type: "tool_result",
      runId,
      payload: { step: 0, callId: `c-${runId}`, toolKey: "t", content: "ok", isError: false },
    },
    call(1, 0),
    {
      type: "assistant_message",
      runId,
      payload: { step: 1, content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
    },
    { type: "usage", runId, payload: { step: 1, provider: "model-fake", model: "fake-1", ...U1 } },
    { type: "run_finished", runId, payload: { reason: "completed", consumedUpToSeq: userSeq } },
  ]);
}

beforeEach(async () => {
  await truncateTables(
    raw,
    "capybara.eval_results, capybara.eval_runs, capybara.eval_cases, capybara.eval_sets, capybara.model_prices, capybara.conversation_events, capybara.runs, capybara.conversations, capybara.agent_versions, capybara.agent_members, capybara.agents, capybara.audit_events, capybara.memberships, capybara.orgs, capybara.deployment_settings, capybara.sessions, capybara.local_passwords, capybara.identities, capybara.accounts",
  );
  resetEvalModel();
  const accounts = new AccountsService(db);
  const mk = async (login: string) =>
    (await accounts.createLocal({ login, password: PW, displayName: login })).id;
  const ownerId = await mk("owner");
  adminId = await mk("admin");
  aliceId = await mk("alice");
  owner = await session(k, "owner");
  orgId = await createOrg(owner);
  const members = testMembers(db);
  await members.add(orgId, adminId, "admin", ownerId);
  await members.add(orgId, aliceId, "member", ownerId);
  admin = await session(k, "admin");
  alice = await session(k, "alice");
  agentId = await createAgent(alice, orgId);
});

const setsUrl = () => `/api/v1/orgs/${orgId}/eval-sets`;
const runsUrl = () => `/api/v1/orgs/${orgId}/eval-runs`;

async function createSet(): Promise<string> {
  const res = await admin({
    method: "POST",
    url: setsUrl(),
    payload: { agentId, name: "Smoke" },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { set: EvalSetView }).set.id;
}

async function addCase(setId: string, conversationId: string, runId: string): Promise<string> {
  const res = await admin({
    method: "POST",
    url: `${setsUrl()}/${setId}/cases`,
    payload: { conversationId, runId },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { case: { id: string } }).case.id;
}

/** n 个两步用例（各自一个对话）。 */
async function seededSet(n: number): Promise<string> {
  const setId = await createSet();
  for (let i = 0; i < n; i++) {
    const conv = await createConv(alice, orgId, agentId);
    await seedTwoStepRun(conv, `run-${i}`);
    await addCase(setId, conv, `run-${i}`);
  }
  return setId;
}

async function startRun(setId: string, body: Record<string, unknown>): Promise<EvalRunView> {
  const res = await admin({ method: "POST", url: `${setsUrl()}/${setId}/runs`, payload: body });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { run: EvalRunView }).run;
}

async function getRun(runId: string): Promise<EvalRunView> {
  const res = await admin({ method: "GET", url: `${runsUrl()}/${runId}` });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { run: EvalRunView }).run;
}

async function allResults(runId: string): Promise<EvalResultView[]> {
  const res = await admin({ method: "GET", url: `${runsUrl()}/${runId}/results?limit=200` });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { results: EvalResultView[] }).results;
}

const settled = (runId: string, timeoutMs = 20_000) =>
  waitFor(
    async () => {
      const rs = await allResults(runId);
      return rs.every((r) => !["pending", "running"].includes(r.status)) ? rs : null;
    },
    timeoutMs,
    "results settled",
    100,
  );

describe("估算", () => {
  it("step / run 两种模式的请求数、token、评委请求与成本", async () => {
    const setId = await seededSet(2);
    await db
      .insertInto("model_prices")
      .values({
        provider: "model-eval",
        model: "eval-1",
        input_per_mtok: "2",
        output_per_mtok: "4",
        cache_read_per_mtok: null,
        cache_write_per_mtok: null,
      })
      .execute();
    const estimate = async (body: Record<string, unknown>) => {
      const res = await admin({
        method: "POST",
        url: `${setsUrl()}/${setId}/runs/estimate`,
        payload: body,
      });
      expect(res.statusCode, res.body).toBe(200);
      return (res.json() as { estimate: EvalEstimate }).estimate;
    };
    const tokens = 2 * (sum(U0) + sum(U1));
    // 价格按 MTok：输入与缓存读写按输入价（缓存价为 null）、输出按输出价
    const cost =
      (2 * (U0.inputTokens + U0.cacheReadTokens + U0.cacheWriteTokens + U1.inputTokens) * 2 +
        2 * (U0.outputTokens + U1.outputTokens) * 4) /
      1_000_000;

    const step = await estimate({ mode: "step", candidate: { model: EVAL_1 }, judge: true });
    expect(step).toMatchObject({
      cases: 2,
      modelRequests: 4,
      judgeRequests: 4,
      estimatedTokens: tokens,
      currency: "USD",
    });
    expect(step.estimatedCost).toBeCloseTo(cost, 12);

    const run = await estimate({ mode: "run", candidate: { model: EVAL_1 }, judge: true });
    expect(run).toMatchObject({
      cases: 2,
      modelRequests: 6,
      judgeRequests: 2,
      estimatedTokens: tokens,
    });

    // 候选模型没有价格：成本为 null；不要评委：0
    const noPrice = await estimate({ mode: "step", candidate: {}, judge: false });
    expect(noPrice).toMatchObject({ modelRequests: 4, judgeRequests: 0, estimatedCost: null });
  });
});

describe("运行", () => {
  it("候选等于基线：结果内容相等，用量计入 tokensUsed，运行 completed", async () => {
    const setId = await createSet();
    const conv = await createConv(alice, orgId, agentId);
    await postMessage(alice, orgId, conv, "echo:forty two");
    await waitForTerminal(db, conv);
    const src = await db
      .selectFrom("runs")
      .select("id")
      .where("conversation_id", "=", conv)
      .executeTakeFirstOrThrow();
    await addCase(setId, conv, src.id);

    const run = await startRun(setId, { mode: "step", candidate: {} });
    expect(run).toMatchObject({
      setId,
      mode: "step",
      judge: false,
      tokenCap: 50_000,
      casesTotal: 1,
      estimate: expect.objectContaining({ modelRequests: 1 }),
    });
    expect(["queued", "running", "completed"]).toContain(run.status);

    const done = await waitFor(
      async () => {
        const r = await getRun(run.id);
        return r.status === "completed" ? r : null;
      },
      20_000,
      "run completed",
      100,
    );
    const results = await allResults(run.id);
    expect(results).toHaveLength(1);
    const r = results[0] as EvalResultView;
    expect(r.status).toBe("done");
    expect(r.drift).toEqual([]);
    const baseline = r.baseline as { content: unknown };
    const candidate = r.candidate as { content: unknown; usage: typeof U0; provider: string };
    expect(candidate.content).toEqual(baseline.content);
    expect(baseline.content).toEqual([{ type: "text", text: "forty two" }]);
    expect(candidate.provider).toBe("model-fake");
    expect(done.tokensUsed).toBe(sum(candidate.usage));
    expect(done.casesDone).toBe(1);
    expect(done.finishedAt).not.toBeNull();
    expect(done.summary).toMatchObject({ done: 1, errors: 0, skipped: 0, drifted: 0, labeled: 0 });

    const list = await admin({ method: "GET", url: `${setsUrl()}/${setId}/runs` });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { runs: EvalRunView[] }).runs.map((x) => x.id)).toEqual([run.id]);
  });

  it("结果分页；可重试错误重试后成功，不可重试的记 error", async () => {
    const setId = await seededSet(2);
    const s = evalModelState();
    // 第一个用例：第 1 次请求 overloaded 两次后成功；之后一次 invalid_request（不可重试）
    s.failures = [
      new ModelError("overloaded", "busy"),
      new ModelError("overloaded", "busy"),
      new ModelError("invalid_request", "bad"),
    ];
    const run = await startRun(setId, { mode: "step", candidate: { model: EVAL_1 } });
    const results = await settled(run.id, 30_000);
    expect(results).toHaveLength(4);
    expect(results.filter((r) => r.status === "done")).toHaveLength(3);
    const failed = results.filter((r) => r.status === "error");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.error).toMatchObject({ code: "model.invalid_request" });
    // 2 次可重试失败 + 1 次不可重试 + 3 次成功
    expect(s.requests).toHaveLength(6);
    const finished = await waitFor(
      async () => {
        const r = await getRun(run.id);
        return r.status === "completed" ? r : null;
      },
      10_000,
      "completed",
      100,
    );
    // 3 次成功各 100；3 次失败的尝试按估算另计（> 0）
    expect(finished.tokensUsed).toBeGreaterThan(300);
    expect(finished.summary).toMatchObject({ done: 3, errors: 1, skipped: 0 });

    const page1 = await admin({ method: "GET", url: `${runsUrl()}/${run.id}/results?limit=3` });
    const p1 = page1.json() as { results: EvalResultView[]; next: string | null };
    expect(p1.results).toHaveLength(3);
    expect(p1.next).not.toBeNull();
    const page2 = await admin({
      method: "GET",
      url: `${runsUrl()}/${run.id}/results?limit=3&after=${p1.next}`,
    });
    const p2 = page2.json() as { results: EvalResultView[]; next: string | null };
    expect(p2.results).toHaveLength(1);
    expect(p2.next).toBeNull();
    expect([...p1.results, ...p2.results].map((r) => r.id)).toEqual(results.map((r) => r.id));
    expect(p2.results[0]).toMatchObject({
      caseId: expect.any(String),
      step: expect.any(Number),
      modelCallSeq: expect.any(Number),
      judge: null,
      diff: null,
      label: null,
      evalConversationId: null,
    });
  }, 40_000);

  it("取消后剩余结果为 skipped；再取消 409", async () => {
    const setId = await seededSet(3);
    evalModelState().delayMs = 400;
    const run = await startRun(setId, { mode: "step", candidate: { model: EVAL_1 } });
    await waitFor(
      async () => (await allResults(run.id)).some((r) => r.status === "running"),
      10_000,
      "a running result",
      25,
    );
    const cancel = await admin({ method: "POST", url: `${runsUrl()}/${run.id}/cancel` });
    expect(cancel.statusCode, cancel.body).toBe(200);
    const cancelled = (cancel.json() as { run: EvalRunView }).run;
    expect(cancelled.status).toBe("cancelled");
    // 第 3 个用例还在等组织配额（结果全是 pending）：取消时立即 skipped，并计入进度
    expect(cancelled.casesDone).toBeGreaterThanOrEqual(1);
    const results = await settled(run.id);
    const skipped = results.filter((r) => r.status === "skipped").length;
    // orgConcurrency = 2：至多两个在途请求做完，其余都 skipped
    expect(skipped).toBeGreaterThanOrEqual(4);
    expect(results.filter((r) => r.status === "done").length).toBeLessThanOrEqual(2);
    const after = await waitFor(
      async () => {
        const r = await getRun(run.id);
        return r.casesDone === 3 ? r : null;
      },
      15_000,
      "cases done",
      100,
    );
    expect(after.status).toBe("cancelled");
    expect(after.finishedAt).not.toBeNull();

    const again = await admin({ method: "POST", url: `${runsUrl()}/${run.id}/cancel` });
    expect(again.statusCode).toBe(409);
    expect(errCode(again)).toBe("eval.run_finished");
    const audits = await db
      .selectFrom("audit_events")
      .select("action")
      .where("action", "like", "eval.run_%")
      .orderBy("id")
      .execute();
    expect(audits.map((a) => a.action)).toEqual(["eval.run_started", "eval.run_cancelled"]);
  });
});

describe("失败计费与熔断", () => {
  it("流出一部分后失败的请求按估算计费，越过上限即 capped", async () => {
    const setId = await seededSet(1);
    const s = evalModelState();
    s.streamThenFail = { text: "y".repeat(400), error: new ModelError("server", "boom") };
    const run = await startRun(setId, {
      mode: "step",
      candidate: { model: EVAL_1 },
      tokenCap: 50,
    });
    const results = await settled(run.id);
    const final = await getRun(run.id);
    expect(final.status).toBe("capped");
    // 输入按估算器（> 0）+ 输出 400 字符 / 4 = 100
    expect(final.tokensUsed).toBeGreaterThan(100);
    // 第一次尝试计费后越限：可重试的错误不再重试，之后的结果也不再发
    expect(s.requests).toHaveLength(1);
    expect(results.map((r) => r.status)).toEqual(["skipped", "skipped"]);
  });

  it("没有流出内容就失败的请求同样计费", async () => {
    const setId = await seededSet(1);
    const s = evalModelState();
    s.failures = [
      new ModelError("invalid_request", "bad"),
      new ModelError("invalid_request", "bad"),
    ];
    const run = await startRun(setId, { mode: "step", candidate: { model: EVAL_1 } });
    await settled(run.id);
    const final = await getRun(run.id);
    expect(final.status).toBe("completed");
    expect(final.summary).toMatchObject({ errors: 2, done: 0 });
    expect(final.tokensUsed).toBeGreaterThan(0);
  });

  it("连续出错达到 evals.maxConsecutiveErrors：运行 failed，其余 skipped", async () => {
    const setId = await seededSet(3);
    const s = evalModelState();
    s.failures = Array.from({ length: 20 }, () => new ModelError("invalid_request", "always 400"));
    const run = await startRun(setId, { mode: "step", candidate: { model: EVAL_1 } });
    const results = await settled(run.id, 30_000);
    const final = await waitFor(
      async () => {
        const r = await getRun(run.id);
        return r.casesDone === 3 ? r : null;
      },
      15_000,
      "cases done",
      100,
    );
    expect(final.status).toBe("failed");
    expect(final.error).toEqual({
      code: "eval.too_many_errors",
      message: expect.stringContaining("consecutive"),
    });
    const errors = results.filter((r) => r.status === "error").length;
    expect(errors).toBeGreaterThanOrEqual(MAX_CONSECUTIVE_ERRORS);
    // 熔断后至多在途的那一个（orgConcurrency = 2）还会做完
    expect(errors).toBeLessThanOrEqual(MAX_CONSECUTIVE_ERRORS + 1);
    expect(results.filter((r) => r.status === "skipped")).toHaveLength(6 - errors);
    expect(s.requests.length).toBe(errors);
    expect(final.summary).toMatchObject({ errors, skipped: 6 - errors, done: 0 });
  }, 40_000);
});

describe("认领号", () => {
  it("结果被别的执行接手后，旧执行既不写 done 也不计费", async () => {
    const setId = await seededSet(1);
    evalModelState().delayMs = 600;
    const run = await startRun(setId, { mode: "step", candidate: { model: EVAL_1 } });
    const first = await waitFor(
      async () => (await allResults(run.id)).find((r) => r.status === "running"),
      10_000,
      "a running result",
      25,
    );
    // 模拟 stalled 后另一个 worker 认领了同一条结果（旧执行仍活着，请求还在途）
    await db
      .updateTable("eval_results")
      .set({ claimed_by: "another-attempt" })
      .where("id", "=", first.id)
      .execute();
    await waitFor(async () => evalModelState().inflight === 0, 5_000, "request done", 25);
    await new Promise((r) => setTimeout(r, 300));
    const row = await db
      .selectFrom("eval_results")
      .select(["status", "claimed_by", "candidate"])
      .where("id", "=", first.id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ status: "running", claimed_by: "another-attempt", candidate: null });
    expect((await getRun(run.id)).tokensUsed).toBe(0);
    // 旧执行在失去认领处停下：同一用例的下一条结果没有被它继续做
    expect(evalModelState().requests).toHaveLength(1);
    const cancel = await admin({ method: "POST", url: `${runsUrl()}/${run.id}/cancel` });
    expect(cancel.statusCode).toBe(200);
  });
});

describe("按用例校验候选参数", () => {
  it("参数不符某个用例所用模型的声明：该用例记错误，其余照常回放", async () => {
    // agent 第 2 版换成 model-eval/eval-1；用例 A 来自第 1 版（model-fake），用例 B 来自第 2 版
    const v1 = await db
      .selectFrom("agent_versions")
      .select(["definition", "created_by"])
      .where("agent_id", "=", agentId)
      .where("version", "=", 1)
      .executeTakeFirstOrThrow();
    await db
      .insertInto("agent_versions")
      .values({
        agent_id: agentId,
        version: 2,
        definition: JSON.stringify({ ...(v1.definition as object), model: EVAL_1 }),
        created_by: v1.created_by,
      })
      .execute();
    await db.updateTable("agents").set({ current_version: 2 }).where("id", "=", agentId).execute();
    const setId = await createSet();
    const convA = await createConv(alice, orgId, agentId);
    await seedTwoStepRun(convA, "run-v1", 1);
    const caseA = await addCase(setId, convA, "run-v1");
    const convB = await createConv(alice, orgId, agentId);
    await seedTwoStepRun(convB, "run-v2", 2);
    const caseB = await addCase(setId, convB, "run-v2");

    const candidate = { modelParams: { "model-eval.level": 2 } };
    const est = await admin({
      method: "POST",
      url: `${setsUrl()}/${setId}/runs/estimate`,
      payload: { mode: "step", candidate },
    });
    expect(est.statusCode, est.body).toBe(200);
    // 只算会发请求的用例 B
    expect((est.json() as { estimate: EvalEstimate }).estimate).toMatchObject({
      cases: 1,
      modelRequests: 2,
    });

    const run = await startRun(setId, { mode: "step", candidate });
    expect(run.casesTotal).toBe(2);
    const results = await settled(run.id);
    const ofA = results.filter((r) => r.caseId === caseA);
    const ofB = results.filter((r) => r.caseId === caseB);
    expect(ofA.map((r) => r.status)).toEqual(["error", "error"]);
    expect(ofA[0]?.error).toMatchObject({
      code: "eval.candidate_invalid",
      details: [expect.objectContaining({ path: "candidate.modelParams.model-eval.level" })],
    });
    expect(ofB.map((r) => r.status)).toEqual(["done", "done"]);
    const sent = evalModelState().requests;
    expect(sent).toHaveLength(2);
    expect(sent.every((r) => r.params["model-eval.level"] === 2)).toBe(true);
    const final = await waitFor(
      async () => {
        const r = await getRun(run.id);
        return r.status === "completed" ? r : null;
      },
      10_000,
      "completed",
      100,
    );
    expect(final.casesDone).toBe(2);

    // 只剩不合法的用例：不建运行，直接 400
    const onlyA = await createSet();
    const convC = await createConv(alice, orgId, agentId);
    await seedTwoStepRun(convC, "run-v1-c", 1);
    await addCase(onlyA, convC, "run-v1-c");
    const bad = await admin({
      method: "POST",
      url: `${setsUrl()}/${onlyA}/runs`,
      payload: { mode: "step", candidate },
    });
    expect(bad.statusCode).toBe(400);
    expect(errCode(bad)).toBe("eval.candidate_invalid");
  });
});

describe("校验与权限", () => {
  it("token 上限、候选、评委、空集合与不存在的运行", async () => {
    const setId = await seededSet(1);
    const post = (body: Record<string, unknown>) =>
      admin({ method: "POST", url: `${setsUrl()}/${setId}/runs`, payload: body });

    for (const tokenCap of [0, MAX_TOKEN_CAP + 1]) {
      const res = await post({ mode: "step", candidate: {}, tokenCap });
      expect(res.statusCode, String(tokenCap)).toBe(400);
      expect(errCode(res)).toBe("eval.token_cap_invalid");
    }
    const badVersion = await post({ mode: "step", candidate: { agentVersion: 99 } });
    expect(badVersion.statusCode).toBe(400);
    expect(errCode(badVersion)).toBe("eval.candidate_invalid");
    const badModel = await post({
      mode: "step",
      candidate: { model: { provider: "model-eval", model: "nope" } },
    });
    expect(badModel.statusCode).toBe(400);
    expect(errCode(badModel)).toBe("eval.candidate_invalid");
    const badParams = await post({
      mode: "step",
      candidate: { model: EVAL_1, modelParams: { "model-eval.level": 5 } },
    });
    expect(badParams.statusCode).toBe(400);
    expect(errCode(badParams)).toBe("eval.candidate_invalid");
    expect(JSON.stringify(badParams.json())).toContain("model-eval.level");

    // 整轮回放的执行器在 T5：先拒绝（估算照常可用）
    const runMode = await post({ mode: "run", candidate: {} });
    expect(runMode.statusCode).toBe(400);
    expect(errCode(runMode)).toBe("validation_failed");

    const judge = await post({ mode: "step", candidate: {}, judge: true });
    expect(judge.statusCode).toBe(409);
    expect(errCode(judge)).toBe("model.unconfigured");

    const empty = await createSet();
    const nothing = await admin({
      method: "POST",
      url: `${setsUrl()}/${empty}/runs`,
      payload: { mode: "step", candidate: {} },
    });
    expect(nothing.statusCode).toBe(409);
    expect(errCode(nothing)).toBe("eval.nothing_to_replay");

    const noSet = await admin({
      method: "POST",
      url: `${setsUrl()}/00000000-0000-4000-8000-000000000000/runs`,
      payload: { mode: "step", candidate: {} },
    });
    expect(noSet.statusCode).toBe(404);
    expect(errCode(noSet)).toBe("eval.set_not_found");

    for (const id of ["not-a-uuid", "00000000-0000-4000-8000-000000000000"]) {
      const res = await admin({ method: "GET", url: `${runsUrl()}/${id}` });
      expect(res.statusCode).toBe(404);
      expect(errCode(res)).toBe("eval.run_not_found");
    }
    // 校验失败的启动不留下运行
    expect(await db.selectFrom("eval_runs").select("id").execute()).toEqual([]);
  });

  it("别的组织的管理员拿本组织的运行 / 集合 id：404", async () => {
    const setId = await seededSet(1);
    const run = await startRun(setId, { mode: "step", candidate: {} });
    const bobId = (
      await new AccountsService(db).createLocal({ login: "bob", password: PW, displayName: "bob" })
    ).id;
    expect(bobId).toBeTruthy();
    const bob = await session(k, "bob");
    const orgB = await createOrg(bob, "Other");
    const runsB = `/api/v1/orgs/${orgB}/eval-runs`;
    const setsB = `/api/v1/orgs/${orgB}/eval-sets`;
    const cases: [string, string, unknown, string][] = [
      ["GET", `${runsB}/${run.id}`, undefined, "eval.run_not_found"],
      ["GET", `${runsB}/${run.id}/results`, undefined, "eval.run_not_found"],
      ["POST", `${runsB}/${run.id}/cancel`, undefined, "eval.run_not_found"],
      ["GET", `${setsB}/${setId}/runs`, undefined, "eval.set_not_found"],
      ["POST", `${setsB}/${setId}/runs`, { mode: "step", candidate: {} }, "eval.set_not_found"],
      [
        "POST",
        `${setsB}/${setId}/runs/estimate`,
        { mode: "step", candidate: {} },
        "eval.set_not_found",
      ],
    ];
    for (const [method, url, payload, code] of cases) {
      const res = await bob({
        method: method as "GET",
        url,
        ...(payload !== undefined && { payload: payload as object }),
      });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
      expect(errCode(res), `${method} ${url}`).toBe(code);
    }
    // 运行未被别的组织取消
    expect((await getRun(run.id)).status).not.toBe("cancelled");
  });

  it("member 403，未登录 401", async () => {
    const setId = await seededSet(1);
    const run = await startRun(setId, { mode: "step", candidate: {} });
    const routes: [string, string, unknown][] = [
      ["POST", `${setsUrl()}/${setId}/runs/estimate`, { mode: "step", candidate: {} }],
      ["POST", `${setsUrl()}/${setId}/runs`, { mode: "step", candidate: {} }],
      ["GET", `${setsUrl()}/${setId}/runs`, undefined],
      ["GET", `${runsUrl()}/${run.id}`, undefined],
      ["GET", `${runsUrl()}/${run.id}/results`, undefined],
      ["POST", `${runsUrl()}/${run.id}/cancel`, undefined],
    ];
    for (const [method, url, payload] of routes) {
      const res = await alice({
        method: method as "GET",
        url,
        ...(payload !== undefined && { payload: payload as object }),
      });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      const anon = await k.http.inject({
        method: method as "GET",
        url,
        ...(payload !== undefined && { payload: payload as object }),
      });
      expect(anon.statusCode, `${method} ${url}`).toBe(401);
    }
  });
});
