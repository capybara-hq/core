import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import type { EvalResultView, EvalRunView } from "../../src/evals/runs.service.js";
import type { EvalSetView } from "../../src/evals/sets.service.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
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
  type TestKernel,
  waitFor,
  waitForTerminal,
} from "../helpers/runs.js";

/** 人工标注（T6 / D3）：查看器里标通过 / 不通过，`humanPassRate` 随之更新。 */

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  k = await startKernel(runConfig({ pg: pgc.url, redis: rd.url }));
}, 120_000);
afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

let owner: Req;
let admin: Req;
let alice: Req;
let adminId: string;
let orgId: string;
let agentId: string;

beforeEach(async () => {
  await truncateTables(
    raw,
    "capybara.eval_results, capybara.eval_runs, capybara.eval_cases, capybara.eval_sets, capybara.conversation_events, capybara.runs, capybara.conversations, capybara.agent_versions, capybara.agent_members, capybara.agents, capybara.audit_events, capybara.memberships, capybara.orgs, capybara.deployment_settings, capybara.sessions, capybara.local_passwords, capybara.identities, capybara.accounts",
  );
  const accounts = accountsFor(db);
  const mk = async (login: string) =>
    (await accounts.createLocal({ login, password: PW, displayName: login })).id;
  const ownerId = await mk("owner");
  adminId = await mk("admin");
  const aliceId = await mk("alice");
  owner = await session(k, "owner");
  orgId = await createOrg(owner);
  await testMembers(db).add(orgId, adminId, "admin", ownerId);
  await testMembers(db).add(orgId, aliceId, "member", ownerId);
  admin = await session(k, "admin");
  alice = await session(k, "alice");
  agentId = await createAgent(alice, orgId);
});

const errCode = (res: { json(): unknown }) =>
  (res.json() as { error?: { code?: string } }).error?.code;

const setsUrl = () => `/api/v1/orgs/${orgId}/eval-sets`;
const runsUrl = () => `/api/v1/orgs/${orgId}/eval-runs`;
const labelUrl = (resultId: string, org = orgId) =>
  `/api/v1/orgs/${org}/eval-results/${resultId}/label`;

/** n 个用例（真实运行）的评测集，跑一次单步回放直到结束。 */
async function finishedRun(n: number): Promise<{ runId: string; results: EvalResultView[] }> {
  const res = await admin({ method: "POST", url: setsUrl(), payload: { agentId, name: "L" } });
  expect(res.statusCode, res.body).toBe(201);
  const setId = (res.json() as { set: EvalSetView }).set.id;
  for (let i = 0; i < n; i++) {
    const conv = await createConv(alice, orgId, agentId);
    await postMessage(alice, orgId, conv, `echo:case ${i}`);
    await waitForTerminal(db, conv);
    const src = await db
      .selectFrom("runs")
      .select("id")
      .where("conversation_id", "=", conv)
      .executeTakeFirstOrThrow();
    const c = await admin({
      method: "POST",
      url: `${setsUrl()}/${setId}/cases`,
      payload: { conversationId: conv, runId: src.id },
    });
    expect(c.statusCode, c.body).toBe(201);
  }
  const start = await admin({
    method: "POST",
    url: `${setsUrl()}/${setId}/runs`,
    payload: { mode: "step", candidate: {} },
  });
  expect(start.statusCode, start.body).toBe(201);
  const runId = (start.json() as { run: EvalRunView }).run.id;
  await waitFor(
    async () => (await getRun(runId)).status === "completed",
    20_000,
    "eval run completed",
    100,
  );
  const r = await admin({ method: "GET", url: `${runsUrl()}/${runId}/results?limit=200` });
  return { runId, results: (r.json() as { results: EvalResultView[] }).results };
}

async function getRun(runId: string): Promise<EvalRunView> {
  const res = await admin({ method: "GET", url: `${runsUrl()}/${runId}` });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { run: EvalRunView }).run;
}

async function label(resultId: string, body: unknown): Promise<EvalResultView> {
  const res = await admin({ method: "PUT", url: labelUrl(resultId), payload: body as object });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { result: EvalResultView }).result;
}

