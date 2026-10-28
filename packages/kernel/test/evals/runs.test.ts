import { fileURLToPath } from "node:url";
import { ModelError } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EventLog } from "../../src/conversations/event-log.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { runActive } from "../../src/evals/budget.js";
import type { EvalEstimate, EvalResultView, EvalRunView } from "../../src/evals/runs.service.js";
import type { EvalSetView } from "../../src/evals/sets.service.js";
import { ExtensionUnloadedError } from "../../src/extensions/inflight.js";
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
let db: KernelSchemaDb;
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
        extensions: [MODEL_FAKE, MODEL_EVAL],
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

    const step = await estimate({ mode: "step", candidate: { model: EVAL_1 }, judge: false });
    expect(step).toMatchObject({
      cases: 2,
      modelRequests: 4,
      judgeRequests: 0,
      estimatedTokens: tokens,
      judgeTokens: 0,
      judgeCost: 0,
      currency: "USD",
    });
    expect(step.estimatedCost).toBeCloseTo(cost, 12);

    // 开评委：评委的估算单列，也计入总数；没有映射评委用途时评委成本未知 → 总成本 null
    const judged = await estimate({ mode: "step", candidate: { model: EVAL_1 }, judge: true });
    expect(judged).toMatchObject({ modelRequests: 4, judgeRequests: 4, judgeCost: null });
    expect(judged.judgeTokens).toBeGreaterThan(4 * 1024);
    expect(judged.estimatedTokens).toBe(tokens + judged.judgeTokens);
    expect(judged.estimatedCost).toBeNull();

    const run = await estimate({ mode: "run", candidate: { model: EVAL_1 }, judge: true });
    expect(run).toMatchObject({ cases: 2, modelRequests: 6, judgeRequests: 2 });
    expect(run.judgeTokens).toBeGreaterThan(2 * 1024);
    expect(run.estimatedTokens).toBe(tokens + run.judgeTokens);

    // 候选模型没有价格：成本为 null；不要评委：0
    const noPrice = await estimate({ mode: "step", candidate: {}, judge: false });
    expect(noPrice).toMatchObject({ modelRequests: 4, judgeRequests: 0, estimatedCost: null });

    // token 上限（D5）：响应给出部署默认、部署上限与本次生效的上限
    const caps = async (body: Record<string, unknown>) =>
      admin({ method: "POST", url: `${setsUrl()}/${setId}/runs/estimate`, payload: body });
    const dflt = await caps({ mode: "step", candidate: {} });
    expect(dflt.statusCode, dflt.body).toBe(200);
    expect(dflt.json()).toMatchObject({
      defaultTokenCap: 50_000,
      maxTokenCap: MAX_TOKEN_CAP,
      effectiveTokenCap: 50_000,
    });
    const given = await caps({ mode: "step", candidate: {}, tokenCap: 1234 });
    expect(given.json()).toMatchObject({ effectiveTokenCap: 1234, maxTokenCap: MAX_TOKEN_CAP });
    for (const tokenCap of [0, MAX_TOKEN_CAP + 1]) {
      const bad = await caps({ mode: "step", candidate: {}, tokenCap });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().error.code).toBe("eval.token_cap_invalid");
    }
  });

  it("估算只读用例上存好的计划列，不读快照（含按用例校验参数时）", async () => {
    const setId = await seededSet(2);
    const body = (over: Record<string, unknown> = {}) => ({
      method: "POST" as const,
      url: `${setsUrl()}/${setId}/runs/estimate`,
      payload: { mode: "step", candidate: {}, ...over },
    });
    const before = await admin(body());
    expect(before.statusCode, before.body).toBe(200);
    // 快照被换成无法解析的内容：估算若读快照就会出错
    await db
      .updateTable("eval_cases")
      .set({ snapshot: JSON.stringify({ version: 1 }) })
      .where("set_id", "=", setId)
      .execute();
    for (const mode of ["step", "run"]) {
      const res = await admin(body({ mode }));
      expect(res.statusCode, res.body).toBe(200);
    }
    const after = (await admin(body())).json() as { estimate: EvalEstimate };
    expect(after.estimate).toEqual((before.json() as { estimate: EvalEstimate }).estimate);
    // 给了参数：按每个用例所用模型（存好的原模型）校验，同样不读快照
    const params = await admin(
      body({ candidate: { model: EVAL_1, modelParams: { "model-eval.level": 2 } } }),
    );
    expect(params.statusCode, params.body).toBe(200);
    expect((params.json() as { estimate: EvalEstimate }).estimate.modelRequests).toBe(4);
  });
});

