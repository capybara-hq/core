import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EventLog } from "../../src/conversations/event-log.js";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import type { EvalCaseView, EvalSetView } from "../../src/evals/sets.service.js";
import type { TrajectoryRun } from "../../src/evals/trajectory.js";
import type { TrajectoryListItem } from "../../src/evals/trajectory.service.js";
import { AccountsService } from "../../src/identity/accounts.js";
import type { Kernel } from "../../src/kernel.js";
import { truncateTables } from "../helpers/db.js";
import { testMembers } from "../helpers/members.js";
import {
  createAgent,
  createConv,
  createOrg,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
} from "../helpers/runs.js";

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelDb;
let k: Kernel;
let eventLog: EventLog;

const MAX_CASES = 4;
const MAX_CASE_BYTES = 20_000;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  eventLog = new EventLog(db, { publish: async () => {} });
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      { roles: ["api"], evals: { maxCasesPerSet: MAX_CASES, maxCaseBytes: MAX_CASE_BYTES } },
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
let ownerId: string;
let adminId: string;
let aliceId: string;
let orgId: string;
let agentA: string;
let agentB: string;

const errCode = (res: { json(): unknown }) =>
  (res.json() as { error?: { code?: string } }).error?.code;

const USAGE = { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 };

interface SeedOpts {
  status?: "completed" | "failed" | "aborted" | "running";
  text?: string;
  toolCalls?: number;
  /** 回复的长度（用来造超大快照）。 */
  replyChars?: number;
  createdAt?: Date;
}

/** 一次运行：一条触发消息、一步（可带工具调用）、终态。 */
async function seedRun(
  convId: string,
  runId: string,
  triggerAccountId: string,
  o: SeedOpts = {},
): Promise<void> {
  const status = o.status ?? "completed";
  const [msg] = await eventLog.append(convId, [
    {
      type: "user_message",
      payload: {
        content: [{ type: "text", text: o.text ?? `question for ${runId}` }],
        authorAccountId: triggerAccountId,
      },
    },
  ]);
  await db
    .insertInto("runs")
    .values({
      id: runId,
      conversation_id: convId,
      status,
      agent_version: 1,
      trigger_account_id: triggerAccountId,
      trigger_seq: msg?.seq ?? 0,
      ...(o.createdAt !== undefined && { created_at: o.createdAt }),
      started_at: new Date(),
      finished_at: status === "running" ? null : new Date(),
    })
    .execute();
  const calls = Array.from({ length: o.toolCalls ?? 0 }, (_, i) => `call-${runId}-${i}`);
  await eventLog.append(convId, [
    {
      type: "run_started",
      runId,
      payload: {
        agentVersion: 1,
        model: { provider: "model-fake", model: "fake-1" },
        triggerAccountId,
      },
    },
    {
      type: "model_call",
      runId,
      payload: {
        step: 0,
        attempt: 0,
        provider: "model-fake",
        model: "fake-1",
        fallback: false,
        request: { fromSeq: 1, toSeq: 1, summarySeq: null, systemHash: "h", reminderSeqs: [] },
      },
    },
    {
      type: "assistant_message",
      runId,
      payload: {
        step: 0,
        content: [
          { type: "text", text: "x".repeat(o.replyChars ?? 5) },
          ...calls.map((id) => ({ type: "tool_call" as const, id, name: "t", input: {} })),
        ],
        stopReason: calls.length > 0 ? "tool_use" : "end_turn",
      },
    },
    {
      type: "usage",
      runId,
      payload: { step: 0, provider: "model-fake", model: "fake-1", ...USAGE },
    },
    ...calls.flatMap((callId) => [
      {
        type: "tool_call_started" as const,
        runId,
        payload: { step: 0, callId, toolKey: "t", specHash: "s" },
      },
      {
        type: "tool_result" as const,
        runId,
        payload: { step: 0, callId, toolKey: "t", content: "ok", isError: false },
      },
    ]),
  ]);
  if (status === "running") return;
  await eventLog.append(convId, [
    status === "completed"
      ? {
          type: "run_finished",
          runId,
          payload: { reason: "completed", consumedUpToSeq: msg?.seq ?? 0 },
        }
      : status === "failed"
        ? {
            type: "run_failed",
            runId,
            payload: { error: { code: "model.unavailable", message: "down" } },
          }
        : { type: "run_aborted", runId, payload: { byAccountId: null, reason: "user" } },
  ]);
}

