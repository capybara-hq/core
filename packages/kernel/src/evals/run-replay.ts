import { randomUUID } from "node:crypto";
import {
  type ContentBlock,
  type Logger,
  ModelError,
  type ModelProvider,
  type ModelRequest,
  type ModelStreamEvent,
  type ModelUsage,
  type StopReason,
} from "@capybara-hq/plugin-sdk";
import type { KernelConfig } from "../config/schema.js";
import type { EventLog } from "../conversations/event-log.js";
import type { ConversationEvent } from "../conversations/events.js";
import type { KernelDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import type { KyselyCheckpointSaver } from "../runtime/checkpointer.js";
import { estimateTokens } from "../runtime/context/tokens.js";
import type { LoopDeps } from "../runtime/langgraph-loop.js";
import type { AgentLoop, LoopOutcome } from "../runtime/loop.js";
import { type MediaSourceDeps, RunError } from "../runtime/model-call.js";
import type { ProviderRegistry } from "../runtime/providers.js";
import { finishRun } from "../runtime/run-finish.js";
import { skillsCatalogIdemKey } from "../skills/catalog.js";
import {
  ACTIVE_EVAL_STATUSES,
  addUsage,
  consumeTokens,
  TOO_MANY_ERRORS,
  usageTokens,
} from "./budget.js";
import { RecordedToolPipeline, recordedCalls } from "./recorded-tools.js";
import type { CaseSnapshot, SnapshotEvent } from "./snapshot.js";
import type { ResolvedCandidate } from "./step-replay.js";

/**
 * 整轮回放（D2 / C6）：在 `kind = 'eval'` 的隐藏对话里跑**同一个** `LangGraphLoop`，工具管线换成
 * {@link RecordedToolPipeline}（只回放记录的结果，不执行任何工具、沙箱、应用或审批）。
 *
 * - 种子：原运行 `run_started` 之前的事件按原 seq 插入（`last_seq` 停在其前一位，新的 `run_started` 因此与原来同 seq），
 *   原运行开始时的 `skills_catalog` 照抄；然后写 `runs` 行与 `run_started`，`agent` 用候选定义。
 * - 插话：原运行中途吸收的 user_message，在「原吸收步骤 ≤ 当前步骤」时追加进评测对话并交给 loop。
 * - 计费（C7，与单步回放同一套）：每次模型请求（含压缩、重试、兜底）发出前查运行仍在执行、仍持有认领；
 *   收完按真实用量、没收完按估算 `consumeTokens`（越限即 `capped`，下一次请求前停下）。
 * - 附件按快照自己的组织与原对话取（C3）。
 * 崩溃后由调用方删掉旧的评测对话（{@link deleteEvalConversation}），从头重跑。
 */

export interface RunReplayResult {
  conversationId: string;
  outcome: LoopOutcome["kind"];
  toolCalls: { name: string; input: unknown }[];
  finalContent: ContentBlock[];
  stopReason: StopReason | null;
  usage: ModelUsage;
  steps: number;
  unmatched: number;
}

/** 原运行（基线）的同形摘要。 */
export type RunBaseline = Omit<RunReplayResult, "conversationId" | "outcome" | "unmatched">;

/** 测试钩子。 */
export interface EvalReplayHooks {
  /** 种子已写入（评测对话已记到结果上）、loop 开始之前调用：抛错即模拟此时崩溃。 */
  afterRunSeeded?(evalRunId: string, conversationId: string): Promise<void>;
}

export interface RunReplayDeps {
  db: KernelDb;
  eventLog: EventLog;
  config: () => KernelConfig;
  log: Logger;
  registry: Pick<ProviderRegistry, "resolve">;
  media?: MediaSourceDeps;
  checkpoints?: Pick<KyselyCheckpointSaver, "deleteThread">;
  /**
   * 构建评测用的 loop：与运行时同一个 `LangGraphLoop`（同一工厂），只换掉工具管线、模型注册表（计费）与附件来源。
   */
  loop(d: Pick<LoopDeps, "toolPipeline" | "registry" | "media">): AgentLoop;
  /** 本次执行是否仍持有结果的认领（失去认领 → 不再发请求）；不给 = 不检查。 */
  stillClaimed?: () => Promise<boolean>;
  /**
   * 种子事务内调用：把评测对话记到结果上（以认领为条件）。返回 false = 已失去认领，种子回滚、抛 {@link ReplayClaimLost}。
   */
  onSeeded?: (trx: KernelDb, conversationId: string) => Promise<boolean>;
  hooks?: EvalReplayHooks;
}

/** 写种子时发现已失去认领或运行已不在执行：本次执行停下，不留评测对话。 */
export class ReplayClaimLost extends Error {
  constructor() {
    super("the eval result is no longer claimed by this execution");
    this.name = "ReplayClaimLost";
  }
}

/** 整轮回放被停下的原因（`run_aborted.detail`）。 */
export type StopDetail = "cancelled" | "capped" | "too_many_errors" | "claim_lost" | "shutdown";

/** 运行不再执行或失去认领时的原因；还能继续为 null。 */
async function stopReason(
  db: KernelDb,
  evalRunId: string,
  stillClaimed: (() => Promise<boolean>) | undefined,
): Promise<StopDetail | null> {
  const r = await db
    .selectFrom("eval_runs")
    .select(["status", "error"])
    .where("id", "=", evalRunId)
    .executeTakeFirst();
  if (!r) return "cancelled";
  if (r.status === "capped") return "capped";
  if (r.status === "cancelled") return "cancelled";
  if (r.status === "failed") {
    return (r.error as { code?: string } | null)?.code === TOO_MANY_ERRORS.code
      ? "too_many_errors"
      : "cancelled";
  }
  if (!(ACTIVE_EVAL_STATUSES as readonly string[]).includes(r.status)) return "cancelled";
  if (stillClaimed && !(await stillClaimed())) return "claim_lost";
  return null;
}

/** 种子插入的分批大小。 */
const SEED_BATCH = 500;
const READ_PAGE = 1000;

const ZERO: ModelUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

type Ev = { seq: number; type: string; runId: string | null; payload: unknown };

/** 一次运行的工具调用序列、最后的回复、停止原因、用量与步数（基线与候选同一算法）。 */
function summarize(events: readonly Ev[], runId: string): RunBaseline {
  const toolCalls: { name: string; input: unknown }[] = [];
  let usage = ZERO;
  let last: { content: ContentBlock[]; stopReason: string } | null = null;
  const steps = new Set<number>();
  for (const e of events) {
    if (e.runId !== runId) continue;
    if (e.type === "assistant_message") {
      const p = e.payload as { step: number; content: ContentBlock[]; stopReason: string };
      steps.add(p.step);
      for (const b of p.content) {
        if (b.type === "tool_call") toolCalls.push({ name: b.name, input: b.input });
      }
      last = { content: p.content, stopReason: p.stopReason };
    } else if (e.type === "usage") {
      const u = e.payload as Partial<ModelUsage>;
      usage = addUsage(usage, {
        inputTokens: u.inputTokens ?? 0,
        outputTokens: u.outputTokens ?? 0,
        cacheReadTokens: u.cacheReadTokens ?? 0,
        cacheWriteTokens: u.cacheWriteTokens ?? 0,
      });
    }
  }
  return {
    toolCalls,
    finalContent: last?.content ?? [],
    stopReason:
      last === null || last.stopReason === "aborted" ? null : (last.stopReason as StopReason),
    usage,
    steps: steps.size,
  };
}

/** 原运行（快照）的摘要，作为整轮回放的基线。 */
export function runBaseline(s: CaseSnapshot): RunBaseline {
  return summarize(s.events, s.runId);
}

/**
 * 删掉一个评测对话（崩溃重跑前清掉上一次的残留）：先删它各次运行的 checkpoint，再删对话（事件、运行随之级联删除）。
 * 只删 `kind = 'eval'` 的对话。
 */
export async function deleteEvalConversation(
  d: Pick<RunReplayDeps, "db" | "checkpoints">,
  conversationId: string,
): Promise<void> {
  const runs = await d.db
    .selectFrom("runs")
    .innerJoin("conversations", "conversations.id", "runs.conversation_id")
    .select("runs.id")
    .where("runs.conversation_id", "=", conversationId)
    .where("conversations.kind", "=", "eval")
    .execute();
  for (const r of runs) await d.checkpoints?.deleteThread(r.id);
  await d.db
    .deleteFrom("conversations")
    .where("id", "=", conversationId)
    .where("kind", "=", "eval")
    .execute();
}

/**
 * 原运行每步开始时吸收到的位置（第一次尝试的 `absorbedUpToSeq`；较早的事件没有时取该 model_call 的 seq）。
 */
function absorbedByStep(s: CaseSnapshot): Map<number, number> {
  const out = new Map<number, number>();
  for (const e of s.events) {
    if (e.runId !== s.runId || e.type !== "model_call") continue;
    const p = e.payload as { step: number; request?: { absorbedUpToSeq?: number } };
    if (out.has(p.step)) continue;
    out.set(p.step, p.request?.absorbedUpToSeq ?? e.seq);
  }
  return out;
}

const readAll = async (
  eventLog: EventLog,
  conversationId: string,
): Promise<ConversationEvent[]> => {
  const out: ConversationEvent[] = [];
  let after = 0;
  for (;;) {
    const page = await eventLog.readAfter(conversationId, after, READ_PAGE);
    out.push(...page);
    const last = page.at(-1);
    if (page.length < READ_PAGE || !last) return out;
    after = last.seq;
  }
};

/** 整轮回放一个用例。见文件头注释。 */
export async function replayRun(
  d: RunReplayDeps,
  s: CaseSnapshot,
  candidate: ResolvedCandidate,
  evalRunId: string,
  signal: AbortSignal,
): Promise<RunReplayResult> {
  const { db, eventLog } = d;
  const start = s.events.find((e) => e.runId === s.runId && e.type === "run_started");
  if (!start) {
    throw new ApiError("eval.call_not_found", "The snapshot does not contain the run's start");
  }
  const run = await db
    .selectFrom("eval_runs")
    .select("created_by")
    .where("id", "=", evalRunId)
    .executeTakeFirstOrThrow();
  const accountId = run.created_by;
  const R = start.seq;
  const seeds = s.events.filter((e) => e.seq < R);
  // 原运行开始时会话的 consumed_seq：此前最近一次正常结束记下的位置（失败 / 中止的终态不带位置，取不到时为 0）
  let consumed = 0;
  for (const e of seeds) {
    if (e.type === "run_finished") {
      consumed = Math.max(consumed, (e.payload as { consumedUpToSeq: number }).consumedUpToSeq);
    }
  }
  const trigger = seeds.findLast((e) => e.type === "user_message")?.seq ?? 0;
  const catalog = s.events.find(
    (e) => e.runId === s.runId && e.type === "skills_catalog" && e.seq > R,
  );

  const conversationId = randomUUID();
  const runId = randomUUID();
  await db.transaction().execute(async (t) => {
    // 运行行加共享锁并复核仍在执行：与取消 / 删除评测集（UPDATE 持行锁）互斥，删除之后不会再长出评测对话
    const live = await t
      .selectFrom("eval_runs")
      .select("id")
      .where("id", "=", evalRunId)
      .where("status", "in", [...ACTIVE_EVAL_STATUSES])
      .forShare()
      .executeTakeFirst();
    if (!live) throw new ReplayClaimLost();
    await t
      .insertInto("conversations")
      .values({
        id: conversationId,
        org_id: s.orgId,
        agent_id: s.agentId,
        account_id: accountId,
        last_seq: R - 1,
        consumed_seq: consumed,
        kind: "eval",
        eval_run_id: evalRunId,
      })
      .execute();
    for (let i = 0; i < seeds.length; i += SEED_BATCH) {
      await t
        .insertInto("conversation_events")
        .values(
          seeds.slice(i, i + SEED_BATCH).map((e: SnapshotEvent) => ({
            conversation_id: conversationId,
            seq: e.seq,
            type: e.type,
            run_id: e.runId,
            idem_key: null,
            payload: JSON.stringify(e.payload),
            created_at: new Date(e.createdAt),
          })),
        )
        .execute();
    }
    await t
      .insertInto("runs")
      .values({
        id: runId,
        conversation_id: conversationId,
        status: "running",
        agent_version: candidate.agentVersion,
        trigger_account_id: accountId,
        trigger_seq: trigger,
        started_at: new Date(),
      })
      .execute();
    await eventLog.append(
      conversationId,
      [
        {
          type: "run_started",
          runId,
          idemKey: `run_started:${runId}`,
          payload: {
            agentVersion: candidate.agentVersion,
            model: candidate.definition.model,
            triggerAccountId: accountId,
          },
        },
        ...(catalog
          ? [
              {
                type: "skills_catalog" as const,
                runId,
                idemKey: skillsCatalogIdemKey(runId),
                payload: catalog.payload,
              },
            ]
          : []),
      ],
      t,
    );
    if (d.onSeeded && !(await d.onSeeded(t, conversationId))) throw new ReplayClaimLost();
  });
  await d.hooks?.afterRunSeeded?.(evalRunId, conversationId);

  // 停止：取消 / 越限 / 熔断 / 失去认领 / 截止时间 → 中止 loop（进行中的请求立即停下，loop 以 aborted 返回）
  const stopper = new AbortController();
  const loopSignal = AbortSignal.any([signal, stopper.signal]);
  /** 为什么停下（写进 `run_aborted.detail`，轨迹据此说明原因）。 */
  let stopped: StopDetail | undefined;
  /**
   * 检查与计费过程中的意外错误（PG 暂时故障等）：记下并中止 loop，loop 返回后按崩溃抛出
   * （交给 BullMQ 重试、从头重跑），不让它在模型调用里被当成供应商错误、走降级梯子。
   */
  let crash: unknown;
  const crashed = (err: unknown) => {
    crash ??= err;
    stopper.abort();
  };
  /**
   * 还能发下一次请求吗。取消只在请求之间生效（与单步回放一致）：进行中的请求做完，之后不再发。
   */
  const allowed = async (): Promise<boolean> => {
    if (loopSignal.aborted) return false;
    const why = await stopReason(db, evalRunId, d.stillClaimed);
    if (why === null) return true;
    stopped ??= why;
    return false;
  };
  /** 同 {@link allowed}，但出错时记为崩溃（返回 false）。 */
  const allowedSafe = async (): Promise<boolean> => {
    try {
      return await allowed();
    } catch (err) {
      crashed(err);
      return false;
    }
  };
  /** 进行中的计费（提前结束的流在 finally 里计费，不阻塞调用方）；返回前等它们写完。 */
  const charges = new Set<Promise<unknown>>();
  const charge = (n: number): Promise<void> => {
    // 计费写不进去也按崩溃处理：不能让请求在预算之外继续发
    const p = consumeTokens(db, evalRunId, n).then(() => {}, crashed);
    charges.add(p);
    void p.finally(() => charges.delete(p));
    return p;
  };
  const meter = (provider: ModelProvider): ModelProvider => {
    const metered = Object.create(provider) as ModelProvider;
    metered.stream = (req: ModelRequest, opts: { signal: AbortSignal }) =>
      (async function* (): AsyncGenerator<ModelStreamEvent> {
        if (!(await allowedSafe())) {
          stopper.abort();
          throw new ModelError("aborted", "The eval run stopped before this request");
        }
        let chars = 0;
        let charged = false;
        try {
          for await (const ev of provider.stream(req, opts)) {
            if (ev.type === "message_complete") {
              charged = true;
              await charge(usageTokens(ev.usage));
            } else {
              chars += ev.text.length;
            }
            yield ev;
          }
        } finally {
          // 请求已发出但没有正常收完（出错、超时、中止）：按估算计费（与单步回放一致）
          if (!charged) {
            void charge(estimateTokens(req.messages, req.system, req.tools) + Math.ceil(chars / 4));
          }
        }
      })();
    return metered;
  };
  const registry: Pick<ProviderRegistry, "resolve"> = {
    resolve: async (ref) => {
      const r = await d.registry.resolve(ref);
      return { ...r, provider: meter(r.provider) };
    },
  };
  const media: MediaSourceDeps | undefined = d.media && {
    info: (_org, _conv, ids) => (d.media as MediaSourceDeps).info(s.orgId, s.conversationId, ids),
    fetch: (_org, _conv, ids, caps) =>
      (d.media as MediaSourceDeps).fetch(s.orgId, s.conversationId, ids, caps),
  };
  const pipeline = new RecordedToolPipeline({
    eventLog,
    recordings: recordedCalls(s),
    // 出错直接抛出：tools 节点的异常让 loop 抛出，按崩溃处理
    beforeStep: async () => {
      if (await allowed()) return "continue";
      stopper.abort();
      return "stop";
    },
  });

  // 插话：原运行开始之后到达、且被原运行某一步吸收的 user_message
  const absorbed = absorbedByStep(s);
  const stepsInOrder = [...absorbed.keys()].sort((a, b) => a - b);
  /** 第 k 步（含）之前原运行吸收到的最大位置；原运行没有模型调用时不设限。 */
  const capAt = (k: number): number => {
    const first = stepsInOrder[0];
    if (first === undefined) return Number.POSITIVE_INFINITY;
    let cap = absorbed.get(first) as number;
    for (const step of stepsInOrder)
      if (step <= k) cap = Math.max(cap, absorbed.get(step) as number);
    return cap;
  };
  const interjections = s.events
    .filter((e) => e.type === "user_message" && e.seq > R)
    .flatMap((e) => {
      const step = stepsInOrder.find((k) => (absorbed.get(k) as number) >= e.seq);
      return step === undefined ? [] : [{ event: e, step }];
    });
  /** 已追加的插话：原 seq → 评测对话里的 seq。 */
  const fed = new Map<number, number>();
  let prepared = 0;
  const pendingUserMessages = async (afterSeq: number): Promise<ConversationEvent[]> => {
    prepared++;
    // loop 的步骤从 1 起（与运行时相同），每步的 prepare 调用一次：第 n 次调用即第 n 步
    const k = prepared;
    for (const x of interjections) {
      if (x.step > k || fed.has(x.event.seq)) continue;
      const [w] = await eventLog.append(conversationId, [
        {
          type: "user_message",
          idemKey: `replay_interjection:${runId}:${x.event.seq}`,
          payload: x.event.payload,
        },
      ]);
      if (w) fed.set(x.event.seq, w.seq);
    }
    const cap = capAt(k);
    const fedSeqs = new Set(fed.values());
    const out: ConversationEvent[] = [];
    for (const e of await readAll(eventLog, conversationId)) {
      if (e.type !== "user_message" || e.seq <= afterSeq) continue;
      if (fedSeqs.has(e.seq) || (e.seq < R && e.seq <= cap)) out.push(e);
    }
    return out;
  };

  const runtime = d.config().runtime;
  const deadline = Date.now() + runtime.maxRunSeconds * 1000;
  let deadlineHit = false;
  const timer = setTimeout(
    () => {
      deadlineHit = true;
      stopper.abort();
    },
    Math.max(0, deadline - Date.now()),
  );
  timer.unref();
  const loop = d.loop({ toolPipeline: pipeline, registry, ...(media && { media }) });
  let outcome: LoopOutcome;
  try {
    outcome = await loop.run({
      orgId: s.orgId,
      conversationId,
      runId,
      agentId: s.agentId,
      triggerAccountId: accountId,
      agent: candidate.definition,
      agentVersion: candidate.agentVersion,
      signal: loopSignal,
      shutdown: new AbortController().signal,
      sink: () => {},
      pendingUserMessages,
      limits: { maxSteps: runtime.maxSteps, deadline },
    });
  } catch (e) {
    const err =
      e instanceof RunError ? e : new RunError("run.internal", "The run failed unexpectedly");
    await finishRun(db, eventLog, {
      conversationId,
      runId,
      status: "failed",
      consumed: null,
      event: { type: "run_failed", payload: { error: { code: err.code, message: err.message } } },
    }).catch((x) => d.log.warn("cannot finish eval replay run", { runId, err: x }));
    await Promise.allSettled([...charges]);
    throw crash ?? e;
  } finally {
    clearTimeout(timer);
    await d.checkpoints
      ?.deleteThread(runId)
      .catch((err) => d.log.warn("eval replay checkpoint delete failed", { runId, err }));
  }
  await Promise.allSettled([...charges]);
  if (crash !== undefined) throw crash;
  if (outcome.kind === "aborted" && deadlineHit && !signal.aborted && stopped === undefined) {
    outcome = { kind: "max_duration", consumedUpToSeq: 0 };
  }
  if (outcome.kind === "aborted" && stopped === undefined && signal.aborted) stopped = "shutdown";
  const finalConsumed = Math.max(0, ...fed.values(), trigger);
  await finishRun(db, eventLog, {
    conversationId,
    runId,
    status: outcome.kind === "aborted" ? "aborted" : "completed",
    consumed: finalConsumed,
    event:
      outcome.kind === "aborted"
        ? {
            type: "run_aborted",
            payload: {
              byAccountId: null,
              reason: "eval_stopped",
              ...(stopped !== undefined && { detail: stopped }),
            },
          }
        : {
            type: "run_finished",
            payload: {
              reason:
                outcome.kind === "max_steps" || outcome.kind === "max_duration"
                  ? outcome.kind
                  : "completed",
              consumedUpToSeq:
                "consumedUpToSeq" in outcome ? Math.max(outcome.consumedUpToSeq, trigger) : trigger,
            },
          },
  });
  await Promise.allSettled([...charges]);
  const summary = summarize(await readAll(eventLog, conversationId), runId);
  return { conversationId, outcome: outcome.kind, ...summary, unmatched: pipeline.unmatched() };
}