describe("结果的轻量列表与查看审计", () => {
  it("view=light 不含内容块；updatedSince 只给之后有变化的；单条读完整行；审计每人每运行每小时一条", async () => {
    const setId = await seededSet(1);
    const run = await startRun(setId, { mode: "step", candidate: { model: EVAL_1 } });
    await settled(run.id);
    const url = `${runsUrl()}/${run.id}/results`;
    const light = await admin({ method: "GET", url: `${url}?view=light&limit=200` });
    expect(light.statusCode, light.body).toBe(200);
    const page = light.json() as {
      results: Record<string, unknown>[];
      next: string | null;
      asOf: string;
    };
    expect(page.results).toHaveLength(2);
    for (const r of page.results) {
      expect(Object.keys(r).sort()).toEqual(
        [
          "caseId",
          "driftCount",
          "errorCode",
          "id",
          "judgeStatus",
          "label",
          "modelCallSeq",
          "status",
          "step",
          "textSimilarity",
          "toolCallsMatch",
          "updatedAt",
          "verdict",
        ].sort(),
      );
      expect(r).toMatchObject({ status: "done", judgeStatus: "none", verdict: null, label: null });
    }
    expect(typeof page.asOf).toBe("string");

    // updatedSince：只给之后有变化的（标注一条）
    const later = new Date(Date.now() + 60_000).toISOString();
    const none = await admin({
      method: "GET",
      url: `${url}?view=light&updatedSince=${encodeURIComponent(later)}`,
    });
    expect((none.json() as { results: unknown[] }).results).toEqual([]);
    const target = page.results[0]?.id as string;
    const since = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 20));
    const lab = await admin({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/eval-results/${target}/label`,
      payload: { label: "pass" },
    });
    expect(lab.statusCode, lab.body).toBe(200);
    const changed = await admin({
      method: "GET",
      url: `${url}?view=light&updatedSince=${encodeURIComponent(since)}`,
    });
    expect(changed.statusCode, changed.body).toBe(200);
    const rows = (changed.json() as { results: { id: string; label: string }[] }).results;
    expect(rows.map((r) => [r.id, r.label])).toEqual([[target, "pass"]]);
    expect((await admin({ method: "GET", url: `${url}?updatedSince=not-a-date` })).statusCode).toBe(
      400,
    );

    // 单条：完整行
    const one = await admin({ method: "GET", url: `${url}/${target}` });
    expect(one.statusCode, one.body).toBe(200);
    expect((one.json() as { result: EvalResultView }).result).toMatchObject({
      id: target,
      label: "pass",
      baseline: expect.anything(),
    });
    const missing = await admin({ method: "GET", url: `${url}/${crypto.randomUUID()}` });
    expect(missing.statusCode).toBe(404);
    expect(errCode(missing)).toBe("eval.result_not_found");

    // 审计：上面多次读取（轻量、完整、单条）只记一条；另一位管理员另记一条
    const viewed = async () =>
      db
        .selectFrom("audit_events")
        .select(["actor_account_id", "target"])
        .where("action", "=", "eval.results_viewed")
        .execute();
    expect(await viewed()).toEqual([{ actor_account_id: adminId, target: run.id }]);
    await allResults(run.id);
    expect(await owner({ method: "GET", url: `${url}?view=light` })).toMatchObject({
      statusCode: 200,
    });
    expect((await viewed()).length).toBe(2);
  });
});

describe("组织或 agent 删除后运行停下", () => {
  const slowRun = async () => {
    const setId = await seededSet(2);
    evalModelState().delayMs = 800;
    const run = await startRun(setId, { mode: "step", candidate: { model: EVAL_1 } });
    await waitFor(
      async () => (await allResults(run.id)).some((r) => r.status === "running"),
      10_000,
      "a running result",
      25,
    );
    return run;
  };
  const runRow = (id: string) =>
    db
      .selectFrom("eval_runs")
      .select(["status", "finished_at"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
  const unfinished = async (id: string) =>
    (
      await db
        .selectFrom("eval_results")
        .select("status")
        .where("run_id", "=", id)
        .where("status", "=", "pending")
        .execute()
    ).length;
  const cancelAudits = () =>
    db
      .selectFrom("audit_events")
      .select(["target", "detail"])
      .where("action", "=", "eval.run_cancelled")
      .execute();

  it("删除 agent：运行取消（审计带原因），未开始的结果 skipped，不再发新请求", async () => {
    const run = await slowRun();
    const del = await alice({ method: "DELETE", url: `/api/v1/orgs/${orgId}/agents/${agentId}` });
    expect(del.statusCode, del.body).toBe(204);
    expect((await runRow(run.id)).status).toBe("cancelled");
    expect(await unfinished(run.id)).toBe(0);
    expect(await cancelAudits()).toEqual([
      { target: run.id, detail: expect.objectContaining({ reason: "agent_deleted" }) },
    ]);
    await waitFor(async () => evalModelState().inflight === 0, 5_000, "in flight done", 25);
    await new Promise((r) => setTimeout(r, 300));
    // 至多在途的两个请求（orgConcurrency = 2）做完
    expect(evalModelState().requests.length).toBeLessThanOrEqual(2);
    // agent 删除后：集合还在，但不能再估算 / 启动（否则建出全部跳过的运行）
    const body = { mode: "step", candidate: { model: EVAL_1 } };
    const est = await admin({
      method: "POST",
      url: `${setsUrl()}/${run.setId}/runs/estimate`,
      payload: body,
    });
    expect(est.statusCode).toBe(404);
    expect(errCode(est)).toBe("agent.not_found");
    const again = await admin({
      method: "POST",
      url: `${setsUrl()}/${run.setId}/runs`,
      payload: body,
    });
    expect(again.statusCode).toBe(404);
    expect(errCode(again)).toBe("agent.not_found");
  });

  it("删除组织：运行取消（审计带原因）", async () => {
    const run = await slowRun();
    const del = await owner({ method: "DELETE", url: `/api/v1/orgs/${orgId}` });
    expect(del.statusCode, del.body).toBe(204);
    expect((await runRow(run.id)).status).toBe("cancelled");
    expect(await unfinished(run.id)).toBe(0);
    expect(await cancelAudits()).toEqual([
      { target: run.id, detail: expect.objectContaining({ reason: "org_deleted" }) },
    ]);
    await waitFor(async () => evalModelState().inflight === 0, 5_000, "in flight done", 25);
    await new Promise((r) => setTimeout(r, 300));
    expect(evalModelState().requests.length).toBeLessThanOrEqual(2);
  });

  it("runActive：运行行仍是 running，但组织或 agent 已删除 → false", async () => {
    const run = await slowRun();
    expect(await runActive(db, run.id)).toBe(true);
    await db
      .updateTable("agents")
      .set({ deleted_at: new Date() })
      .where("id", "=", agentId)
      .execute();
    expect(await runActive(db, run.id)).toBe(false);
    await db.updateTable("agents").set({ deleted_at: null }).where("id", "=", agentId).execute();
    expect(await runActive(db, run.id)).toBe(true);
    await db.updateTable("orgs").set({ deleted_at: new Date() }).where("id", "=", orgId).execute();
    expect(await runActive(db, run.id)).toBe(false);
    await db.updateTable("orgs").set({ deleted_at: null }).where("id", "=", orgId).execute();
    const cancel = await admin({ method: "POST", url: `${runsUrl()}/${run.id}/cancel` });
    expect(cancel.statusCode).toBe(200);
    await waitFor(async () => evalModelState().inflight === 0, 5_000, "in flight done", 25);
  });

  it("重试前失去认领：旧执行不再发请求", async () => {
    const setId = await seededSet(1);
    const s = evalModelState();
    // 第一次请求可重试地失败（重试前等 1 秒）
    s.failures = [new ModelError("overloaded", "busy")];
    const run = await startRun(setId, { mode: "step", candidate: { model: EVAL_1 } });
    const first = await waitFor(
      async () =>
        s.requests.length === 1
          ? (await allResults(run.id)).find((r) => r.status === "running")
          : null,
      10_000,
      "first attempt",
      10,
    );
    await db
      .updateTable("eval_results")
      .set({ claimed_by: "another-attempt" })
      .where("id", "=", (first as EvalResultView).id)
      .execute();
    await new Promise((r) => setTimeout(r, 2000));
    expect(s.requests).toHaveLength(1);
    const cancel = await admin({ method: "POST", url: `${runsUrl()}/${run.id}/cancel` });
    expect(cancel.statusCode).toBe(200);
  }, 20_000);
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
      label: null,
      evalConversationId: null,
    });
    // 结构差异（T6）只在 done 的结果上有
    for (const r of [...p1.results, ...p2.results]) {
      if (r.status === "done")
        expect(r.diff).toMatchObject({ toolCallsMatch: expect.any(Boolean) });
      else expect(r.diff).toBeNull();
    }
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

  it("单步回放途中供应商插件被撤销：重试（实时取新实例），不记错误、不动熔断计数", async () => {
    const setId = await seededSet(1);
    const s = evalModelState();
    s.failures = [
      new ExtensionUnloadedError("model-eval"),
      new ExtensionUnloadedError("model-eval"),
    ];
    const run = await startRun(setId, { mode: "step", candidate: { model: EVAL_1 } });
    const results = await settled(run.id, 30_000);
    expect(results.map((r) => r.status)).toEqual(["done", "done"]);
    expect(s.requests).toHaveLength(4);
    const row = await db
      .selectFrom("eval_runs")
      .select(["status", "consecutive_errors"])
      .where("id", "=", run.id)
      .executeTakeFirstOrThrow();
    expect(row.consecutive_errors).toBe(0);
    const final = await waitFor(
      async () => {
        const r = await getRun(run.id);
        return r.status === "completed" ? r : null;
      },
      10_000,
      "completed",
      100,
    );
    expect(final.summary).toMatchObject({ done: 2, errors: 0 });
  }, 40_000);

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
  it("结果被别的执行接手后，旧执行不写 done，但用量照样计入", async () => {
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
    // The request was sent and paid for, so its usage is counted; wait for that write rather than
    // a fixed delay (under CI load the old 300 ms was not always enough).
    await waitFor(
      async () => (await getRun(run.id)).tokensUsed === 100,
      10_000,
      "usage counted",
      25,
    );
    const row = await db
      .selectFrom("eval_results")
      .select(["status", "claimed_by", "candidate"])
      .where("id", "=", first.id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ status: "running", claimed_by: "another-attempt", candidate: null });
    // 请求确实发出且已付费：用量照样计入（model-eval 每次 100）
    expect((await getRun(run.id)).tokensUsed).toBe(100);
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
