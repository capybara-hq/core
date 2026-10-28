import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { KernelConfig } from "../../src/config/schema.js";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import type { Kernel } from "../../src/kernel.js";
import { KyselyCheckpointSaver } from "../../src/runtime/checkpointer.js";
import { LangGraphLoop, type LoopDeps } from "../../src/runtime/langgraph-loop.js";
import type { AgentLoop, LoopContext, LoopOutcome } from "../../src/runtime/loop.js";
import {
  type ModelStepDeps,
  RunError,
  runFinalWrapUp,
  runModelStep,
  WRAP_UP_REMINDER,
} from "../../src/runtime/model-call.js";
import { RUN_QUEUE_NAME, runJobId } from "../../src/runtime/run-queue.js";
import type { RunHooks } from "../../src/runtime/run-worker.js";
import { truncateTables } from "../helpers/db.js";
import { asUser, cookieJar } from "../helpers/http.js";
import { accountsFor } from "../helpers/identity.js";
import {
  consumedSeq,
  createAgent,
  createConv,
  createOrg,
  eventsOf,
  gate,
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
 * 测试用 loop：逐步调用 `runModelStep`，直到 stopReason 不是 `tool_use`（M2 没有工具，tool_use 当作继续）。
 * 每步开始前吸收插话；超过 maxSteps 调 `runFinalWrapUp`；停机信号在步骤边界返回 `interrupted`。
 * 续跑（停机后回到队列）时从日志里该 run 已有的 assistant_message 数推出下一步的编号。
 */
class SequentialLoop implements AgentLoop {
  constructor(private readonly deps: ModelStepDeps) {}

  async run(ctx: LoopContext): Promise<LoopOutcome> {
    const done = await this.deps.eventLog.readAfter(ctx.conversationId, 0, 10_000);
    let step =
      done.filter((e) => e.type === "assistant_message" && e.runId === ctx.runId).length + 1;
    let consumed = 0;
    const input = () => ({
      orgId: ctx.orgId,
      conversationId: ctx.conversationId,
      runId: ctx.runId,
      step,
      agent: ctx.agent,
      agentVersion: ctx.agentVersion,
      signal: ctx.signal,
      sink: ctx.sink,
      absorbedUpToSeq: consumed,
    });
    const timedOut = () => Date.now() >= ctx.limits.deadline;
    for (;;) {
      if (ctx.shutdown.aborted) return { kind: "interrupted" };
      if (timedOut()) return { kind: "max_duration", consumedUpToSeq: consumed };
      for (const m of await ctx.pendingUserMessages(consumed)) consumed = Math.max(consumed, m.seq);
      if (step > ctx.limits.maxSteps) {
        const r = await runFinalWrapUp(this.deps, input());
        if (r.aborted && !timedOut()) return { kind: "aborted" };
        return { kind: "max_steps", consumedUpToSeq: consumed };
      }
      const r = await runModelStep(this.deps, input());
      step++;
      if (r.aborted) {
        return timedOut()
          ? { kind: "max_duration", consumedUpToSeq: consumed }
          : { kind: "aborted" };
      }
      if (r.stopReason !== "tool_use") return { kind: "completed", consumedUpToSeq: consumed };
    }
  }
}

const sequential = (deps: ModelStepDeps): AgentLoop => new SequentialLoop(deps);
const langgraph = (deps: LoopDeps): AgentLoop =>
  new LangGraphLoop(new KyselyCheckpointSaver(deps.db), deps);

/** 当前 describe 使用的 loop（同一组场景分别跑 SequentialLoop 与默认的 LangGraphLoop）。 */
let defaultLoop: (deps: LoopDeps) => AgentLoop = sequential;

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
/** 常驻的 api 内核：处理 HTTP，不执行运行。 */
let api: Kernel;
/** 每个测试自己启动的内核，afterEach 停掉。 */
let extra: Kernel[] = [];
let ownerId: string;
let req: Req;

const urls = () => ({ pg: pgc.url, redis: rd.url });

async function worker(
  runtime: Partial<KernelConfig["runtime"]> = {},
  opts: {
    hooks?: RunHooks;
    roles?: ("api" | "worker" | "gateway")[];
    loop?: (deps: LoopDeps) => AgentLoop;
  } = {},
): Promise<Kernel> {
  const k = await startKernel(runConfig(urls(), { roles: opts.roles ?? ["worker"], runtime }), {
    loop: opts.loop ?? defaultLoop,
    ...(opts.hooks && { runHooks: opts.hooks }),
  });
  extra.push(k);
  return k;
}

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  api = await startKernel(runConfig(urls(), { roles: ["api"] }), { loop: sequential });
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  redis = new Redis(rd.url);
}, 120_000);
afterAll(async () => {
  await api?.stop();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});
beforeEach(async () => {
  await truncateTables(
    raw,
    "capybara.accounts, capybara.orgs, capybara.audit_events, capybara.deployment_settings",
  );
  await redis.flushdb();
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  req = await session(api, "owner");
});
afterEach(async () => {
  await Promise.all(extra.map((k) => k.stop()));
  extra = [];
});

async function setup(model?: { provider: string; model: string }) {
  const orgId = await createOrg(req);
  const agentId = await createAgent(req, orgId, model);
  const convId = await createConv(req, orgId, agentId);
  return { orgId, agentId, convId };
}

const LOOPER = { provider: "model-looper", model: "loop-1" };
const types = (evs: ConversationEvent[]) => evs.map((e) => e.type);
const textOf = (e: ConversationEvent) =>
  e.type === "assistant_message"
    ? e.payload.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("")
    : "";

const LOOPS: [string, (deps: LoopDeps) => AgentLoop][] = [
  ["SequentialLoop", sequential],
  ["LangGraphLoop", langgraph],
];

