import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { usageTokens } from "../../src/evals/budget.js";
import type { EvalRunView } from "../../src/evals/runs.service.js";
import type { EvalSetView } from "../../src/evals/sets.service.js";
import { AccountsService } from "../../src/identity/accounts.js";
import type { Kernel } from "../../src/kernel.js";
import { evalModelState, resetEvalModel } from "../fixtures/plugins/model-eval/index.js";
import { testMembers } from "../helpers/members.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createAgent,
  createConv,
  createOrg,
  PW,
  postMessage,
  runConfig,
  session,
  startKernel,
  waitFor,
  waitForTerminal,
} from "../helpers/runs.js";

/**
 * 停机时在途的评委请求（T6 补测）：worker 停机中止评委请求，已发出的请求按估算计入 token 预算
 * （与失败的回放尝试一致）。单独一个文件：测试最后要停掉内核。
 */

const MODEL_EVAL = fileURLToPath(
  new URL("../fixtures/plugins/model-eval/index.ts", import.meta.url),
);

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelDb;
let k: Kernel | undefined;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  k = await startKernel(
    runConfig({ pg: pgc.url, redis: rd.url }, { extensions: [MODEL_FAKE, MODEL_EVAL] }),
  );
}, 120_000);
afterAll(async () => {
  await k?.stop();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

it("停机中止在途的评委请求：按估算计费", async () => {
  resetEvalModel();
  const kernel = k as Kernel;
  const accounts = new AccountsService(db);
  await accounts.createLocal({
    login: "ent",
    password: PW,
    displayName: "E",
    enterpriseAdmin: true,
  });
  const ownerId = (await accounts.createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  const adminId = (await accounts.createLocal({ login: "admin", password: PW, displayName: "A" }))
    .id;
  const ent = await session(kernel, "ent");
  const owner = await session(kernel, "owner");
  const orgId = await createOrg(owner);
  await testMembers(db).add(orgId, adminId, "admin", ownerId);
  const admin = await session(kernel, "admin");
  const agentId = await createAgent(owner, orgId);
  const m = await ent({
    method: "PUT",
    url: "/api/v1/admin/model-purposes/eval",
    payload: { target: { model: { provider: "model-eval", model: "eval-j" } } },
  });
  expect(m.statusCode, m.body).toBe(200);

  const set = await admin({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/eval-sets`,
    payload: { agentId, name: "Abort" },
  });
  const setId = (set.json() as { set: EvalSetView }).set.id;
  const conv = await createConv(owner, orgId, agentId);
  await postMessage(owner, orgId, conv, "echo:abort the judge");
  await waitForTerminal(db, conv);
  const src = await db
    .selectFrom("runs")
    .select("id")
    .where("conversation_id", "=", conv)
    .executeTakeFirstOrThrow();
  const c = await admin({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/eval-sets/${setId}/cases`,
    payload: { conversationId: conv, runId: src.id },
  });
  expect(c.statusCode, c.body).toBe(201);

  // 评委请求一直挂着，直到停机中止
  evalModelState().delayMs = 60_000;
  const res = await admin({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/eval-sets/${setId}/runs`,
    payload: { mode: "step", candidate: {}, judge: true },
  });
  expect(res.statusCode, res.body).toBe(201);
  const runId = (res.json() as { run: EvalRunView }).run.id;
  await waitFor(async () => evalModelState().inflight === 1, 20_000, "judge in flight", 25);
  const row = await db
    .selectFrom("eval_results")
    .select(["candidate", "judge_status"])
    .where("run_id", "=", runId)
    .executeTakeFirstOrThrow();
  expect(row.judge_status).toBe("pending");
  const candidateTokens = usageTokens(
    (row.candidate as { usage: Parameters<typeof usageTokens>[0] }).usage,
  );
  const before = await db
    .selectFrom("eval_runs")
    .select("tokens_used")
    .where("id", "=", runId)
    .executeTakeFirstOrThrow();
  expect(Number(before.tokens_used)).toBe(candidateTokens);

  await kernel.stop();
  k = undefined;
  const after = await db
    .selectFrom("eval_runs")
    .select("tokens_used")
    .where("id", "=", runId)
    .executeTakeFirstOrThrow();
  // 评委请求的输入估算（系统提示词、评分标准、两边回复）> 0；没有流出内容
  expect(Number(after.tokens_used)).toBeGreaterThan(candidateTokens);
  const judgeRow = await db
    .selectFrom("eval_results")
    .select("judge_status")
    .where("run_id", "=", runId)
    .executeTakeFirstOrThrow();
  // 任务回到队列（由别的 worker 补评委）：评委仍是 pending
  expect(judgeRow.judge_status).toBe("pending");
}, 60_000);
