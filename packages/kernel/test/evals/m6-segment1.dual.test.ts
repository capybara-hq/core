import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ContentBlock, ModelUsage } from "@capybara-hq/plugin-sdk";
import {
  createDualReplicaHarness,
  fakeExtensionEntry,
  type Harness,
  replicaOf,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { usageTokens } from "../../src/evals/budget.js";
import {
  EVAL_QUEUE_NAME,
  type EvalResultView,
  type EvalRunView,
  evalJobId,
} from "../../src/evals/runs.service.js";
import type { TrajectoryDetail, TrajectoryListItem } from "../../src/evals/trajectory.service.js";
import { AccountsService } from "../../src/identity/accounts.js";
import {
  INFLIGHT_PREFIX,
  JUDGE_GATE_TOKENS,
  RELEASE_FILE,
} from "../fixtures/plugins/judge-gate/index.js";
import { testMembers } from "../helpers/members.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { eventsOf, PW, waitFor, waitForTerminal } from "../helpers/runs.js";

/**
 * M6 第一段验收（双副本）：两个独立进程的内核副本（api / worker）共享 PG / Redis，加载 model-fake
 * （fake-1、fake-2）、假扩展 fake-tools-ui 与测试用评委模型 judge-gate（经共享目录跨进程控制：请求在途写标记、等测试放行，
 * 回复合法的评委结论）；全部操作经 HTTP（仅「删除原对话」没有 HTTP 接口，直接删库，见第 3 步）。
 *
 * 1. 共享 agent（负责人是普通成员）对话两轮，都调 `fake-tools-ui__write`：第一轮按 agent 的 toolPolicies 请求审批，
 *    发起人在另一个副本上按 `session` 批准；第二轮同一对话已有会话授权，不再审批。
 * 2. 轨迹：负责人（整段）与管理员（运行窗口 `limit=1`）能看，发起对话的普通成员 404；审计两条 `trajectory.viewed`。
 * 3. 建评测集、抽样 2 个用例；删除原对话后用例仍在、详情可读。
 * 4. 用途 `eval` 映射到 judge-gate；估算（上限字段）；单步模式 + 评委、候选换 fake-2；两个评委请求都停在闸门上时
 *    SIGKILL 其中一个所在的副本，再放行；存活副本接手（只补评委），运行 `completed`，`judgePassRate` 0.5，计费精确。
 * 5. 整轮模式、tokenCap 1 → `capped`；评测对话以 `run_aborted {eval_stopped, capped}` 收尾，普通接口 404。
 * 6. 标注一条结果 pass → `humanPassRate` 为 1。
 */

const TOOLS_UI = fakeExtensionEntry("fake-tools-ui");
const JUDGE_GATE = fileURLToPath(
  new URL("../fixtures/plugins/judge-gate/index.ts", import.meta.url),
);

type Json = Record<string, unknown>;
type Res = { status: number; json: Json };
type User = "boss" | "admin" | "keeper" | "user";

const ofType = <T extends ConversationEvent["type"]>(evs: ConversationEvent[], type: T) =>
  evs.filter((e): e is Extract<ConversationEvent, { type: T }> => e.type === type);

const items = (...names: string[]) => ({
  items: names.map((text) => ({ text, status: "pending" })),
});
const TURN1 = items("Plan", "Build");
const TURN2 = items("Ship");
const RUBRIC = "Prefer replies that keep the same tool calls.";

describe("M6 第一段双副本验收（轨迹、评测集、单步 / 整轮回放、杀副本、标注）", () => {
  let pgc: TestContainer;
  let rdc: TestContainer;
  let h: Harness;
  let raw: ReturnType<typeof createDb>;
  let db: KernelDb;
  let redis: Redis;
  /** judge-gate 的共享目录：在途标记 `inflight-<pid>-<uuid>` 与放行文件 `release`。 */
  let gateDir: string;
  /** 已经到达过评委模型的请求各自来自哪个进程（标记文件只增不删）。 */
  const inflightPids = async () =>
    (await readdir(gateDir))
      .filter((f) => f.startsWith(INFLIGHT_PREFIX))
      .map((f) => Number(f.slice(INFLIGHT_PREFIX.length).split("-")[0]));
  /** 被杀之后所有请求只发往存活副本。 */
  let dead: 0 | 1 | undefined;
  const jars: Record<User, Map<string, string>> = {
    boss: new Map(),
    admin: new Map(),
    keeper: new Map(),
    user: new Map(),
  };
  const ids = {} as Record<User, string>;

  /** 以某个用户身份打到指定副本（该副本已被杀时改发存活副本）。 */
  async function at(u: User, want: 0 | 1, method: string, path: string, body?: unknown) {
    const i: 0 | 1 = dead === want ? (want === 0 ? 1 : 0) : want;
    const jar = jars[u];
    const res = await fetch(`http://127.0.0.1:${h.replicas[i].port}${path}`, {
      method,
      redirect: "manual",
      headers: {
        "x-capybara-csrf": "1",
        cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
        ...(body !== undefined && { "content-type": "application/json" }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    expect(replicaOf(res)).toBe(i);
    for (const c of res.headers.getSetCookie()) {
      const [pair = ""] = c.split(";");
      const eq = pair.indexOf("=");
      jar.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
    const text = await res.text();
    return { status: res.status, json: (text === "" ? {} : JSON.parse(text)) as Json } as Res;
  }

  beforeAll(async () => {
    [pgc, rdc] = await Promise.all([startTestPostgres(), startTestRedis()]);
    redis = new Redis(rdc.url);
    await redis.flushdb();
    gateDir = await mkdtemp(join(tmpdir(), "cap-m6-judge-"));
    h = await createDualReplicaHarness({
      extensions: [MODEL_FAKE, TOOLS_UI, JUDGE_GATE],
      pgUrl: pgc.url,
      redisUrl: rdc.url,
      extensionConfig: {
        "model-fake": { models: [{ id: "fake-1" }, { id: "fake-2" }] },
        "judge-gate": { dir: gateDir },
      },
      config: {
        auth: { cookieSecure: false },
        // 短锁期与 stalled 检测间隔：被杀副本持有的评测任务约 1.5 秒后由存活副本接手
        runtime: { jobLockMs: 1000, stalledIntervalMs: 500 },
      },
    });
    raw = createDb(h.dbUrl, 3);
    db = kernelDb(raw);
    const accounts = new AccountsService(db);
    for (const u of Object.keys(jars) as User[]) {
      ids[u] = (await accounts.createLocal({ login: u, password: PW, displayName: u })).id;
    }
    for (const [u, i] of [
      ["boss", 0],
      ["admin", 1],
      ["keeper", 0],
      ["user", 1],
    ] as const) {
      const r = await at(u, i, "POST", "/api/v1/auth/login", { login: u, password: PW });
      expect(r.status, JSON.stringify(r.json)).toBe(200);
    }
  }, 300_000);

  afterAll(async () => {
    await h?.stop();
    await raw?.destroy();
    redis?.disconnect();
    await Promise.all([pgc?.stop(), rdc?.stop()]);
    if (gateDir) await rm(gateDir, { recursive: true, force: true });
  }, 120_000);

  it("两轮对话 → 轨迹 → 评测集 → 单步回放杀副本 → 整轮越限 → 标注", async () => {
    // ---- 组织、成员、插件、共享 agent ----
    const org = await at("boss", 0, "POST", "/api/v1/orgs", { name: "Acme" });
    expect(org.status, JSON.stringify(org.json)).toBe(201);
    const orgId = (org.json.org as { id: string }).id;
    const base = `/api/v1/orgs/${orgId}`;
    await testMembers(db).add(orgId, ids.admin, "admin", ids.boss);
    await testMembers(db).add(orgId, ids.keeper, "member", ids.boss);
    await testMembers(db).add(orgId, ids.user, "member", ids.boss);
    const en = await at("boss", 1, "PUT", `${base}/extensions/fake-tools-ui`, { enabled: true });
    expect(en.status, JSON.stringify(en.json)).toBe(200);

    const ag = await at("keeper", 0, "POST", `${base}/agents`, {
      definition: {
        name: "Planner",
        instructions: "Keep a list.",
        model: { provider: "model-fake", model: "fake-1" },
        tools: [{ kind: "plugin", plugin: "fake-tools-ui", name: "write" }],
        toolPolicies: { "fake-tools-ui__write": "ask" },
      },
      visibility: "org",
    });
    expect(ag.status, JSON.stringify(ag.json)).toBe(201);
    const agentId = (ag.json.agent as { id: string }).id;

    // ---- 1. 普通成员用共享 agent 对话两轮 ----
    const c = await at("user", 1, "POST", `${base}/conversations`, { agentId });
    expect(c.status, JSON.stringify(c.json)).toBe(201);
    const convId = (c.json.conversation as { id: string }).id;
    const conv = `${base}/conversations/${convId}`;
    const say = async (i: 0 | 1, input: unknown) => {
      const r = await at("user", i, "POST", `${conv}/messages`, {
        text: `tool:fake-tools-ui__write:${JSON.stringify(input)}`,
      });
      expect(r.status, JSON.stringify(r.json)).toBe(202);
    };
    await say(0, TURN1);
    const approval = await waitFor(
      () =>
        db
          .selectFrom("approvals")
          .select(["id", "tool_key"])
          .where("conversation_id", "=", convId)
          .where("status", "=", "pending")
          .executeTakeFirst(),
      30_000,
      "fake-tools-ui__write approval",
    );
    expect(approval.tool_key).toBe("fake-tools-ui__write");
    const dec = await at("user", 1, "POST", `${base}/approvals/${approval.id}/decision`, {
      decision: "approve",
      scope: "session",
    });
    expect(dec.status, JSON.stringify(dec.json)).toBe(200);
    const t1 = await waitForTerminal(db, convId, 1, 30_000);
    expect(t1[0]?.type).toBe("run_finished");
    await say(1, TURN2);
    const t2 = await waitForTerminal(db, convId, 2, 30_000);
    expect(t2[1]?.type).toBe("run_finished");
    const run1 = t1[0]?.runId as string;
    const run2 = t2[1]?.runId as string;
    const evs = await eventsOf(db, convId);
    expect(ofType(evs, "approval_requested").map((e) => e.runId)).toEqual([run1]);
    expect(
      ofType(evs, "tool_result").map((e) => [e.runId, e.payload.toolKey, e.payload.isError]),
    ).toEqual([
      [run1, "fake-tools-ui__write", false],
      [run2, "fake-tools-ui__write", false],
    ]);
    const stored = await sql<{ items: unknown }>`
      SELECT items FROM plugin_fake_tools_ui.items WHERE conversation_id = ${convId}`.execute(raw);
    expect(stored.rows.map((r) => r.items)).toEqual([TURN2.items]);

    // ---- 2. 轨迹：负责人与管理员能看，其他成员 404；审计两条 trajectory.viewed ----
    const byKeeper = await at("keeper", 0, "GET", `${base}/trajectories/${convId}`);
    expect(byKeeper.status, JSON.stringify(byKeeper.json)).toBe(200);
    const full = byKeeper.json as unknown as TrajectoryDetail;
    expect(full.conversation).toMatchObject({ id: convId, agentId, kind: "chat" });
    expect(full.runs.map((r) => [r.runId, r.end])).toEqual([
      [run1, { kind: "finished", detail: "completed" }],
      [run2, { kind: "finished", detail: "completed" }],
    ]);
    const call1 = full.runs[0]?.steps[0]?.toolCalls[0];
    expect(call1).toMatchObject({
      toolKey: "fake-tools-ui__write",
      input: TURN1,
      result: { isError: false },
      approval: { decision: "approved", scope: "session", byAccountId: ids.user },
    });
    expect(full.runs[1]?.steps[0]?.toolCalls[0]).toMatchObject({
      toolKey: "fake-tools-ui__write",
      approval: null,
    });
    expect(
      full.runs.every((r) => r.steps.every((s) => s.modelCalls.at(-1)?.outcome === "ok")),
    ).toBe(true);
    // 管理员用运行窗口：只取最新一次运行，next 指向更早的那次
    const byAdmin = await at("admin", 1, "GET", `${base}/trajectories/${convId}?limit=1`);
    expect(byAdmin.status, JSON.stringify(byAdmin.json)).toBe(200);
    const win = byAdmin.json as unknown as TrajectoryDetail;
    expect(win.runs.map((r) => r.runId)).toEqual([run2]);
    // next 是本页最早一次运行的 id（作为 before 传回取更早的一页）
    expect(win.next).toBe(run2);
    for (const i of [0, 1] as const) {
      const denied = await at("user", i, "GET", `${base}/trajectories/${convId}`);
      expect(denied.status).toBe(404);
      expect((denied.json.error as { code: string }).code).toBe("trajectory.not_found");
    }
    const viewed = await db
      .selectFrom("audit_events")
      .select(["actor_account_id", "org_id", "target"])
      .where("action", "=", "trajectory.viewed")
      .orderBy("at")
      .execute();
    expect(viewed).toEqual([
      { actor_account_id: ids.keeper, org_id: orgId, target: convId },
      { actor_account_id: ids.admin, org_id: orgId, target: convId },
    ]);

    // ---- 3. 评测集：抽样 2 个用例；删除原对话后用例仍在 ----
    const set = await at("admin", 0, "POST", `${base}/eval-sets`, {
      agentId,
      name: "Planner regression",
      rubric: RUBRIC,
    });
    expect(set.status, JSON.stringify(set.json)).toBe(201);
    const setId = (set.json.set as { id: string }).id;
    const sampled = await at("admin", 1, "POST", `${base}/eval-sets/${setId}/cases/sample`, {
      count: 2,
    });
    expect(sampled.status, JSON.stringify(sampled.json)).toBe(200);
    expect(sampled.json).toEqual({ added: 2, skipped: 0 });
    // 删除对话没有 HTTP 接口（与 T3 的测试一样直接删库）；依赖行随对话级联删除
    await db.deleteFrom("conversations").where("id", "=", convId).execute();
    expect(
      await db
        .selectFrom("conversation_events")
        .select("seq")
        .where("conversation_id", "=", convId)
        .execute(),
    ).toEqual([]);
    const detail = await at("admin", 0, "GET", `${base}/eval-sets/${setId}`);
    expect(detail.status, JSON.stringify(detail.json)).toBe(200);
    const cases = (detail.json.set as { cases: { id: string; replayableSteps: number }[] }).cases;
    expect(cases).toHaveLength(2);
    expect(cases.map((x) => x.replayableSteps)).toEqual([2, 2]);
    const oneCase = await at("admin", 1, "GET", `${base}/eval-sets/${setId}/cases/${cases[0]?.id}`);
    expect(oneCase.status, JSON.stringify(oneCase.json)).toBe(200);
    expect((oneCase.json.trajectory as unknown[]).length).toBeGreaterThanOrEqual(1);

    // ---- 4. 用途 eval → judge-gate/judge-1；单步 + 评委，候选 fake-2；评委卡在闸门时杀副本 ----
    const purpose = await at("admin", 0, "PUT", `${base}/model-purposes/eval`, {
      target: { model: { provider: "judge-gate", model: "judge-1" } },
    });
    expect(purpose.status, JSON.stringify(purpose.json)).toBe(200);
    const stepBody = {
      mode: "step",
      candidate: { model: { provider: "model-fake", model: "fake-2" } },
      judge: true,
    };
    const est = await at("admin", 1, "POST", `${base}/eval-sets/${setId}/runs/estimate`, stepBody);
    expect(est.status, JSON.stringify(est.json)).toBe(200);
    expect(est.json).toMatchObject({
      estimate: { cases: 2, modelRequests: 4, judgeRequests: 4 },
      defaultTokenCap: 1_000_000,
      maxTokenCap: 20_000_000,
      effectiveTokenCap: 1_000_000,
    });
    const started = await at("admin", 0, "POST", `${base}/eval-sets/${setId}/runs`, stepBody);
    expect(started.status, JSON.stringify(started.json)).toBe(201);
    const stepRun = (started.json.run as EvalRunView).id;

    // 两个用例并发（orgConcurrency 缺省 2），各自写完第一步的候选（done）后，评委请求停在闸门上：
    // 等到两个评委请求都在途（标记文件带发起进程的 pid），此时两条结果都是 done + 评委 pending，且不会再变
    const held = await waitFor(
      async () => {
        const pids = await inflightPids();
        return pids.length >= 2 ? pids : null;
      },
      60_000,
      "two judge requests held at the gate",
    );
    expect(held).toHaveLength(2);
    const pending = await db
      .selectFrom("eval_results")
      .select(["id", "case_id", "claimed_by", "candidate"])
      .where("run_id", "=", stepRun)
      .where("status", "=", "done")
      .where("judge_status", "=", "pending")
      .execute();
    expect(pending).toHaveLength(2);
    // 杀掉第一个在途评委所在的副本；它手里的用例（按任务的 processedBy）就是要由存活副本接手补评委的
    const victim = h.replicas.find((r) => r.pid === held[0]);
    expect(victim, `held=${held}`).toBeDefined();
    dead = (victim as { index: 0 | 1 }).index;
    const victimPid = (victim as { pid: number }).pid;
    const survivorPid = h.replicas[dead === 0 ? 1 : 0].pid;
    const onVictim: typeof pending = [];
    for (const p of pending) {
      const pb = await redis.hget(`bull:${EVAL_QUEUE_NAME}:${evalJobId(stepRun, p.case_id)}`, "pb");
      if (pb?.endsWith(`-${victimPid}`)) onVictim.push(p);
    }
    expect(onVictim.length).toBe(held.filter((p) => p === victimPid).length);
    await h.kill(dead);
    // 杀完才放行：存活副本上卡住的评委、以及接手后补发的评委都直接得到结论
    await writeFile(join(gateDir, RELEASE_FILE), "");

    const stepView = await waitFor(
      async () => {
        const r = await at("admin", 0, "GET", `${base}/eval-runs/${stepRun}`);
        const v = r.json.run as EvalRunView;
        return v.status === "queued" || v.status === "running" ? null : v;
      },
      120_000,
      "step run finished",
      200,
    );
    expect(stepView).toMatchObject({
      status: "completed",
      error: null,
      casesTotal: 2,
      casesDone: 2,
      judge: true,
    });
    const stepRes = await at("admin", 1, "GET", `${base}/eval-runs/${stepRun}/results?limit=200`);
    const stepResults = (stepRes.json as { results: EvalResultView[] }).results;
    expect(stepResults).toHaveLength(4);
    expect(stepResults.every((r) => r.status === "done")).toBe(true);
    // 全部评委都给出了结论（没有 pending / error）
    expect(stepResults.map((r) => r.judgeStatus)).toEqual(["done", "done", "done", "done"]);
    // 被杀副本手里的结果：存活副本重新认领（新认领号）后只补评委，候选没有重做
    for (const p of onVictim) {
      const r = stepResults.find((x) => x.id === p.id) as EvalResultView;
      expect(r.candidate).toEqual(p.candidate);
      const row = await db
        .selectFrom("eval_results")
        .select("claimed_by")
        .where("id", "=", p.id)
        .executeTakeFirstOrThrow();
      expect(row.claimed_by).not.toBeNull();
      expect(row.claimed_by).not.toBe(p.claimed_by);
    }
    // 真实的评委结论：评委对工具调用那一步判 pass / 4，对文本那一步判 fail / 2
    const isToolStep = (r: EvalResultView) =>
      (r.candidate as { content: ContentBlock[] }).content.some((b) => b.type === "tool_call");
    expect(stepResults.filter(isToolStep)).toHaveLength(2);
    for (const r of stepResults) {
      expect(r.judge).toMatchObject(
        isToolStep(r)
          ? {
              verdict: "pass",
              score: 4,
              reason: "Same tool call.",
              provider: "judge-gate",
              model: "judge-1",
            }
          : {
              verdict: "fail",
              score: 2,
              reason: "Text reply.",
              provider: "judge-gate",
              model: "judge-1",
            },
      );
      expect(r.candidate).toMatchObject({ provider: "model-fake", model: "fake-2" });
      expect(r.diff).toMatchObject({ toolCallsMatch: true, textSimilarity: 1 });
    }
    // 评委请求：存活副本发了 4 次（自己卡住的、接手补发的、两个用例的第二步）；被杀副本上卡住的那几次丢失
    const pids = await inflightPids();
    expect(pids.filter((p) => p === survivorPid)).toHaveLength(4);
    expect(pids.filter((p) => p === victimPid)).toHaveLength(onVictim.length);
    expect(pids).toHaveLength(4 + onVictim.length);
    // 计费恰好 = 4 次候选 + 4 次评委。被 SIGKILL 的进程里在途的评委请求永远不会计费：进程死了，没有机会
    // 按估算记账（T6 的估算计费只覆盖中止 / 出错），这是进程级崩溃固有的代价（C7「在途可超出」的反面），
    // 补评委那一次照常计费。闸门保证被杀时在途的只有评委请求，所以这里能断言精确值。
    const candidateTokens = stepResults.reduce(
      (n, r) => n + usageTokens((r.candidate as { usage: ModelUsage }).usage),
      0,
    );
    expect(stepView.tokensUsed).toBe(candidateTokens + 4 * JUDGE_GATE_TOKENS);
    expect(stepView.summary).toMatchObject({
      done: 4,
      errors: 0,
      skipped: 0,
      toolCallsMatchRate: 1,
      meanTextSimilarity: 1,
      judgePassRate: 0.5,
      judgeErrors: 0,
      humanPassRate: null,
      labeled: 0,
    });
    // 单步模式不建评测对话
    expect(stepResults.every((r) => r.evalConversationId === null)).toBe(true);

    // ---- 5. 整轮模式、上限很小 → capped ----
    const live: 0 | 1 = dead === 0 ? 1 : 0;
    const runStart = await at("admin", live, "POST", `${base}/eval-sets/${setId}/runs`, {
      mode: "run",
      candidate: { model: { provider: "model-fake", model: "fake-2" } },
      tokenCap: 1,
    });
    expect(runStart.status, JSON.stringify(runStart.json)).toBe(201);
    const wholeRun = (runStart.json.run as EvalRunView).id;
    const wholeResults = await waitFor(
      async () => {
        const r = await at("admin", live, "GET", `${base}/eval-runs/${wholeRun}/results`);
        const rs = (r.json as { results: EvalResultView[] }).results;
        return rs.length === 2 && rs.every((x) => !["pending", "running"].includes(x.status))
          ? rs
          : null;
      },
      60_000,
      "whole-run results settled",
      200,
    );
    const wholeView = await waitFor(
      async () => {
        const r = await at("admin", live, "GET", `${base}/eval-runs/${wholeRun}`);
        const v = r.json.run as EvalRunView;
        return v.casesDone === 2 ? v : null;
      },
      30_000,
      "whole run cases done",
      200,
    );
    expect(wholeView).toMatchObject({ mode: "run", status: "capped", tokenCap: 1, error: null });
    expect(wholeView.tokensUsed).toBeGreaterThan(1);
    expect(wholeView.finishedAt).not.toBeNull();
    expect(wholeResults.map((r) => r.status)).toEqual(["skipped", "skipped"]);
    // 评测对话：隐藏对话，只在轨迹 kind=eval 里出现；以 run_aborted {eval_stopped, capped} 收尾
    const evalList = await at(
      "admin",
      live,
      "GET",
      `${base}/trajectories?kind=eval&agentId=${agentId}`,
    );
    expect(evalList.status, JSON.stringify(evalList.json)).toBe(200);
    const evalConvs = (evalList.json.items as TrajectoryListItem[]).map((x) => x.conversationId);
    expect(evalConvs.length).toBeGreaterThanOrEqual(1);
    const chatList = await at("admin", live, "GET", `${base}/trajectories?agentId=${agentId}`);
    expect(chatList.json.items).toEqual([]);
    for (const id of evalConvs) {
      const kindRow = await db
        .selectFrom("conversations")
        .select(["kind", "eval_run_id"])
        .where("id", "=", id)
        .executeTakeFirstOrThrow();
      expect(kindRow).toEqual({ kind: "eval", eval_run_id: wholeRun });
      const last = (await eventsOf(db, id)).at(-1);
      expect(last).toMatchObject({
        type: "run_aborted",
        payload: { reason: "eval_stopped", detail: "capped" },
      });
      const tr = await at("admin", live, "GET", `${base}/trajectories/${id}`);
      expect(tr.status, JSON.stringify(tr.json)).toBe(200);
      const td = tr.json as unknown as TrajectoryDetail;
      expect(td.conversation.kind).toBe("eval");
      expect(td.runs.at(-1)?.end).toEqual({ kind: "aborted", detail: "capped" });
      // 普通对话接口一律 404
      for (const u of ["admin", "boss"] as const) {
        const g = await at(u, live, "GET", `${base}/conversations/${id}`);
        expect(g.status).toBe(404);
        const ev = await at(u, live, "GET", `${base}/conversations/${id}/events`);
        expect(ev.status).toBe(404);
      }
    }

    // ---- 6. 标注一条 → humanPassRate 为 1 ----
    const target = stepResults[0] as EvalResultView;
    const lab = await at("admin", live, "PUT", `${base}/eval-results/${target.id}/label`, {
      label: "pass",
      note: "same plan",
    });
    expect(lab.status, JSON.stringify(lab.json)).toBe(200);
    const after = await at("admin", live, "GET", `${base}/eval-runs/${stepRun}`);
    expect((after.json.run as EvalRunView).summary).toMatchObject({ humanPassRate: 1, labeled: 1 });

    // 收尾：没有残留的活跃运行
    const active = await db
      .selectFrom("eval_runs")
      .select("id")
      .where("status", "in", ["queued", "running"])
      .execute();
    expect(active).toEqual([]);
  }, 300_000);
});