beforeEach(async () => {
  await truncateTables(
    raw,
    "capybara.eval_results, capybara.eval_runs, capybara.eval_cases, capybara.eval_sets, capybara.conversation_events, capybara.runs, capybara.conversations, capybara.agent_versions, capybara.agent_members, capybara.agents, capybara.audit_events, capybara.memberships, capybara.orgs, capybara.deployment_settings, capybara.sessions, capybara.local_passwords, capybara.identities, capybara.accounts",
  );
  const accounts = new AccountsService(db);
  const mk = async (login: string) =>
    (await accounts.createLocal({ login, password: PW, displayName: login })).id;
  ownerId = await mk("owner");
  adminId = await mk("admin");
  aliceId = await mk("alice");
  owner = await session(k, "owner");
  orgId = await createOrg(owner);
  const members = testMembers(db);
  await members.add(orgId, adminId, "admin", ownerId);
  await members.add(orgId, aliceId, "member", ownerId);
  admin = await session(k, "admin");
  alice = await session(k, "alice");
  agentA = await createAgent(alice, orgId);
  agentB = await createAgent(owner, orgId);
});

const base = () => `/api/v1/orgs/${orgId}/eval-sets`;

async function createSet(req: Req, agentId: string, name = "Smoke"): Promise<EvalSetView> {
  const res = await req({
    method: "POST",
    url: base(),
    payload: { agentId, name, description: "d", rubric: "be right" },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { set: EvalSetView }).set;
}

const addCase = (req: Req, setId: string, conversationId: string, runId: string) =>
  req({
    method: "POST",
    url: `${base()}/${setId}/cases`,
    payload: { conversationId, runId },
  });

const auditActions = async () =>
  (
    await db
      .selectFrom("audit_events")
      .select(["action", "target", "detail", "actor_account_id"])
      .where("action", "like", "eval.%")
      .orderBy("id")
      .execute()
  ).map((r) => r.action);

interface SetDetail extends EvalSetView {
  cases: EvalCaseView[];
}

describe("评测集 CRUD 与加用例", () => {
  it("建集合、加用例；列表与详情；改名；删除", async () => {
    const set = await createSet(admin, agentA);
    expect(set).toMatchObject({
      agentId: agentA,
      name: "Smoke",
      description: "d",
      rubric: "be right",
      caseCount: 0,
    });
    const conv = await createConv(alice, orgId, agentA);
    const longText = `${"问".repeat(100)}tail`;
    await seedRun(conv, "run-1", aliceId, { text: longText, toolCalls: 1 });

    const add = await addCase(admin, set.id, conv, "run-1");
    expect(add.statusCode, add.body).toBe(201);
    const c = (add.json() as { case: EvalCaseView }).case;
    expect(c).toMatchObject({
      sourceConversationId: conv,
      sourceRunId: "run-1",
      agentVersion: 1,
      title: "问".repeat(80),
      replayableSteps: 1,
    });
    expect(typeof c.createdAt).toBe("string");

    const list = await admin({ method: "GET", url: base() });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { sets: EvalSetView[] }).sets).toEqual([
      expect.objectContaining({ id: set.id, caseCount: 1 }),
    ]);
    const detail = await admin({ method: "GET", url: `${base()}/${set.id}` });
    expect(detail.statusCode).toBe(200);
    const d = (detail.json() as { set: SetDetail }).set;
    expect(d.caseCount).toBe(1);
    expect(d.cases).toEqual([c]);

    const patch = await admin({
      method: "PATCH",
      url: `${base()}/${set.id}`,
      payload: { name: "Renamed", rubric: null },
    });
    expect(patch.statusCode, patch.body).toBe(200);
    expect((patch.json() as { set: EvalSetView }).set).toMatchObject({
      name: "Renamed",
      description: "d",
      rubric: null,
      caseCount: 1,
    });

    const audit = await db
      .selectFrom("audit_events")
      .select(["action", "target", "detail", "actor_account_id"])
      .where("action", "=", "eval.case_added")
      .executeTakeFirstOrThrow();
    expect(audit).toMatchObject({ target: set.id, actor_account_id: adminId });
    expect(audit.detail).toMatchObject({ caseId: c.id, conversationId: conv, runId: "run-1" });

    // 删除前起一次运行（只有 api 角色，结果停在 pending）
    const started = await admin({
      method: "POST",
      url: `${base()}/${set.id}/runs`,
      payload: { mode: "step", candidate: {} },
    });
    expect(started.statusCode, started.body).toBe(201);
    const runId = (started.json() as { run: { id: string } }).run.id;

    const del = await owner({ method: "DELETE", url: `${base()}/${set.id}` });
    expect(del.statusCode).toBe(204);
    // Ruling S1-a：用例（含快照）硬删，结果随之级联删除；集合行留作软删除的审计存根，运行行保留
    expect(
      await db.selectFrom("eval_cases").select("id").where("set_id", "=", set.id).execute(),
    ).toEqual([]);
    expect(
      await db.selectFrom("eval_results").select("id").where("run_id", "=", runId).execute(),
    ).toEqual([]);
    const stub = await db
      .selectFrom("eval_sets")
      .select("deleted_at")
      .where("id", "=", set.id)
      .executeTakeFirstOrThrow();
    expect(stub.deleted_at).not.toBeNull();
    const runRow = await db
      .selectFrom("eval_runs")
      .select("status")
      .where("id", "=", runId)
      .executeTakeFirstOrThrow();
    expect(runRow.status).toBe("cancelled");
    const gone = await admin({ method: "GET", url: `${base()}/${set.id}` });
    expect(gone.statusCode).toBe(404);
    expect(errCode(gone)).toBe("eval.set_not_found");
    expect(((await admin({ method: "GET", url: base() })).json() as { sets: [] }).sets).toEqual([]);
    expect(await auditActions()).toEqual([
      "eval.set_created",
      "eval.case_added",
      "eval.set_updated",
      "eval.run_started",
      "eval.set_deleted",
    ]);
    const updated = await db
      .selectFrom("audit_events")
      .select(["target", "detail", "actor_account_id"])
      .where("action", "=", "eval.set_updated")
      .executeTakeFirstOrThrow();
    expect(updated).toMatchObject({ target: set.id, actor_account_id: adminId });
    expect(updated.detail).toEqual({ fields: ["name", "rubric"] });
  });

  it("同一运行重复加 409；别的 agent 的运行 409；未终态 409；超大 413；超过上限 409", async () => {
    const set = await createSet(admin, agentA);
    const conv = await createConv(alice, orgId, agentA);
    for (let i = 0; i < MAX_CASES + 1; i++) await seedRun(conv, `r${i}`, aliceId);
    expect((await addCase(admin, set.id, conv, "r0")).statusCode).toBe(201);

    const dup = await addCase(admin, set.id, conv, "r0");
    expect(dup.statusCode).toBe(409);
    expect(errCode(dup)).toBe("eval.case_exists");

    const other = await createConv(owner, orgId, agentB);
    await seedRun(other, "rb", ownerId);
    const mismatch = await addCase(admin, set.id, other, "rb");
    expect(mismatch.statusCode).toBe(409);
    expect(errCode(mismatch)).toBe("eval.agent_mismatch");

    await seedRun(conv, "r-running", aliceId, { status: "running" });
    const running = await addCase(admin, set.id, conv, "r-running");
    expect(running.statusCode).toBe(409);
    expect(errCode(running)).toBe("eval.run_not_finished");

    const big = await createConv(alice, orgId, agentA);
    await seedRun(big, "r-big", aliceId, { replyChars: MAX_CASE_BYTES + 1 });
    const tooLarge = await addCase(admin, set.id, big, "r-big");
    expect(tooLarge.statusCode).toBe(413);
    expect(errCode(tooLarge)).toBe("eval.case_too_large");

    const missing = await addCase(admin, set.id, conv, "nope");
    expect(missing.statusCode).toBe(404);

    for (let i = 1; i < MAX_CASES; i++) {
      expect((await addCase(admin, set.id, conv, `r${i}`)).statusCode).toBe(201);
    }
    const full = await addCase(admin, set.id, conv, `r${MAX_CASES}`);
    expect(full.statusCode).toBe(409);
    expect(errCode(full)).toBe("eval.too_many_cases");
    const sample = await admin({
      method: "POST",
      url: `${base()}/${set.id}/cases/sample`,
      payload: { count: 1 },
    });
    expect(sample.statusCode).toBe(409);
    expect(errCode(sample)).toBe("eval.too_many_cases");
  });

  it("删除用例；不存在的集合 / 用例 404；非 uuid 也是 404", async () => {
    const set = await createSet(admin, agentA);
    const conv = await createConv(alice, orgId, agentA);
    await seedRun(conv, "r0", aliceId);
    const c = ((await addCase(admin, set.id, conv, "r0")).json() as { case: EvalCaseView }).case;
    const del = await admin({ method: "DELETE", url: `${base()}/${set.id}/cases/${c.id}` });
    expect(del.statusCode).toBe(204);
    const again = await admin({ method: "DELETE", url: `${base()}/${set.id}/cases/${c.id}` });
    expect(again.statusCode).toBe(404);
    expect(errCode(again)).toBe("eval.case_not_found");
    const removed = await db
      .selectFrom("audit_events")
      .select(["target", "detail", "actor_account_id"])
      .where("action", "=", "eval.case_removed")
      .execute();
    // 只有真正删掉的那一次写审计
    expect(removed).toHaveLength(1);
    expect(removed[0]).toMatchObject({ target: set.id, actor_account_id: adminId });
    expect(removed[0]?.detail).toEqual({
      caseId: c.id,
      conversationId: conv,
      runId: "r0",
    });
    // 删掉后可以重新加同一运行
    expect((await addCase(admin, set.id, conv, "r0")).statusCode).toBe(201);

    for (const id of ["not-a-uuid", "00000000-0000-4000-8000-000000000000"]) {
      const res = await admin({ method: "GET", url: `${base()}/${id}` });
      expect(res.statusCode, id).toBe(404);
      expect(errCode(res)).toBe("eval.set_not_found");
    }
    const noCase = await admin({ method: "GET", url: `${base()}/${set.id}/cases/not-a-uuid` });
    expect(noCase.statusCode).toBe(404);
    expect(errCode(noCase)).toBe("eval.case_not_found");
  });

  it("建集合：agent 不存在 404；校验失败 400", async () => {
    const res = await admin({
      method: "POST",
      url: base(),
      payload: { agentId: "nope", name: "x" },
    });
    expect(res.statusCode).toBe(404);
    expect(errCode(res)).toBe("agent.not_found");
    for (const payload of [
      { agentId: agentA },
      { agentId: agentA, name: "" },
      { agentId: agentA, name: "x".repeat(201) },
      { agentId: agentA, name: "x", extra: 1 },
    ]) {
      const bad = await admin({ method: "POST", url: base(), payload });
      expect(bad.statusCode, JSON.stringify(payload)).toBe(400);
      expect(errCode(bad)).toBe("validation_failed");
    }
    const set = await createSet(admin, agentA);
    for (const payload of [{ count: 0 }, { count: 51 }, { count: 1, status: "x" }]) {
      const bad = await admin({
        method: "POST",
        url: `${base()}/${set.id}/cases/sample`,
        payload,
      });
      expect(bad.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });
});

describe("权限", () => {
  it("member 403；未登录 401；guest 403", async () => {
    const set = await createSet(admin, agentA);
    const conv = await createConv(alice, orgId, agentA);
    await seedRun(conv, "r0", aliceId);
    for (const [method, url, payload] of [
      ["GET", base(), undefined],
      ["POST", base(), { agentId: agentA, name: "x" }],
      ["GET", `${base()}/${set.id}`, undefined],
      ["PATCH", `${base()}/${set.id}`, { name: "y" }],
      ["DELETE", `${base()}/${set.id}`, undefined],
      ["POST", `${base()}/${set.id}/cases`, { conversationId: conv, runId: "r0" }],
      ["POST", `${base()}/${set.id}/cases/sample`, { count: 1 }],
    ] as const) {
      // 负责 agentA 的成员也不行：evals.manage 至少 admin
      const res = await alice({ method, url, ...(payload !== undefined && { payload }) });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      const anon = await k.http.inject({ method, url });
      expect(anon.statusCode, `${method} ${url}`).toBe(401);
    }
  });
});

describe("抽样", () => {
  it("只取该 agent 的 chat 对话里已终态、尚不在集合里的运行；status / 时间 / 工具调用数过滤生效；超大计入 skipped", async () => {
    const set = await createSet(admin, agentA);
    const c1 = await createConv(alice, orgId, agentA);
    const old = new Date("2026-01-01T00:00:00Z");
    await seedRun(c1, "done-0", aliceId, { toolCalls: 0 });
    await seedRun(c1, "done-2", aliceId, { toolCalls: 2 });
    await seedRun(c1, "failed-1", aliceId, { status: "failed", toolCalls: 1 });
    await seedRun(c1, "aborted", aliceId, { status: "aborted" });
    await seedRun(c1, "running", aliceId, { status: "running" });
    await seedRun(c1, "old", aliceId, { createdAt: old });
    // 别的 agent、eval 对话里的运行都不取
    const cb = await createConv(owner, orgId, agentB);
    await seedRun(cb, "other-agent", ownerId);
    const ce = await createConv(alice, orgId, agentA);
    await seedRun(ce, "eval-conv", aliceId);
    await db.updateTable("conversations").set({ kind: "eval" }).where("id", "=", ce).execute();

    const sample = async (payload: Record<string, unknown>) => {
      const res = await admin({ method: "POST", url: `${base()}/${set.id}/cases/sample`, payload });
      expect(res.statusCode, res.body).toBe(200);
      return res.json() as { added: number; skipped: number };
    };
    const runIds = async () =>
      (
        await db
          .selectFrom("eval_cases")
          .select("source_run_id")
          .where("set_id", "=", set.id)
          .execute()
      )
        .map((r) => r.source_run_id)
        .sort();

    expect(await sample({ count: 50, status: "failed" })).toEqual({ added: 1, skipped: 0 });
    expect(await runIds()).toEqual(["failed-1"]);
    expect(await sample({ count: 50, minToolCalls: 1 })).toEqual({ added: 1, skipped: 0 });
    expect(await runIds()).toEqual(["done-2", "failed-1"]);
    expect(await sample({ count: 50, status: "any", to: "2026-02-01T00:00:00Z" })).toEqual({
      added: 1,
      skipped: 0,
    });
    expect(await runIds()).toEqual(["done-2", "failed-1", "old"]);
    // 达到上限：只抽剩余的容量（4 - 3 = 1）
    expect(await sample({ count: 50, status: "any", from: "2026-02-01T00:00:00Z" })).toEqual({
      added: 1,
      skipped: 0,
    });
    const ids = await runIds();
    expect(ids).toHaveLength(MAX_CASES);
    expect(["aborted", "done-0"].some((r) => ids.includes(r))).toBe(true);
    for (const r of ["running", "other-agent", "eval-conv"]) expect(ids).not.toContain(r);

    // 抽到超大的运行计入 skipped
    const set2 = await createSet(admin, agentA, "Big");
    const big = await createConv(alice, orgId, agentA);
    await seedRun(big, "big", aliceId, { replyChars: MAX_CASE_BYTES + 1, toolCalls: 3 });
    const res = await admin({
      method: "POST",
      url: `${base()}/${set2.id}/cases/sample`,
      payload: { count: 5, minToolCalls: 3 },
    });
    expect(res.json()).toEqual({ added: 0, skipped: 1 });
  });
});

describe("用例详情与原对话删除", () => {
  it("删除原对话后用例快照仍可读；查看写 trajectory.viewed（带 caseId / setId）", async () => {
    const set = await createSet(admin, agentA);
    const conv = await createConv(alice, orgId, agentA);
    await seedRun(conv, "r0", aliceId, { text: "hello there" });
    const c = ((await addCase(admin, set.id, conv, "r0")).json() as { case: EvalCaseView }).case;

    await db.deleteFrom("conversations").where("id", "=", conv).execute();

    const res = await admin({ method: "GET", url: `${base()}/${set.id}/cases/${c.id}` });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { case: EvalCaseView; trajectory: TrajectoryRun[] };
    expect(body.case).toEqual(c);
    expect(body.case.title).toBe("hello there");
    expect(body.trajectory.map((r) => r.runId)).toEqual(["r0"]);
    expect(body.trajectory[0]?.steps[0]?.text).toBe("xxxxx");

    const viewed = await db
      .selectFrom("audit_events")
      .select(["actor_account_id", "target", "org_id", "detail"])
      .where("action", "=", "trajectory.viewed")
      .execute();
    expect(viewed).toHaveLength(1);
    expect(viewed[0]).toMatchObject({ actor_account_id: adminId, target: conv, org_id: orgId });
    expect(viewed[0]?.detail).toMatchObject({ agentId: agentA, caseId: c.id, setId: set.id });

    const wrongSet = await createSet(admin, agentA, "Other");
    const cross = await admin({ method: "GET", url: `${base()}/${wrongSet.id}/cases/${c.id}` });
    expect(cross.statusCode).toBe(404);
    expect(errCode(cross)).toBe("eval.case_not_found");
  });
});

describe("对话种类", () => {
  it("listMine 不含 eval 对话；轨迹列表默认只列 chat，kind=eval 列出 eval 对话", async () => {
    const chat = await createConv(alice, orgId, agentA);
    const ev = await createConv(alice, orgId, agentA);
    await db.updateTable("conversations").set({ kind: "eval" }).where("id", "=", ev).execute();

    const mine = await alice({ method: "GET", url: `/api/v1/orgs/${orgId}/conversations` });
    expect(mine.statusCode).toBe(200);
    expect(
      (mine.json() as { conversations: { id: string }[] }).conversations.map((c) => c.id),
    ).toEqual([chat]);

    type Page = { items: TrajectoryListItem[]; next: string | null };
    const list = async (q: string) =>
      (
        (
          await owner({ method: "GET", url: `/api/v1/orgs/${orgId}/trajectories${q}` })
        ).json() as Page
      ).items.map((i) => i.conversationId);
    expect(await list("")).toEqual([chat]);
    expect(await list("?kind=chat")).toEqual([chat]);
    expect(await list("?kind=eval")).toEqual([ev]);
    expect(await list(`?kind=eval&agentId=${agentA}`)).toEqual([ev]);

    const detail = await owner({ method: "GET", url: `/api/v1/orgs/${orgId}/trajectories/${ev}` });
    expect(detail.statusCode).toBe(200);
    expect((detail.json() as { conversation: { kind: string } }).conversation.kind).toBe("eval");
  });
});
