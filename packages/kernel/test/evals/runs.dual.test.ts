import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { EventLog } from "../../src/conversations/event-log.js";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import type { EvalResultView, EvalRunView } from "../../src/evals/runs.service.js";
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
  runConfig,
  session,
  startKernel,
  waitFor,
} from "../helpers/runs.js";

/**
 * 审查重点 4（C7）双副本：两个内核实例（各自的 HTTP 与评测 worker，共用 PG / Redis）。
 * 每次请求 100 token、上限 250、每个用例 2 步：
 * - `orgConcurrency = 1`、3 个用例：假模型看到的最大并发为 1，总请求数 ≤ 3 + 在途数（1）；
 * - `orgConcurrency = 2`、每副本 `workerConcurrency = 1`、4 个用例：两个副本同时在跑（最大并发 2），
 *   超出量 ≤ 在途数 × 一次请求（请求数 ≤ 3 + 2）。
 * 两种情况运行都为 `capped`，其余结果为 `skipped`。假模型按部署配置 `replica` 记下每个请求来自哪个实例。
 */

const MODEL_EVAL = fileURLToPath(
  new URL("../fixtures/plugins/model-eval/index.ts", import.meta.url),
);

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelDb;
let kernels: Kernel[] = [];

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  await migrate(pgc.url, {
    schema: "capybara",
    dir: fileURLToPath(new URL("../../src/migrations", import.meta.url)),
  });
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
}, 120_000);

afterEach(async () => {
  for (const k of kernels) await k.stop();
  kernels = [];
});