describe("人工标注", () => {
  it("标注写进结果；humanPassRate = 通过 / 已标注；清除后不计", async () => {
    const { runId, results } = await finishedRun(2);
    expect(results).toHaveLength(2);
    const [a, b] = results as [EvalResultView, EvalResultView];
    expect((await getRun(runId)).summary).toMatchObject({ labeled: 0, humanPassRate: null });

    const la = await label(a.id, { label: "pass", note: "Looks right." });
    expect(la).toMatchObject({
      id: a.id,
      label: "pass",
      labelNote: "Looks right.",
      labeledBy: adminId,
    });
    expect(la.labeledAt).not.toBeNull();
    expect((await getRun(runId)).summary).toMatchObject({ labeled: 1, humanPassRate: 1 });

    await label(b.id, { label: "fail" });
    expect((await getRun(runId)).summary).toMatchObject({ labeled: 2, humanPassRate: 0.5 });

    // 改标注
    await label(a.id, { label: "fail" });
    expect((await getRun(runId)).summary).toMatchObject({ labeled: 2, humanPassRate: 0 });

    // 清除：标注、备注、标注人一并清空
    const cleared = await label(b.id, { label: null });
    expect(cleared).toMatchObject({
      label: null,
      labelNote: null,
      labeledBy: null,
      labeledAt: null,
    });
    expect((await getRun(runId)).summary).toMatchObject({ labeled: 1, humanPassRate: 0 });

    const page = await admin({ method: "GET", url: `${runsUrl()}/${runId}/results` });
    const got = (page.json() as { results: EvalResultView[] }).results.find((r) => r.id === a.id);
    expect(got).toMatchObject({ label: "fail", labelNote: null });

    const audits = await db
      .selectFrom("audit_events")
      .select(["action", "actor_account_id", "org_id", "target", "detail"])
      .where("action", "=", "eval.result_labeled")
      .orderBy("id")
      .execute();
    expect(audits).toHaveLength(4);
    expect(audits[0]).toMatchObject({
      actor_account_id: adminId,
      org_id: orgId,
      target: a.id,
      detail: { runId, label: "pass", previousLabel: null },
    });
    expect(audits[2]?.detail).toEqual({ runId, label: "fail", previousLabel: "pass" });
    expect(audits[3]?.detail).toEqual({ runId, label: null, previousLabel: "fail" });
  });

  it("member 403；未登录 401", async () => {
    const { results } = await finishedRun(1);
    const id = (results[0] as EvalResultView).id;
    const m = await alice({ method: "PUT", url: labelUrl(id), payload: { label: "pass" } });
    expect(m.statusCode).toBe(403);
    const anon = await k.http.inject({
      method: "PUT",
      url: labelUrl(id),
      payload: { label: "pass" },
    });
    expect(anon.statusCode).toBe(401);
    const row = await db
      .selectFrom("eval_results")
      .select("label")
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    expect(row.label).toBeNull();
  });

  it("不存在 / 非 uuid / 别的组织的结果 → eval.result_not_found 404；备注超长或标签不合法 → 400", async () => {
    const { results } = await finishedRun(1);
    const id = (results[0] as EvalResultView).id;
    for (const rid of ["00000000-0000-4000-8000-000000000000", "not-a-uuid"]) {
      const res = await admin({ method: "PUT", url: labelUrl(rid), payload: { label: "pass" } });
      expect(res.statusCode).toBe(404);
      expect(errCode(res)).toBe("eval.result_not_found");
    }
    const other = await createOrg(owner, "Other");
    const cross = await owner({
      method: "PUT",
      url: labelUrl(id, other),
      payload: { label: "pass" },
    });
    expect(cross.statusCode).toBe(404);
    expect(errCode(cross)).toBe("eval.result_not_found");

    const long = await admin({
      method: "PUT",
      url: labelUrl(id),
      payload: { label: "pass", note: "x".repeat(2001) },
    });
    expect(long.statusCode).toBe(400);
    const ok = await admin({
      method: "PUT",
      url: labelUrl(id),
      payload: { label: "pass", note: "x".repeat(2000) },
    });
    expect(ok.statusCode, ok.body).toBe(200);
    const bad = await admin({ method: "PUT", url: labelUrl(id), payload: { label: "maybe" } });
    expect(bad.statusCode).toBe(400);
    const missing = await admin({ method: "PUT", url: labelUrl(id), payload: {} });
    expect(missing.statusCode).toBe(400);
  });

  it("评测集删除后结果不可标注", async () => {
    const { runId, results } = await finishedRun(1);
    const setId = (await getRun(runId)).setId;
    const del = await admin({ method: "DELETE", url: `${setsUrl()}/${setId}` });
    expect(del.statusCode).toBe(204);
    const res = await admin({
      method: "PUT",
      url: labelUrl((results[0] as EvalResultView).id),
      payload: { label: "pass" },
    });
    expect(res.statusCode).toBe(404);
  });
});