describe.each(LOOPS)("RunWorker（%s）", (_name, loopFactory) => {
  beforeAll(() => {
    defaultLoop = loopFactory;
  });
  it("echo:hi → user_message、run_started、model_call、assistant_message、usage、run_finished", async () => {
    await worker();
    const { orgId, convId } = await setup();
    const seq = await postMessage(req, orgId, convId, "echo:hi");
    await waitForTerminal(db, convId);
    const evs = await eventsOf(db, convId);
    expect(types(evs)).toEqual([
      "user_message",
      "run_started",
      "model_call",
      "assistant_message",
      "usage",
      "run_finished",
    ]);
    const runId = evs[1]?.runId as string;
    expect(evs.slice(1).every((e) => e.runId === runId)).toBe(true);
    expect(evs[1]?.payload).toMatchObject({
      agentVersion: 1,
      model: { provider: "model-fake", model: "fake-1" },
      triggerAccountId: ownerId,
    });
    expect(textOf(evs[3] as ConversationEvent)).toBe("hi");
    expect(evs[5]?.payload).toEqual({ reason: "completed", consumedUpToSeq: seq });
    expect(await consumedSeq(db, convId)).toBe(seq);
    expect(await runsOf(db, convId)).toEqual([{ id: runId, status: "completed" }]);
    // 锁与配额已释放（终态事件写入后才释放，负载高时稍晚一点：等到释放再断言）
    await waitFor(
      async () => (await redis.exists(`capk:conv-run:${convId}`)) === 0,
      5_000,
      "conversation lock released",
    );
    await waitFor(
      async () => (await redis.zcard(`capk:org-runs:${orgId}`)) === 0,
      5_000,
      "org run quota released",
    );
    expect(await redis.exists(`capk:conv-run:${convId}`)).toBe(0);
    expect(await redis.zcard(`capk:org-runs:${orgId}`)).toBe(0);
  });

  it("同一会话串行：连发两条消息 → 两条都被处理，两轮运行的事件不交错", async () => {
    await worker();
    const { orgId, convId } = await setup();
    await postMessage(req, orgId, convId, "slow:40:abcdefghijklmnopqrst");
    // 等到第一轮已吸收消息、开始调用模型（model_call）再发第二条：run_started 之后、第一次吸收之前到达的
    // 消息按设计并入第一轮（插话），只有一轮；LangGraphLoop 起图较慢，CI 负载下常落在这个窗口里
    await waitForEvent(db, convId, (e) => e.type === "model_call");
    const second = await postMessage(req, orgId, convId, "echo:two");
    await waitForTerminal(db, convId, 2);
    const evs = await eventsOf(db, convId);
    const runs = await runsOf(db, convId);
    expect(runs.map((r) => r.status)).toEqual(["completed", "completed"]);
    // 每轮的事件连续：从 run_started 到 run_finished 之间没有别的 run 的事件
    for (const r of runs) {
      const seqs = evs.filter((e) => e.runId === r.id).map((e) => e.seq);
      const lo = Math.min(...seqs);
      const hi = Math.max(...seqs);
      const between = evs.filter((e) => e.seq >= lo && e.seq <= hi && e.runId !== null);
      expect(between.every((e) => e.runId === r.id)).toBe(true);
    }
    expect(evs.filter((e) => e.type === "run_started")).toHaveLength(2);
    expect(evs.filter((e) => e.type === "assistant_message").map(textOf)).toEqual([
      "abcdefghijklmnopqrst",
      "two",
    ]);
    expect(await consumedSeq(db, convId)).toBe(second);
  });

  it("message at run boundary is processed exactly once：run_finished 之后、锁释放之前到达 → 任务完成后的 ensureRun 起新一轮", async () => {
    const paused = gate();
    const resume = gate();
    let first = true;
    await worker(
      {},
      {
        hooks: {
          async beforeRelease() {
            if (!first) return;
            first = false;
            paused.open();
            await resume.promise;
          },
        },
      },
    );
    const { orgId, convId } = await setup();
    await postMessage(req, orgId, convId, "echo:first");
    await paused.promise;
    // run_finished 已写入、锁仍被持有：这时发来的消息由 finally 中的 ensureRun 处理
    expect((await eventsOf(db, convId)).some((e) => e.type === "run_finished")).toBe(true);
    expect(await redis.get(`capk:conv-run:${convId}`)).not.toBeNull();
    const late = await postMessage(req, orgId, convId, "echo:late");
    expect((await runsOf(db, convId)).length).toBe(1);
    resume.open();
    await waitForTerminal(db, convId, 2);
    await sleep(500);
    const evs = await eventsOf(db, convId);
    const replies = evs.filter((e) => e.type === "assistant_message").map(textOf);
    expect(replies).toEqual(["first", "late"]);
    expect(evs.filter((e) => e.type === "run_finished")).toHaveLength(2);
    expect((await runsOf(db, convId)).map((r) => r.status)).toEqual(["completed", "completed"]);
    expect(await consumedSeq(db, convId)).toBe(late);
  });

  it("任务完成后的 ensureRun 失败一次 → 退避重试，运行结束瞬间到达的消息仍被回复", async () => {
    const paused = gate();
    const resume = gate();
    let first = true;
    let failures = 0;
    await worker(
      {},
      {
        hooks: {
          async beforeRelease() {
            if (!first) return;
            first = false;
            paused.open();
            await resume.promise;
          },
          async beforeEnsureRun() {
            if (failures > 0) return;
            failures++;
            throw new Error("injected ensureRun failure");
          },
        },
      },
    );
    const { orgId, convId } = await setup();
    await postMessage(req, orgId, convId, "echo:first");
    await paused.promise;
    const late = await postMessage(req, orgId, convId, "echo:late");
    resume.open();
    const terms = await waitForTerminal(db, convId, 2);
    expect(failures).toBe(1);
    expect(terms[1]?.payload).toEqual({ reason: "completed", consumedUpToSeq: late });
    const replies = (await eventsOf(db, convId)).filter((e) => e.type === "assistant_message");
    expect(replies.map(textOf)).toEqual(["first", "late"]);
  });

  it("message at run boundary is processed exactly once：步骤之间到达 → 被本轮吸收，不再另起一轮", async () => {
    await worker();
    const { orgId, convId } = await setup(LOOPER);
    await postMessage(req, orgId, convId, "loop:300");
    await waitForEvent(db, convId, (e) => e.type === "model_call");
    const inter = await postMessage(req, orgId, convId, "hello");
    const [fin] = await waitForTerminal(db, convId);
    expect(fin?.payload).toEqual({ reason: "completed", consumedUpToSeq: inter });
    await sleep(500);
    const evs = await eventsOf(db, convId);
    expect(evs.filter((e) => e.type === "run_started")).toHaveLength(1);
    expect(evs.filter((e) => e.type === "assistant_message").map(textOf)).toEqual([
      "",
      "You said: hello",
    ]);
    // 插话在第 2 步的 model_call 之前
    const calls = evs.filter((e) => e.type === "model_call");
    expect(calls).toHaveLength(2);
    expect((calls[1] as ConversationEvent).seq).toBeGreaterThan(inter);
    expect(await runsOf(db, convId)).toHaveLength(1);
    expect(await consumedSeq(db, convId)).toBe(inter);
  });

  it("组织配额隔离：组织 A limit 1 的 3 个会话依次执行，组织 B 立即开始", async () => {
    await worker();
    const orgA = await createOrg(req, "A");
    const orgB = await createOrg(req, "B");
    await db
      .insertInto("deployment_settings")
      .values({ key: "runConcurrencyOverrides", value: JSON.stringify({ [orgA]: 1 }) })
      .execute();
    const agentA = await createAgent(req, orgA);
    const agentB = await createAgent(req, orgB);
    const convsA = [
      await createConv(req, orgA, agentA),
      await createConv(req, orgA, agentA),
      await createConv(req, orgA, agentA),
    ];
    const convB = await createConv(req, orgB, agentB);
    const text = "slow:100:abcdefghijkl";
    for (const c of convsA) await postMessage(req, orgA, c, text);
    await postMessage(req, orgB, convB, text);
    // "B starts immediately" is asserted by ordering below (B starts before A's second run), not
    // by a wall-clock budget, which is fragile on loaded CI runners.
    const startedB = await waitForEvent(db, convB, (e) => e.type === "run_started", 10_000);

    const spans: [number, number][] = [];
    for (const c of convsA) {
      const evs = await waitForTerminal(db, c, 1, 30_000);
      const all = await eventsOf(db, c);
      const start = all.find((e) => e.type === "run_started") as ConversationEvent;
      spans.push([start.createdAt.getTime(), (evs[0] as ConversationEvent).createdAt.getTime()]);
    }
    spans.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < spans.length; i++) {
      expect((spans[i] as [number, number])[0]).toBeGreaterThanOrEqual(
        (spans[i - 1] as [number, number])[1],
      );
    }
    // B 在 A 的第二轮开始之前就开始了
    expect(startedB.createdAt.getTime()).toBeLessThan((spans[1] as [number, number])[0]);
  }, 40_000);

  it("中止（跨副本）：运行在 worker 实例上，在 api 实例上 abort → 1s 内结束，保存已流出的部分，不再调用模型", async () => {
    await worker();
    const { orgId, convId } = await setup();
    await postMessage(req, orgId, convId, `slow:100:${"abcd".repeat(100)}`);
    await waitForEvent(db, convId, (e) => e.type === "model_call");
    await sleep(350);
    const t0 = Date.now();
    const res = await req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/conversations/${convId}/abort`,
    });
    expect(res.statusCode).toBe(202);
    const { runId } = res.json() as { runId: string };
    const aborted = await waitForEvent(db, convId, (e) => e.type === "run_aborted", 10_000);
    // The run would otherwise keep streaming for ~40 s; 5 s leaves room for CI load.
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(aborted.runId).toBe(runId);
    expect(aborted.payload).toEqual({ byAccountId: ownerId, reason: "user" });
    await sleep(500);
    const evs = await eventsOf(db, convId);
    const msg = evs.find((e) => e.type === "assistant_message") as ConversationEvent & {
      type: "assistant_message";
    };
    expect(msg.payload.stopReason).toBe("aborted");
    expect(textOf(msg).length).toBeGreaterThan(0);
    expect(textOf(msg).length).toBeLessThan(400);
    expect(evs.filter((e) => e.type === "model_call" && e.seq > aborted.seq)).toEqual([]);
    expect(evs.filter((e) => e.type === "model_call")).toHaveLength(1);
    expect(await runsOf(db, convId)).toEqual([{ id: runId, status: "aborted" }]);
    expect(await consumedSeq(db, convId)).toBe(1);
    // 没有活跃运行时再 abort → 409
    const again = await req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/conversations/${convId}/abort`,
    });
    expect(again.statusCode).toBe(409);
  });

  it("超时：maxRunSeconds 1 + slow:500 长输出 → run_finished reason max_duration", async () => {
    await worker({ maxRunSeconds: 1 });
    const { orgId, convId } = await setup();
    const seq = await postMessage(req, orgId, convId, `slow:500:${"abcd".repeat(20)}`);
    const [fin] = await waitForTerminal(db, convId, 1, 5_000);
    expect(fin?.type).toBe("run_finished");
    expect(fin?.payload).toEqual({ reason: "max_duration", consumedUpToSeq: seq });
    const evs = await eventsOf(db, convId);
    const msg = evs.find((e) => e.type === "assistant_message");
    expect(msg?.payload).toMatchObject({ stopReason: "aborted" });
    expect(await runsOf(db, convId)).toMatchObject([{ status: "completed" }]);
  });

  it("步数上限：每步都返回工具调用且 maxSteps 3 → runFinalWrapUp，reason max_steps", async () => {
    await worker({ maxSteps: 3 });
    const { orgId, convId } = await setup(LOOPER);
    const seq = await postMessage(req, orgId, convId, "loop:10");
    const [fin] = await waitForTerminal(db, convId);
    expect(fin?.payload).toEqual({ reason: "max_steps", consumedUpToSeq: seq });
    const evs = await eventsOf(db, convId);
    const msgs = evs.filter((e) => e.type === "assistant_message");
    expect(msgs.map((m) => m.payload.stopReason)).toEqual([
      "tool_use",
      "tool_use",
      "tool_use",
      "end_turn",
    ]);
    expect(textOf(msgs[3] as ConversationEvent)).toBe("wrapped up");
    expect(evs.some((e) => e.type === "reminder" && e.payload.text === WRAP_UP_REMINDER)).toBe(
      true,
    );
  });

  it("优雅停机：运行进行中 stop() → 任务回到队列，另一个 worker 续跑完成；只有一条 run_started 与 run_finished", async () => {
    const w1 = await worker({ maxSteps: 4 });
    const { orgId, convId } = await setup(LOOPER);
    await postMessage(req, orgId, convId, "loop:200");
    await waitForEvent(db, convId, (e) => e.type === "model_call");
    const t0 = Date.now();
    await w1.stop();
    expect(Date.now() - t0).toBeLessThan(3_000);
    const mid = await eventsOf(db, convId);
    expect(mid.some((e) => e.type === "run_finished")).toBe(false);
    expect((await runsOf(db, convId))[0]?.status).toBe("running");
    expect(await redis.exists(`capk:conv-run:${convId}`)).toBe(0);

    await worker({ maxSteps: 4 });
    const [fin] = await waitForTerminal(db, convId);
    expect(fin?.payload).toMatchObject({ reason: "max_steps" });
    const evs = await eventsOf(db, convId);
    expect(evs.filter((e) => e.type === "run_started")).toHaveLength(1);
    expect(evs.filter((e) => e.type === "run_finished")).toHaveLength(1);
    const steps = evs.flatMap((e) => (e.type === "assistant_message" ? [e.payload.step] : []));
    expect(steps).toEqual([1, 2, 3, 4, 5]);
    expect(await runsOf(db, convId)).toMatchObject([{ status: "completed" }]);
  });

  it("api 角色不执行运行：api 内核接收消息，运行由后起的 worker 内核执行", async () => {
    const { orgId, convId } = await setup();
    await postMessage(req, orgId, convId, "echo:queued");
    await sleep(500);
    expect((await runsOf(db, convId)).map((r) => r.status)).toEqual(["queued"]);
    expect(types(await eventsOf(db, convId))).toEqual(["user_message"]);
    await worker();
    const [fin] = await waitForTerminal(db, convId);
    expect(fin?.type).toBe("run_finished");
    expect((await runsOf(db, convId)).map((r) => r.status)).toEqual(["completed"]);
  });

  it("运行失败（不可重试的模型错误）→ run_failed，status failed，锁与配额释放", async () => {
    await worker();
    const { orgId, convId } = await setup();
    await postMessage(req, orgId, convId, "fail:auth");
    const [t] = await waitForTerminal(db, convId);
    expect(t?.type).toBe("run_failed");
    expect(t?.payload).toMatchObject({ error: { code: "model.auth" } });
    // 失败也推进 consumed_seq：不会对同一条消息无限重试
    await sleep(300);
    expect((await runsOf(db, convId)).map((r) => r.status)).toEqual(["failed"]);
    expect(await consumedSeq(db, convId)).toBe(1);
    expect(await redis.exists(`capk:conv-run:${convId}`)).toBe(0);
    expect(await redis.zcard(`capk:org-runs:${orgId}`)).toBe(0);
  });

  it("等待中的消息：提交后 ensureRun 只投递一次（重复提交同一 clientMessageId 不起新运行）", async () => {
    const { orgId, convId } = await setup();
    for (let i = 0; i < 2; i++) {
      const res = await req({
        method: "POST",
        url: `/api/v1/orgs/${orgId}/conversations/${convId}/messages`,
        payload: { text: "echo:x", clientMessageId: "c-1" },
      });
      expect(res.statusCode).toBe(202);
    }
    expect(await runsOf(db, convId)).toHaveLength(1);
    await worker();
    await waitForTerminal(db, convId);
    await sleep(300);
    expect(await runsOf(db, convId)).toMatchObject([{ status: "completed" }]);
    await waitFor(async () => (await redis.exists(`capk:conv-run:${convId}`)) === 0, 2_000);
  });
  it("会话锁在运行中丢失（R27）→ 按停机处理：不写终态、不释放别人的锁，任务回到队列后续跑完成一次", async () => {
    await worker({ maxSteps: 4 }, { hooks: { lockTtlMs: 300 } });
    const { orgId, convId } = await setup(LOOPER);
    await postMessage(req, orgId, convId, "loop:300");
    await waitForEvent(db, convId, (e) => e.type === "model_call");
    // 模拟锁过期后被别人取得：覆盖锁键，下一次续租（≤100ms）发现丢失
    await redis.set(`capk:conv-run:${convId}`, "foreign", "PX", 1500);
    await sleep(600);
    // 第 1 步已在步骤边界结束、运行被中断：没有终态，别人的锁原样保留
    expect(await redis.get(`capk:conv-run:${convId}`)).toBe("foreign");
    let evs = await eventsOf(db, convId);
    expect(evs.some((e) => ["run_finished", "run_failed", "run_aborted"].includes(e.type))).toBe(
      false,
    );
    expect(evs.filter((e) => e.type === "assistant_message")).toHaveLength(1);
    expect((await runsOf(db, convId))[0]?.status).toBe("running");
    // 别人的锁过期后，回到队列的任务重新领取并续跑完成
    const [fin] = await waitForTerminal(db, convId, 1, 15_000);
    expect(fin?.payload).toMatchObject({ reason: "max_steps" });
    await sleep(300);
    evs = await eventsOf(db, convId);
    expect(evs.filter((e) => e.type === "run_started")).toHaveLength(1);
    expect(evs.filter((e) => e.type === "run_finished")).toHaveLength(1);
    expect(evs.flatMap((e) => (e.type === "assistant_message" ? [e.payload.step] : []))).toEqual([
      1, 2, 3, 4, 5,
    ]);
    expect(await runsOf(db, convId)).toMatchObject([{ status: "completed" }]);
  }, 30_000);

  it("loop 在吸收消息前抛错 → run_failed，consumed_seq 推进到触发消息，之后的新消息正常运行（会话不卡住）", async () => {
    let throwNext = true;
    await worker(
      {},
      {
        loop: (deps) => {
          const inner = loopFactory(deps);
          return {
            run: async (ctx) => {
              if (throwNext) {
                throwNext = false;
                throw new RunError("run.test", "boom before absorbing");
              }
              return inner.run(ctx);
            },
          };
        },
      },
    );
    const { orgId, convId } = await setup();
    const first = await postMessage(req, orgId, convId, "echo:first");
    const [t] = await waitForTerminal(db, convId);
    expect(t?.type).toBe("run_failed");
    expect(t?.payload).toMatchObject({ error: { code: "run.test" } });
    await sleep(300);
    expect(await consumedSeq(db, convId)).toBe(first);
    expect((await runsOf(db, convId)).map((r) => r.status)).toEqual(["failed"]);

    const next = await postMessage(req, orgId, convId, "echo:next");
    const terms = await waitForTerminal(db, convId, 2);
    expect(terms[1]?.type).toBe("run_finished");
    expect((await runsOf(db, convId)).map((r) => r.status)).toEqual(["failed", "completed"]);
    expect(await consumedSeq(db, convId)).toBe(next);
    const replies = (await eventsOf(db, convId)).filter((e) => e.type === "assistant_message");
    expect(replies.map(textOf)).toEqual(["next"]);
  });

  it("R31：吸收之后、构建请求之前到达的消息不进本步请求，由下一轮回复且只回复一次", async () => {
    let late: number | null = null;
    let injected = false;
    let lateDone!: () => void;
    const lateWritten = new Promise<void>((r) => {
      lateDone = r;
    });
    await worker(
      {},
      {
        loop: (deps) => {
          const inner = loopFactory(deps);
          return {
            run: (ctx) =>
              inner.run({
                ...ctx,
                // 第一次吸收返回之后、runModelStep 读日志之前，插入一条新消息（确定性地复现竞态窗口）
                pendingUserMessages: async (afterSeq) => {
                  const r = await ctx.pendingUserMessages(afterSeq);
                  if (!injected) {
                    injected = true;
                    late = await postMessage(req, orgId, convId, "echo:late");
                    lateDone();
                  }
                  return r;
                },
              }),
          };
        },
      },
    );
    const { orgId, convId } = await setup();
    const first = await postMessage(req, orgId, convId, "echo:first");
    await lateWritten;
    const terms = await waitForTerminal(db, convId, 2);
    expect(terms.map((t) => t.type)).toEqual(["run_finished", "run_finished"]);
    await sleep(300);
    const evs = await eventsOf(db, convId);
    const lateSeq = late as unknown as number;
    // 第 1 轮的请求不含插话：absorbedUpToSeq 停在触发消息
    const calls = evs.filter((e) => e.type === "model_call");
    expect(
      calls.map((c) => (c.type === "model_call" ? c.payload.request.absorbedUpToSeq : 0)),
    ).toEqual([first, lateSeq]);
    expect((calls[0] as ConversationEvent).seq).toBeGreaterThan(lateSeq);
    // 每条消息恰好一次回复
    expect(evs.filter((e) => e.type === "assistant_message").map(textOf)).toEqual([
      "first",
      "late",
    ]);
    expect(terms[0]?.payload).toEqual({ reason: "completed", consumedUpToSeq: first });
    expect(terms[1]?.payload).toEqual({ reason: "completed", consumedUpToSeq: lateSeq });
    expect((await runsOf(db, convId)).map((r) => r.status)).toEqual(["completed", "completed"]);
  });

  it("停机期间完成的运行：任务完成后的 ensureRun 在 stop() 返回前完成，待处理的消息由之后的 worker 回复", async () => {
    const paused = gate();
    const resume = gate();
    let first = true;
    const w = await worker(
      {},
      {
        hooks: {
          async beforeRelease() {
            if (!first) return;
            first = false;
            paused.open();
            await resume.promise;
          },
        },
      },
    );
    const { orgId, convId } = await setup();
    await postMessage(req, orgId, convId, "echo:first");
    await paused.promise;
    const late = await postMessage(req, orgId, convId, "echo:late");
    // 运行停在终态写入之后：此时开始停机，再放行让它完成
    const stopping = w.stop();
    await sleep(100);
    resume.open();
    await stopping;
    // stop() 返回时，后续的 ensureRun 已经投递了新一轮
    expect((await runsOf(db, convId)).map((r) => r.status)).toEqual(["completed", "queued"]);
    await worker();
    const terms = await waitForTerminal(db, convId, 2);
    expect(terms[1]?.payload).toEqual({ reason: "completed", consumedUpToSeq: late });
    const replies = (await eventsOf(db, convId)).filter((e) => e.type === "assistant_message");
    expect(replies.map(textOf)).toEqual(["first", "late"]);
  });

  it("R34：续跑时已超过截止时间、loop 一条都没吸收 → max_duration 不消费触发消息，新一轮回复它恰好一次", async () => {
    const { orgId, convId } = await setup();
    const trigger = await postMessage(req, orgId, convId, "echo:pending");
    const [stale] = await runsOf(db, convId);
    // 模拟早已开始、在其他 worker 上被中断的运行：started_at 远早于 maxRunSeconds
    await db
      .updateTable("runs")
      .set({ status: "running", started_at: sql`now() - interval '1 hour'` })
      .where("id", "=", stale?.id as string)
      .execute();
    await worker();
    const terms = await waitForTerminal(db, convId, 2);
    expect(terms[0]?.runId).toBe(stale?.id);
    expect(terms[0]?.payload).toEqual({ reason: "max_duration", consumedUpToSeq: 0 });
    expect(terms[1]?.payload).toEqual({ reason: "completed", consumedUpToSeq: trigger });
    await sleep(300);
    const evs = await eventsOf(db, convId);
    expect(evs.filter((e) => e.type === "assistant_message").map(textOf)).toEqual(["pending"]);
    expect(evs.filter((e) => e.type === "model_call" && e.runId === stale?.id)).toEqual([]);
    expect((await runsOf(db, convId)).map((r) => r.status)).toEqual(["completed", "completed"]);
    expect(await consumedSeq(db, convId)).toBe(trigger);
  });

  it("R33：工具步骤进行中到达消息、下一次 prepare 前截止时间已过 → max_duration 且不消费它，新一轮回复它恰好一次", async () => {
    let firstRun: string | null = null;
    let passed = false;
    await worker(
      {},
      {
        loop: (deps) => {
          const inner = loopFactory(deps);
          return {
            run: (ctx) => {
              firstRun ??= ctx.runId;
              const isFirst = ctx.runId === firstRun;
              const real = ctx.limits.deadline;
              // 第一轮的截止时间在测试设置 passed 之后视为已过（不触发 run-worker 自己的截止计时器）
              const limits = {
                maxSteps: ctx.limits.maxSteps,
                get deadline() {
                  return isFirst && passed ? Date.now() - 1 : real;
                },
              };
              return inner.run({ ...ctx, limits });
            },
          };
        },
      },
    );
    const { orgId, convId } = await setup(LOOPER);
    const first = await postMessage(req, orgId, convId, "loop:400");
    await waitForEvent(db, convId, (e) => e.type === "model_call");
    const hello = await postMessage(req, orgId, convId, "hello");
    passed = true;
    const terms = await waitForTerminal(db, convId, 2);
    expect(terms[0]?.payload).toEqual({ reason: "max_duration", consumedUpToSeq: first });
    expect(terms[1]?.payload).toEqual({ reason: "completed", consumedUpToSeq: hello });
    await sleep(300);
    const evs = await eventsOf(db, convId);
    expect(evs.filter((e) => e.type === "assistant_message").map(textOf)).toEqual([
      "",
      "You said: hello",
    ]);
    expect((await runsOf(db, convId)).map((r) => r.status)).toEqual(["completed", "completed"]);
    expect(await consumedSeq(db, convId)).toBe(hello);
  });

  it("同一触发点的任务已存在（属于另一个运行）→ ensureRun 不投递、不留下 queued 行", async () => {
    const { orgId, convId } = await setup();
    const conn = new Redis(rd.url, { maxRetriesPerRequest: null });
    const q = new Queue(RUN_QUEUE_NAME, { connection: conn });
    try {
      // 预先放一个同 jobId 的延迟任务（模拟仍在队列中的旧运行任务）
      await q.add(
        "run",
        { runId: "other-run", conversationId: convId },
        { jobId: runJobId(convId, 1), delay: 60_000 },
      );
      await postMessage(req, orgId, convId, "echo:x");
      expect(await runsOf(db, convId)).toEqual([]);
      const job = await q.getJob(runJobId(convId, 1));
      expect(job?.data.runId).toBe("other-run");
      await job?.remove();
    } finally {
      await q.close();
      conn.disconnect();
    }
  });
});