afterAll(async () => {
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

async function bootPair(orgConcurrency: number, workerConcurrency: number): Promise<Kernel[]> {
  await truncateTables(
    raw,
    "capybara.eval_results, capybara.eval_runs, capybara.eval_cases, capybara.eval_sets, capybara.conversation_events, capybara.runs, capybara.conversations, capybara.agent_versions, capybara.agent_members, capybara.agents, capybara.audit_events, capybara.memberships, capybara.orgs, capybara.sessions, capybara.local_passwords, capybara.identities, capybara.accounts",
  );
  for (const replica of ["r0", "r1"]) {
    kernels.push(
      await startKernel(
        runConfig(
          { pg: pgc.url, redis: rd.url },
          {
            plugins: [MODEL_FAKE, MODEL_EVAL],
            pluginConfig: { "model-eval": { replica } },
            evals: { orgConcurrency, workerConcurrency },
          },
        ),
      ),
    );
  }
  return kernels;
}

/** 建组织、agent、评测集与 n 个两步用例（直接写日志），在 B 副本上启动运行，等全部结果结束。 */
async function capScenario(
  cases: number,
): Promise<{ run: EvalRunView; results: EvalResultView[] }> {
  const [a, b] = kernels as [Kernel, Kernel];
  const eventLog = new EventLog(db, { publish: async () => {} });
  const accounts = new AccountsService(db);
  const ownerId = (await accounts.createLocal({ login: "owner", password: PW, displayName: "o" }))
    .id;
  const adminId = (await accounts.createLocal({ login: "admin", password: PW, displayName: "a" }))
    .id;
  const owner = await session(a, "owner");
  const orgId = await createOrg(owner);
  await testMembers(db).add(orgId, adminId, "admin", ownerId);
  const adminA = await session(a, "admin");
  const adminB = await session(b, "admin");
  const agentId = await createAgent(owner, orgId);

  const setRes = await adminA({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/eval-sets`,
    payload: { agentId, name: "cap" },
  });
  expect(setRes.statusCode, setRes.body).toBe(201);
  const setId = (setRes.json() as { set: { id: string } }).set.id;

  for (let i = 0; i < cases; i++) {
    const conv = await createConv(owner, orgId, agentId);
    const runId = `src-${i}`;
    const [msg] = await eventLog.append(conv, [
      {
        type: "user_message",
        payload: { content: [{ type: "text", text: `q${i}` }], authorAccountId: ownerId },
      },
    ]);
    const userSeq = msg?.seq ?? 0;
    await db
      .insertInto("runs")
      .values({
        id: runId,
        conversation_id: conv,
        status: "completed",
        agent_version: 1,
        trigger_account_id: ownerId,
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
    const usage = { inputTokens: 100, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const step = (n: number, last: boolean) => [
      {
        type: "model_call" as const,
        runId,
        payload: {
          step: n,
          attempt: 0,
          provider: "model-fake",
          model: "fake-1",
          fallback: false,
          request,
        },
      },
      {
        type: "assistant_message" as const,
        runId,
        payload: {
          step: n,
          content: last
            ? [{ type: "text" as const, text: "done" }]
            : [{ type: "tool_call" as const, id: `c${i}`, name: "t", input: {} }],
          stopReason: last ? ("end_turn" as const) : ("tool_use" as const),
        },
      },
      {
        type: "usage" as const,
        runId,
        payload: { step: n, provider: "model-fake", model: "fake-1", ...usage },
      },
    ];
    await eventLog.append(conv, [
      {
        type: "run_started",
        runId,
        payload: {
          agentVersion: 1,
          model: { provider: "model-fake", model: "fake-1" },
          triggerAccountId: ownerId,
        },
      },
      ...step(0, false),
      {
        type: "tool_call_started",
        runId,
        payload: { step: 0, callId: `c${i}`, toolKey: "t", specHash: "s" },
      },
      {
        type: "tool_result",
        runId,
        payload: { step: 0, callId: `c${i}`, toolKey: "t", content: "ok", isError: false },
      },
      ...step(1, true),
      { type: "run_finished", runId, payload: { reason: "completed", consumedUpToSeq: userSeq } },
    ]);
    const add = await adminA({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/eval-sets/${setId}/cases`,
      payload: { conversationId: conv, runId },
    });
    expect(add.statusCode, add.body).toBe(201);
  }

  resetEvalModel();
  const state = evalModelState();
  state.delayMs = 200;
  state.tokens = 100;

  const start = await adminB({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/eval-sets/${setId}/runs`,
    payload: {
      mode: "step",
      candidate: { model: { provider: "model-eval", model: "eval-1" } },
      tokenCap: 250,
    },
  });
  expect(start.statusCode, start.body).toBe(201);
  const started = (start.json() as { run: EvalRunView }).run;
  expect(started).toMatchObject({ casesTotal: cases, tokenCap: 250 });

  const results = await waitFor(
    async () => {
      const res = await adminA({
        method: "GET",
        url: `/api/v1/orgs/${orgId}/eval-runs/${started.id}/results?limit=200`,
      });
      const rs = (res.json() as { results: EvalResultView[] }).results;
      return rs.length === cases * 2 && rs.every((r) => !["pending", "running"].includes(r.status))
        ? rs
        : null;
    },
    60_000,
    "all results settled",
    100,
  );
  const run = await waitFor(
    async () => {
      const res = await adminB({
        method: "GET",
        url: `/api/v1/orgs/${orgId}/eval-runs/${started.id}`,
      });
      const r = (res.json() as { run: EvalRunView }).run;
      return r.casesDone === cases ? r : null;
    },
    15_000,
    "cases done",
    100,
  );
  return { run, results };
}

function expectCapped(
  run: EvalRunView,
  results: EvalResultView[],
  cases: number,
  inFlight: number,
): void {
  const state = evalModelState();
  // 上限 250、每次 100：第 3 次请求后越限；之后只有在途的请求还会做完（每个至多一次）
  expect(state.requests.length).toBeGreaterThanOrEqual(3);
  expect(state.requests.length).toBeLessThanOrEqual(3 + inFlight);
  expect(run.status).toBe("capped");
  expect(run.tokensUsed).toBe(state.requests.length * 100);
  expect(run.tokensUsed - run.tokenCap).toBeLessThanOrEqual(inFlight * 100);
  expect(run.finishedAt).not.toBeNull();
  const done = results.filter((r) => r.status === "done");
  expect(done).toHaveLength(state.requests.length);
  expect(results.filter((r) => r.status === "skipped")).toHaveLength(cases * 2 - done.length);
  expect(results.filter((r) => r.status === "error")).toHaveLength(0);
  expect(run.summary).toMatchObject({
    done: done.length,
    skipped: cases * 2 - done.length,
    errors: 0,
  });
}

describe("token 上限与组织并发（双副本）", () => {
  it("orgConcurrency = 1：最大并发 1，请求数 ≤ 3 + 1；capped，其余 skipped", async () => {
    await bootPair(1, 4);
    const { run, results } = await capScenario(3);
    const state = evalModelState();
    expect(state.maxInflight).toBe(1);
    expect(state.seenBy.every((r) => r === "r0" || r === "r1")).toBe(true);
    expectCapped(run, results, 3, 1);
  }, 120_000);

  it("orgConcurrency = 2：两个副本同时执行，超出 ≤ 在途数 × 一次请求", async () => {
    // 每个副本一次只做一个任务：并发达到 2 就说明两个副本都在执行
    await bootPair(2, 1);
    const { run, results } = await capScenario(4);
    const state = evalModelState();
    expect(state.maxInflight).toBe(2);
    expect(new Set(state.seenBy)).toEqual(new Set(["r0", "r1"]));
    expectCapped(run, results, 4, 2);
  }, 120_000);
});