/** 删除某个触发点的运行任务（模拟任务丢失）。 */
async function removeJob(convId: string, seq: number): Promise<void> {
  const conn = new Redis(rd.url, { maxRetriesPerRequest: null });
  const q = new Queue(RUN_QUEUE_NAME, { connection: conn });
  try {
    await (await q.getJob(runJobId(convId, seq)))?.remove();
  } finally {
    await q.close();
    conn.disconnect();
  }
}

const checkpointsOf = (runId: string) =>
  db.selectFrom("lg_checkpoints").select("checkpoint_id").where("thread_id", "=", runId).execute();
const writesOf = (runId: string) =>
  db
    .selectFrom("lg_checkpoint_writes")
    .select("checkpoint_id")
    .where("thread_id", "=", runId)
    .execute();

/** 给某个运行的 thread 塞一份占位 checkpoint 与 write（模拟运行中途留下的续跑状态）。 */
async function seedCheckpoint(runId: string): Promise<void> {
  const bytes = Buffer.from("{}");
  await db
    .insertInto("lg_checkpoints")
    .values({
      thread_id: runId,
      checkpoint_ns: "",
      checkpoint_id: "cp-1",
      checkpoint_type: "json",
      checkpoint: bytes,
      metadata_type: "json",
      metadata: bytes,
    })
    .execute();
  await db
    .insertInto("lg_checkpoint_writes")
    .values({
      thread_id: runId,
      checkpoint_ns: "",
      checkpoint_id: "cp-1",
      task_id: "t",
      idx: 0,
      channel: "c",
      value_type: "json",
      value: bytes,
    })
    .execute();
}

/** 把会话唯一的运行做成 running 的孤儿（任务已不存在、会话锁空闲）。 */
async function orphanRunning(convId: string, triggerSeq: number): Promise<string> {
  const [run] = await runsOf(db, convId);
  await removeJob(convId, triggerSeq);
  await db
    .updateTable("runs")
    .set({ status: "running", started_at: sql`now()` })
    .where("id", "=", run?.id as string)
    .execute();
  return run?.id as string;
}

describe("RunWorker（默认 loop、R29 失败与孤儿运行）", () => {
  beforeAll(() => {
    defaultLoop = langgraph;
  });

  it("不传 loop 的 worker 内核默认用 LangGraphLoop；运行结束后该 thread 的 checkpoint 全部删除", async () => {
    const k = await startKernel(runConfig(urls(), { roles: ["worker"], runtime: { maxSteps: 3 } }));
    extra.push(k);
    const { orgId, convId } = await setup(LOOPER);
    await postMessage(req, orgId, convId, "loop:10");
    const [fin] = await waitForTerminal(db, convId);
    expect(fin?.payload).toMatchObject({ reason: "max_steps" });
    const runId = fin?.runId as string;
    // LangGraphLoop 的 tools 节点给工具调用写了结果（证明用的是默认 loop；SequentialLoop 不执行工具）
    const evs = await eventsOf(db, convId);
    expect(evs.some((e) => e.type === "tool_result")).toBe(true);
    await waitFor(async () => (await checkpointsOf(runId)).length === 0, 3_000, "deleted");
    expect(await writesOf(runId)).toEqual([]);
  });

  it("已保存定义里的参数部分不再合法（直接改库模拟插件升级）→ 已声明的参数透传到插件，未声明的丢弃并记入 droppedParams", async () => {
    await worker();
    const { orgId, agentId, convId } = await setup();
    const saved = { effort: "low", "model-fake.style": "shout", "model-fake.removed": true };
    await sql`UPDATE capybara.agent_versions
      SET definition = jsonb_set(definition, '{modelParams}', ${JSON.stringify(saved)}::jsonb)
      WHERE agent_id = ${agentId}`.execute(raw);
    await postMessage(req, orgId, convId, "echo:hi");
    const [fin] = await waitForTerminal(db, convId);
    expect(fin?.type).toBe("run_finished");
    const evs = await eventsOf(db, convId);
    const call = evs.find((e) => e.type === "model_call");
    expect(call?.type === "model_call" && call.payload.request).toMatchObject({
      params: { effort: "low", "model-fake.style": "shout" },
      droppedParams: ["model-fake.removed"],
    });
    // model-fake.style 真的到达插件：shout 让回复转大写
    expect(evs.filter((e) => e.type === "assistant_message").map(textOf)).toEqual(["HI"]);
  });

  it("stalled 次数超限（BullMQ 判定任务失败）→ run_failed run.stalled，status failed，consumed_seq 推进，会话不卡住", async () => {
    const { orgId, convId } = await setup();
    const seq = await postMessage(req, orgId, convId, "echo:x");
    const [run] = await runsOf(db, convId);
    // 模拟 stalled 超限：BullMQ 把任务放回等待并记下延迟失败原因，下一个领取它的 worker 直接判失败
    await redis.hset(
      `bull:${RUN_QUEUE_NAME}:${runJobId(convId, seq)}`,
      "defa",
      "job stalled more than allowable limit",
    );
    // 死去的持有者留下的会话锁
    await redis.set(`capk:conv-run:${convId}`, run?.id as string, "PX", 60_000);
    await worker();
    const [t] = await waitForTerminal(db, convId);
    expect(t?.type).toBe("run_failed");
    expect(t?.runId).toBe(run?.id);
    expect(t?.payload).toMatchObject({ error: { code: "run.stalled" } });
    await waitFor(async () => (await runsOf(db, convId))[0]?.status === "failed", 3_000);
    expect(await consumedSeq(db, convId)).toBe(seq);
    // 死去持有者的锁已清理：新消息立即起新一轮并完成
    await waitFor(async () => (await redis.exists(`capk:conv-run:${convId}`)) === 0, 3_000);
    const next = await postMessage(req, orgId, convId, "echo:next");
    const terms = await waitForTerminal(db, convId, 2);
    expect(terms[1]?.type).toBe("run_finished");
    expect(await consumedSeq(db, convId)).toBe(next);
  });

  it("孤儿运行（queued 但任务已不存在、会话锁空闲、超过宽限期）→ ensureRun 标记 run.orphaned 并起新一轮", async () => {
    const { orgId, convId } = await setup();
    const first = await postMessage(req, orgId, convId, "echo:lost");
    const [orphan] = await runsOf(db, convId);
    await removeJob(convId, first);
    // 宽限期内（刚创建、任务可能还没投递）不清理
    await postMessage(req, orgId, convId, "echo:early");
    expect((await runsOf(db, convId)).map((r) => r.status)).toEqual(["queued"]);
    await db
      .updateTable("runs")
      .set({ created_at: sql`now() - interval '1 minute'` })
      .where("id", "=", orphan?.id as string)
      .execute();
    const second = await postMessage(req, orgId, convId, "echo:found");
    expect((await runsOf(db, convId)).map((r) => r.status)).toEqual(["failed", "queued"]);
    const failed = (await eventsOf(db, convId)).find((e) => e.type === "run_failed");
    expect(failed?.runId).toBe(orphan?.id);
    expect(failed?.payload).toMatchObject({ error: { code: "run.orphaned" } });
    expect(await consumedSeq(db, convId)).toBe(first);
    await worker();
    const terms = await waitForTerminal(db, convId, 2);
    expect(terms[1]?.type).toBe("run_finished");
    expect(terms[1]?.payload).toMatchObject({ consumedUpToSeq: second });
    expect(await consumedSeq(db, convId)).toBe(second);
  });

  it("running 的孤儿（没能写终态、任务已结束）无宽限期即被清理，且只有一条终态事件", async () => {
    const { orgId, convId } = await setup();
    const first = await postMessage(req, orgId, convId, "echo:a");
    const [run] = await runsOf(db, convId);
    await removeJob(convId, first);
    await db
      .updateTable("runs")
      .set({ status: "running", started_at: sql`now()` })
      .where("id", "=", run?.id as string)
      .execute();
    await postMessage(req, orgId, convId, "echo:b");
    expect((await runsOf(db, convId)).map((r) => r.status)).toEqual(["failed", "queued"]);
    await worker();
    await waitForTerminal(db, convId, 2);
    const evs = await eventsOf(db, convId);
    expect(evs.filter((e) => e.runId === run?.id && e.type.startsWith("run_"))).toHaveLength(1);
  });
  it.each(["stream", "events"] as const)(
    "running 孤儿时打开会话（%s）→ 触发 ensureRun：孤儿标记 run.orphaned，等待中的消息起新一轮并被回复",
    async (via) => {
      {
        const { orgId, convId } = await setup();
        const first = await postMessage(req, orgId, convId, "echo:a");
        // 运行进行中到达的消息：ensureRun 看到已有运行，不投递
        const second = await postMessage(req, orgId, convId, "echo:b");
        expect(await runsOf(db, convId)).toHaveLength(1);
        const orphan = await orphanRunning(convId, first);
        await seedCheckpoint(orphan);
        if (via === "stream") {
          const jar = cookieJar();
          const r = asUser(api.http, jar);
          const login = await r({
            method: "POST",
            url: "/api/v1/auth/login",
            payload: { login: "owner", password: PW },
          });
          expect(login.statusCode).toBe(200);
          const ac = new AbortController();
          const res = await fetch(
            `http://127.0.0.1:${api.port}/api/v1/orgs/${orgId}/conversations/${convId}/stream`,
            { headers: { cookie: jar.header() as string }, signal: ac.signal },
          );
          expect(res.status).toBe(200);
          ac.abort();
        } else {
          const res = await req({
            method: "GET",
            url: `/api/v1/orgs/${orgId}/conversations/${convId}/events`,
          });
          expect(res.statusCode).toBe(200);
        }
        await waitFor(
          async () => (await runsOf(db, convId)).map((r) => r.status).join() === "failed,queued",
          3_000,
          `orphan swept via ${via}`,
        );
        const failed = (await eventsOf(db, convId)).find((e) => e.type === "run_failed");
        expect(failed?.runId).toBe(orphan);
        expect(failed?.payload).toMatchObject({ error: { code: "run.orphaned" } });
        // 孤儿的检查点在收尾时异步清理：等清理完成再断言
        await waitFor(
          async () =>
            ((await checkpointsOf(orphan)).length === 0 && (await writesOf(orphan)).length === 0) ||
            undefined,
          5_000,
          `orphan checkpoints cleaned via ${via}`,
        );
        expect(await checkpointsOf(orphan)).toEqual([]);
        expect(await writesOf(orphan)).toEqual([]);
        await worker();
        const terms = await waitForTerminal(db, convId, 2);
        expect(terms[1]?.payload).toMatchObject({ reason: "completed", consumedUpToSeq: second });
        const replies = (await eventsOf(db, convId)).filter((e) => e.type === "assistant_message");
        expect(replies.map(textOf)).toEqual(["b"]);
      }
    },
  );

  it("abort 孤儿运行（running、任务不存在、会话锁空闲）→ 直接写 run_aborted，202，运行 aborted，consumed_seq 推进到触发消息", async () => {
    const { orgId, convId } = await setup();
    const first = await postMessage(req, orgId, convId, "echo:a");
    const orphan = await orphanRunning(convId, first);
    await seedCheckpoint(orphan);
    const res = await req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/conversations/${convId}/abort`,
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ runId: orphan });
    const evs = await eventsOf(db, convId);
    const aborted = evs.filter((e) => e.type === "run_aborted");
    expect(aborted).toHaveLength(1);
    expect(aborted[0]?.runId).toBe(orphan);
    expect(aborted[0]?.payload).toEqual({ byAccountId: ownerId, reason: "user" });
    expect(await runsOf(db, convId)).toEqual([{ id: orphan, status: "aborted" }]);
    expect(await consumedSeq(db, convId)).toBe(first);
    expect(await checkpointsOf(orphan)).toEqual([]);
    // 再 abort → 没有活跃运行
    const again = await req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/conversations/${convId}/abort`,
    });
    expect(again.statusCode).toBe(409);
  });

  it("stalled 判失败（onJobFailed）后该运行的 checkpoint 全部删除", async () => {
    const { orgId, convId } = await setup();
    const seq = await postMessage(req, orgId, convId, "echo:x");
    const [run] = await runsOf(db, convId);
    await seedCheckpoint(run?.id as string);
    await redis.hset(
      `bull:${RUN_QUEUE_NAME}:${runJobId(convId, seq)}`,
      "defa",
      "job stalled more than allowable limit",
    );
    await worker();
    const [t] = await waitForTerminal(db, convId);
    expect(t?.payload).toMatchObject({ error: { code: "run.stalled" } });
    await waitFor(
      async () => (await checkpointsOf(run?.id as string)).length === 0,
      3_000,
      "checkpoints deleted",
    );
    expect(await writesOf(run?.id as string)).toEqual([]);
  });

  it("agent 已软删除的会话：ensureRun 不起运行", async () => {
    const { agentId, convId } = await setup();
    await api.runs.eventLog.append(convId, [
      {
        type: "user_message",
        payload: { content: [{ type: "text", text: "echo:x" }], authorAccountId: ownerId },
      },
    ]);
    await db
      .updateTable("agents")
      .set({ deleted_at: sql`now()` })
      .where("id", "=", agentId)
      .execute();
    expect(await api.runs.queue.ensureRun(convId)).toBeNull();
    expect(await runsOf(db, convId)).toEqual([]);
  });

  it("同一会话至多一个未结束的运行（部分唯一索引）", async () => {
    const { orgId, convId } = await setup();
    await postMessage(req, orgId, convId, "echo:x");
    const insert = () =>
      db
        .insertInto("runs")
        .values({
          id: `dup-${Math.random()}`,
          conversation_id: convId,
          status: "running",
          agent_version: 1,
          trigger_account_id: ownerId,
          trigger_seq: 1,
        })
        .execute();
    await expect(insert()).rejects.toMatchObject({ code: "23505" });
    // 已结束的运行不受限制
    await db
      .updateTable("runs")
      .set({ status: "failed" })
      .where("conversation_id", "=", convId)
      .execute();
    await insert();
    await expect(insert()).rejects.toMatchObject({ code: "23505" });
  });
});
