import {
  type ContentBlock,
  isModelError,
  isRetryableKind,
  type Logger,
  ModelError,
  type ModelInfo,
  type ModelProvider,
  type ModelRequest,
  type ModelStreamEvent,
  type ModelUsage,
  type ParamValue,
  type StopReason,
  sanitizeParams,
} from "@capybara-hq/plugin-sdk";
import { sql } from "kysely";
import type { AgentDefinition, ModelRef } from "../agents/definition.js";
import type { KernelConfig } from "../config/schema.js";
import type { AppendEvent, EventLog } from "../conversations/event-log.js";
import { type ConversationEvent, MEDIA_EXCLUDED_MAX_IDS } from "../conversations/events.js";
import type { KernelDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { usageTokens } from "../evals/budget.js";
import { ExtensionUnloadedError } from "../extensions/inflight.js";
import { audit } from "../identity/audit.js";
import { skillLoadOffered } from "../skills/catalog.js";
import type { ToolRegistry, UnavailableTool } from "../tools/registry.js";
import { recordToolSpecs } from "../tools/specs.js";
import {
  type BuildModelRequestInput,
  buildModelRequest,
  latestSummary,
  type MediaBytes,
  type MediaInfo,
  type ModelCallMeta,
  mediaRefs,
  planMedia,
  type RequestTool,
} from "./context/build.js";
import {
  acceptSummary,
  buildCompactionRequest,
  compactionBackoff,
  compactionPlan,
  shouldCompact,
} from "./context/compaction.js";
import { guardToolPairs } from "./context/pairing.js";
import { turnLimitReminder } from "./context/reminders.js";
import { calibrate, estimateTokens } from "./context/tokens.js";
import {
  type ConversationKindForHooks,
  fireObserve,
  type HookRunner,
  hookDeniedAudit,
  hookDeniedEvent,
  hookRequestOf,
  hookScope,
  recordHookDenial,
} from "./hook-calls.js";
import type { SubagentParent } from "./loop.js";
import { MediaCache } from "./media-cache.js";
import { ProviderListError, type ProviderRegistry } from "./providers.js";
import { subagentBudgetUsedUp } from "./subagents/limits.js";
import type { UsageReporter } from "./usage-report.js";

/** 单轮收尾的尾部提醒（模型可见，英文；spec 6 轮次额度收尾）。 */
export const WRAP_UP_REMINDER =
  "Step limit reached. Do not call tools. Summarize what you found and what remains for the user.";

/** 所用模型不支持工具（`capabilities.tools` 为 false）时的提醒（模型可见，英文）。 */
export const TOOLS_UNSUPPORTED_REMINDER =
  "Tools are unavailable for this model. Answer without calling tools.";

/** 不可用工具提醒的前缀（模型可见，英文）。 */
export const TOOLS_UNAVAILABLE_PREFIX = "The following tools are unavailable in this run: ";

/** 本 run 中此前有工具不可用、现在全部恢复时的提醒（模型可见，英文）。 */
export const TOOLS_AVAILABLE_AGAIN = "All previously unavailable tools are available again.";

/** 不可用工具提醒：`The following tools are unavailable in this run: <ref> (<reason>), ...`。 */
export function toolsUnavailableReminder(unavailable: readonly UnavailableTool[]): string {
  return `${TOOLS_UNAVAILABLE_PREFIX}${unavailable.map((u) => `${u.ref} (${u.reason})`).join(", ")}`;
}

/** `run_failed` message of a model request denied by a policy hook (user-facing, never model-visible). */
const modelDeniedText = (plugin: string, reason: string) =>
  `Model request blocked by the "${plugin}" policy hook: ${reason}`;

/** 可重试错误在同一模型上重试前的默认等待（供应商未给 retryAfterMs 时）。 */
const DEFAULT_RETRY_DELAY_MS = 1000;

/**
 * 供应商建议等待（retryAfterMs）的上限。超过它就不在同一模型上等待重试，直接切兜底（没有兜底则失败），
 * 避免一次运行被「请 10 分钟后再试」之类的建议长时间挂起。
 */
const MAX_RETRY_AFTER_MS = 10_000;

/** 读事件日志的分页大小。 */
const READ_PAGE = 1000;

/** 流式增量的出口（推给前端等订阅方）；`step_reset` 表示丢弃本步已推出的增量、重新开始。 */
export type StreamSink = (delta: {
  kind: "text" | "thinking" | "step_reset";
  runId: string;
  step: number;
  text?: string;
}) => void;

export interface ModelStepDeps {
  db: KernelDb;
  eventLog: EventLog;
  registry: Pick<ProviderRegistry, "resolve">;
  /** 工具注册表：每步开始时解析 agent 引用的工具（状态可能在步骤之间变化）。 */
  tools: Pick<ToolRegistry, "forAgent">;
  config: () => KernelConfig;
  log: Logger;
  /**
   * 会话附件（构建请求时解析日志里的媒体引用；见 AttachmentsService）。未提供时媒体引用一律按「不再可用」处理。
   * 两个方法都只对「确定不存在」返回缺省 / null；暂时故障（存储不可用、网络错误）一律抛错（Ruling M4）。
   */
  media?: MediaSourceDeps;
  /**
   * Plugin hooks (`model.request` policy / observe before the call, `model.response` observe after it),
   * for every attempt of a step and for the compaction call (`purpose: "compaction"`, I-1).
   * Only chat runs get it: full-run and single-step eval replays omit it (P-18), and hooks also need
   * `conversationKind: "chat"` on the step input.
   */
  hooks?: HookRunner;
  /**
   * `usage.report` delivery (P-17): each written `usage` event is enqueued (chat runs and full-run eval
   * replays, which both log usage). `enqueue` never throws and returns at once without handlers.
   */
  usageReport?: Pick<UsageReporter, "enqueue">;
}

/** 构建请求用到的附件来源。 */
export interface MediaSourceDeps {
  /** 附件行的声明信息（只含绑定在该会话、已 ready 的；没有行的不在结果里）。 */
  info(
    orgId: string,
    conversationId: string,
    ids: readonly string[],
  ): Promise<Map<string, MediaInfo>>;
  /** 字节；对象已不在或内容被替换为 null。`caps` 里的附件只取开头若干字节（`text/*` 封顶，见 planMedia）。 */
  fetch(
    orgId: string,
    conversationId: string,
    ids: readonly string[],
    caps?: ReadonlyMap<string, number>,
  ): Promise<Map<string, MediaBytes | null>>;
}

/**
 * 取附件时存储暂时不可用（Ruling M4）：不把它当成「附件不在」发占位，而是让本次尝试按可重试错误失败
 * （`run.storage_unavailable`），走降级梯子的重试。
 */
export class MediaUnavailableError extends Error {
  constructor(cause: unknown) {
    super(
      `Attachment storage is temporarily unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = "MediaUnavailableError";
  }
}

export interface ModelStepInput {
  /** 会话所属组织（解析工具用）。 */
  orgId: string;
  conversationId: string;
  runId: string;
  step: number;
  agent: AgentDefinition;
  agentVersion: number;
  signal: AbortSignal;
  sink: StreamSink;
  /**
   * 本步开始时 loop 已吸收到的 user_message seq（R31）：seq 更大的 user_message 不进本步请求，
   * 由后续步骤吸收或触发下一轮；写入 `model_call.request.absorbedUpToSeq`，请求可由日志还原。
   */
  absorbedUpToSeq: number;
  /** 本次运行的附件字节缓存（同一次运行的各步共用，见 {@link MediaCache}）；缺省时只在本步内缓存。 */
  mediaCache?: MediaCache;
  /** Hook payload scope: the run's agent, its trigger account and the conversation kind. */
  agentId?: string;
  accountId?: string;
  /** Hooks fire for `chat` and `subagent` (never for eval replays). */
  conversationKind?: ConversationKindForHooks;
  /** A sub-agent's run: where it was dispatched from (hook payloads carry it as `parent`). */
  parent?: SubagentParent;
  /**
   * A sub-agent's run (phase C): the parent run whose `subagent_tokens_used` counts every usage
   * event this step writes (step, wrap-up and compaction calls; spec §8.3).
   */
  parentRunId?: string;
  /**
   * The run's step limit (`LoopContext.limits.maxSteps`) for the turn-limit reminder; a child's
   * may be below `runtime.maxSteps` (final review m4). Defaults to `runtime.maxSteps`.
   */
  maxSteps?: number;
}

export interface ModelStepResult {
  content: ContentBlock[];
  stopReason: StopReason | "aborted";
  /** 本步的 `assistant_message` 已存在（幂等命中），未调用模型。 */
  reused: boolean;
  aborted: boolean;
  usage: ModelUsage | null;
  /**
   * A sub-agent's step stopped before its request: the step's compaction call used up the
   * parent run's token budget (spec §8.3: at most one call over per active child). The loop ends
   * the run with `budget`.
   */
  budget?: boolean;
}

/**
 * 运行级失败：`code` 写入 `run_failed.error.code`。模型错误为 `model.<kind>`，其余为
 * `run.<reason>`（如 `run.model_unavailable`、`run.provider_unavailable`、`run.provider_error`）。
 */
export class RunError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RunError";
  }
}

/** 幂等键。`usage` 与 `assistant_message` 同批写入，带键保证重放时不重复记账。 */
/** 某步 assistant_message 的幂等键（tools 节点据此找到本步的工具调用）。 */
export const assistantIdemKey = (runId: string, step: number): string =>
  `assistant:${runId}:${step}`;

/** 某步第 attempt 次模型调用的 model_call 幂等键（管线据此找到模型实际收到的工具）。 */
export const modelCallIdemKey = (runId: string, step: number, attempt: number): string =>
  `model_call:${runId}:${step}:${attempt}`;

/** 一步最多的模型调用尝试次数（主模型、同模型重试、兜底，见 `ladder`）。 */
export const MAX_MODEL_ATTEMPTS = 3;

/** 本步解析出的工具与是否启用 tool_search（见 `ToolRegistry.forAgent`），以及本步已取的附件字节。 */
interface StepTools {
  list: RequestTool[];
  toolSearch: boolean;
  /** 本步已取到的附件信息与字节；同一步的多次构建（压缩估算、各次尝试）共用。只缓存成功的结果。 */
  media: StepMedia;
}

/**
 * 本步的附件缓存：`looked` 是已查过行的 id（没有行的不在 `info` 里）；`run` 是本次运行的字节缓存
 * （跨步复用，键含 etag）。
 */
interface StepMedia {
  looked: Set<string>;
  info: Map<string, MediaInfo>;
  bytes: Map<string, MediaBytes | null>;
  run: MediaCache;
}

const idem = {
  assistant: assistantIdemKey,
  usage: (runId: string, step: number) => `usage:${runId}:${step}`,
  reminder: (runId: string, step: number) => `reminder:${runId}:${step}`,
  toolsUnavailable: (runId: string, step: number) => `tools_unavailable:${runId}:${step}`,
  toolsUnsupported: (runId: string, step: number) => `tools_unsupported:${runId}:${step}`,
  modelCall: modelCallIdemKey,
  hookDenied: (runId: string, step: number, attempt: number) =>
    `hook_denied:${runId}:${step}:${attempt}`,
  /** Usage of a compaction call: `n` is the compaction attempt (consecutive failures + 1). */
  compactionUsage: (runId: string, step: number, n: number) =>
    `usage_compaction:${runId}:${step}:${n}`,
  mediaExcluded: (runId: string, step: number, attempt: number, part: number) =>
    `media_excluded:${runId}:${step}:${attempt}:${part}`,
};

/** 外部 signal 已触发：本步按「中止」收尾。 */
class StepAborted extends Error {
  constructor() {
    super("model step aborted");
    this.name = "StepAborted";
  }
}

/** 一次尝试的失败分类。 */
interface Failure {
  retryable: boolean;
  code: string;
  message: string;
  retryAfterMs: number | undefined;
}

/** 一次模型流的结果（{@link consumeModelStream}）。 */
export interface StreamOutcome {
  content: ContentBlock[];
  stopReason: StopReason;
  usage: ModelUsage;
}

type Runtime = KernelConfig["runtime"];

/**
 * 一步模型调用：幂等 → 读日志 → 压缩 → 尾部提醒 → 构建请求 → 流式（看门狗）→ 降级梯子 → 写事件。
 * 模型看到的一切先写进日志（`model_call` / `reminder` / `compaction_summary`），请求可由日志还原。
 */
export function runModelStep(deps: ModelStepDeps, input: ModelStepInput): Promise<ModelStepResult> {
  return runStep(deps, input, false);
}

/**
 * 单轮收尾：到达步数上限时调用一次。写入收尾 `reminder`（位于请求末尾）；照常带工具（历史里有工具调用时
 * 部分供应商要求请求声明工具，也保持缓存前缀稳定），但 `toolChoice: "none"`——模型只能回复文本。
 * 其余与 `runModelStep` 相同（幂等、降级、中止）。
 */
export function runFinalWrapUp(
  deps: ModelStepDeps,
  input: ModelStepInput,
): Promise<ModelStepResult> {
  return runStep(deps, input, true);
}

async function runStep(
  deps: ModelStepDeps,
  input: ModelStepInput,
  wrapUp: boolean,
): Promise<ModelStepResult> {
  const { conversationId, runId, step, signal } = input;
  const existing = await findExisting(deps.eventLog, conversationId, runId, step);
  if (existing) {
    // resumed after a crash between writing usage and enqueueing it: enqueue again (job id dedupes)
    if (deps.usageReport && existing.usage !== null) {
      const u = await deps.eventLog.findByIdem(conversationId, idem.usage(runId, step));
      if (u) void deps.usageReport.enqueue(conversationId, u.seq);
    }
    return existing;
  }

  const runtime = deps.config().runtime;
  /** 本次尝试已流出的文本；中止时写进 aborted 的 assistant_message。 */
  const streamed = { text: "" };
  try {
    if (signal.aborted) throw new StepAborted();
    let events = await readAll(deps.eventLog, conversationId);
    // sticky (M-4): a model.request denial already logged for this step (any attempt, e.g. a crash
    // after recording it) is final: fail the same way, before compaction or any model call. Read from
    // the events just loaded, so it costs no query (M-2).
    if (hookScope(deps.hooks, input)) {
      const prior = stickyModelDenial(events, runId, step);
      if (prior) {
        throw new RunError(
          "run.hook_denied",
          modelDeniedText(prior.payload.plugin, prior.payload.reason),
        );
      }
    }
    // 每步实时解析（连接器 / 插件状态可能在步骤之间变化），解析结果记在 model_call；收尾调用同样带工具
    // 日志里有过技能目录快照 → 带上 skill_load（Ruling M17；空快照也不收回，见 skillLoadOffered）
    const resolved = await deps.tools.forAgent(input.orgId, {
      tools: input.agent.tools ?? [],
      subagents: input.agent.subagents,
      skillLoad: skillLoadOffered(
        events.findLast(
          (e): e is Extract<ConversationEvent, { type: "skills_catalog" }> =>
            e.type === "skills_catalog",
        ),
      ),
    });
    const tools: StepTools = {
      list: resolved.tools,
      toolSearch: resolved.toolSearch === true,
      media: {
        looked: new Set(),
        info: new Map(),
        bytes: new Map(),
        run: input.mediaCache ?? new MediaCache(deps.config().attachments.requestMediaBytes),
      },
    };
    const beforeCompaction = events.length;
    events = await maybeCompact(deps, input, events, runtime, tools);
    // a sub-agent checks its budget again after a compaction call, so the step's own request is
    // not a second call over the cap (review M5; the loop checks before each step)
    if (
      input.parentRunId !== undefined &&
      events.length !== beforeCompaction &&
      (await subagentBudgetUsedUp(deps.db, deps.config, input.orgId, input.parentRunId))
    ) {
      return {
        content: [],
        stopReason: "end_turn",
        reused: false,
        aborted: false,
        usage: null,
        budget: true,
      };
    }

    const last = lastToolsReminder(events, runId);
    // 有不可用工具 → 列出；此前列过、现在全部恢复 → 说明已恢复，避免过时的「不可用」成为最后一句
    // （收尾调用不得调用工具，可用性变化不写）。
    const text = wrapUp
      ? null
      : resolved.unavailable.length > 0
        ? toolsUnavailableReminder(resolved.unavailable)
        : last !== null
          ? TOOLS_AVAILABLE_AGAIN
          : null;
    if (text !== null) {
      // 本 run 里模型仍能看到的上一条同类提醒内容相同 → 不重复写（避免每步追加同样的提醒）。
      if (last !== text) {
        events = await appendLocal(deps.eventLog, conversationId, events, {
          type: "reminder",
          runId,
          idemKey: idem.toolsUnavailable(runId, step),
          payload: { step, text },
        });
      }
    }

    const { outcome, ref } = await ladder(deps, input, events, runtime, tools, wrapUp, streamed);
    // assistant_message 与 usage 同一次 append = 同一事务。
    const appended = await appendCounted(deps, input, [
      {
        type: "assistant_message",
        runId,
        idemKey: idem.assistant(runId, step),
        payload: { step, content: outcome.content, stopReason: outcome.stopReason },
      },
      {
        type: "usage",
        runId,
        idemKey: idem.usage(runId, step),
        payload: { step, provider: ref.provider, model: ref.model, ...outcome.usage },
      },
    ]);
    // usage.report metering (never awaited on the run's path; enqueue logs and swallows failures)
    const usageEvent = appended.find((e) => e.type === "usage");
    if (deps.usageReport && usageEvent)
      void deps.usageReport.enqueue(conversationId, usageEvent.seq);
    return {
      content: outcome.content,
      stopReason: outcome.stopReason,
      reused: false,
      aborted: false,
      usage: outcome.usage,
    };
  } catch (e) {
    if (!(e instanceof StepAborted)) throw e;
    // 中止：已流出的文本组装成 aborted 消息；一个字都没流出时 content 为 []（构建请求时不回放）。
    const content: ContentBlock[] =
      streamed.text === "" ? [] : [{ type: "text", text: streamed.text }];
    await deps.eventLog.append(conversationId, [
      {
        type: "assistant_message",
        runId,
        idemKey: idem.assistant(runId, step),
        payload: { step, content, stopReason: "aborted" },
      },
    ]);
    return { content, stopReason: "aborted", reused: false, aborted: true, usage: null };
  }
}

/**
 * Appends a model call's events (its reply or compaction outcome with its `usage`). For a
 * sub-agent's run (`input.parentRunId`) in one transaction that also adds the tokens of the usage
 * events it newly wrote to the parent run's `subagent_tokens_used` (sub-agents spec §8.3): a usage
 * event already in the log (an idempotent hit after a crash) adds nothing, so each call counts
 * exactly once.
 */
async function appendCounted(
  deps: Pick<ModelStepDeps, "db" | "eventLog">,
  input: Pick<ModelStepInput, "conversationId" | "parentRunId">,
  events: AppendEvent[],
): Promise<ConversationEvent[]> {
  const { conversationId, parentRunId } = input;
  if (parentRunId === undefined) return deps.eventLog.append(conversationId, events);
  const out = await deps.db.transaction().execute(async (t) => {
    // the conversation row lock the append takes anyway, taken first to read the seq before it
    const before = await t
      .selectFrom("conversations")
      .select("last_seq")
      .where("id", "=", conversationId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const written = await deps.eventLog.append(conversationId, events, t);
    const fresh = written.filter((e) => e.seq > Number(before.last_seq));
    let tokens = 0;
    for (const e of fresh) if (e.type === "usage") tokens += usageTokens(e.payload);
    if (tokens > 0) {
      await t
        .updateTable("runs")
        .set({ subagent_tokens_used: sql`subagent_tokens_used + ${tokens}` })
        .where("id", "=", parentRunId)
        .execute();
    }
    return { written, toSeq: fresh.length > 0 ? Math.max(...fresh.map((e) => e.seq)) : null };
  });
  if (out.toSeq !== null) await deps.eventLog.notify(conversationId, out.toSeq);
  return out.written;
}

/** The `hook_denied` of a `model.request` denial already logged for this run step (any attempt). */
function stickyModelDenial(
  events: readonly ConversationEvent[],
  runId: string,
  step: number,
): Extract<ConversationEvent, { type: "hook_denied" }> | undefined {
  return events.findLast(
    (e): e is Extract<ConversationEvent, { type: "hook_denied" }> =>
      e.type === "hook_denied" &&
      e.runId === runId &&
      e.payload.mount === "model.request" &&
      e.payload.step === step,
  );
}

/** 幂等命中：返回已写入的 assistant_message（与同批的 usage）对应的结果。 */
async function findExisting(
  eventLog: EventLog,
  conversationId: string,
  runId: string,
  step: number,
): Promise<ModelStepResult | null> {
  const msg = await eventLog.findByIdem(conversationId, idem.assistant(runId, step));
  if (msg?.type !== "assistant_message") return null;
  const u = await eventLog.findByIdem(conversationId, idem.usage(runId, step));
  const usage: ModelUsage | null =
    u?.type === "usage"
      ? {
          inputTokens: u.payload.inputTokens,
          outputTokens: u.payload.outputTokens,
          cacheReadTokens: u.payload.cacheReadTokens,
          cacheWriteTokens: u.payload.cacheWriteTokens,
        }
      : null;
  const { stopReason } = msg.payload;
  return {
    content: msg.payload.content as ContentBlock[],
    stopReason,
    reused: true,
    aborted: stopReason === "aborted",
    usage,
  };
}

/** 本 run 中、最近摘要之后的最后一条工具可用性提醒（不可用 / 已恢复）的文本；没有则 null。 */
function lastToolsReminder(events: ConversationEvent[], runId: string): string | null {
  const floor = latestSummary(events)?.payload.coversUpToSeq ?? Number.NEGATIVE_INFINITY;
  let text: string | null = null;
  for (const e of events) {
    if (
      e.seq > floor &&
      e.type === "reminder" &&
      e.runId === runId &&
      (e.payload.text.startsWith(TOOLS_UNAVAILABLE_PREFIX) ||
        e.payload.text === TOOLS_AVAILABLE_AGAIN)
    ) {
      text = e.payload.text;
    }
  }
  return text;
}

/** 读会话的全部事件（读到当前 last_seq），按 seq 升序。 */
async function readAll(eventLog: EventLog, conversationId: string): Promise<ConversationEvent[]> {
  const out: ConversationEvent[] = [];
  let after = 0;
  for (;;) {
    const page = await eventLog.readAfter(conversationId, after, READ_PAGE);
    out.push(...page);
    const last = page.at(-1);
    if (page.length < READ_PAGE || !last) return out;
    after = last.seq;
  }
}

/**
 * 追加一条事件并并入本地事件列表（幂等命中已在列表中的不重复加入）。
 *
 * 并发注意（已知、接受）：只并入本次写入的事件，`readAll` 之后别处并发写入的事件（如运行中途到达的插话）
 * 不在本地列表里，即使它们的 seq 比这里写入的更小。构建请求因此可能「缺」若干 seq ≤ `toSeq` 的事件；
 * 这些只会是 seq > `absorbedUpToSeq` 的 user_message，构建时本来就被跳过，所以由日志
 * （seq ≤ `toSeq` 的全部事件 + 记录的 `absorbedUpToSeq`）还原出的请求与实际发出的一致（evals/reconstruct.ts）。
 */
async function appendLocal(
  eventLog: EventLog,
  conversationId: string,
  events: ConversationEvent[],
  event: AppendEvent,
): Promise<ConversationEvent[]> {
  const [written] = await eventLog.append(conversationId, [event]);
  if (!written || events.some((e) => e.seq === written.seq)) return events;
  return [...events, written];
}

/**
 * 某次尝试的模型参数：主模型尝试用 `agent.modelParams`，兜底尝试用 `agent.fallbackParams`，
 * 按该模型的声明宽松处理（丢弃未声明 / 不再合法的项并补默认值，见 `sanitizeParams`）。
 * 较早保存的定义可能没有这两个字段，按空处理。
 */
function attemptParams(
  agent: AgentDefinition,
  info: ModelInfo,
  fallback: boolean,
): { value: Record<string, ParamValue>; dropped: string[] } {
  const saved = (fallback ? agent.fallbackParams : agent.modelParams) ?? {};
  return sanitizeParams(info.parameters, saved);
}

/** {@link assembleModelRequest} 的输入。 */
export interface AssembleModelRequestInput extends Omit<BuildModelRequestInput, "tools"> {
  /** 本步解析出的工具；模型不支持工具（`capabilities.tools` 为 false）时不带。 */
  tools: readonly RequestTool[];
  /** 参数里没有 `maxOutputTokens` 旋钮时的输出上限（运行时为 `runtime.maxOutputTokens`）。 */
  defaultMaxOutputTokens: number;
}

/**
 * 发给模型的请求（纯函数）：`buildModelRequest`（注入 `params` 与本步工具：模型不支持工具时不带；收尾调用带
 * `toolChoice: "none"`）→ `guardToolPairs`。输出上限：参数里有 `maxOutputTokens` 旋钮时取
 * `min(模型上限, 旋钮)`，否则 `min(模型上限, defaultMaxOutputTokens)`。
 * 运行时（{@link runModelStep}）与由日志还原请求（`evals/reconstruct.ts`）共用这一份，二者不会漂移。
 */
export function assembleModelRequest(input: AssembleModelRequestInput): {
  request: ModelRequest;
  meta: ModelCallMeta;
  mediaTokens: number;
} {
  const { defaultMaxOutputTokens, tools, ...rest } = input;
  const built = buildModelRequest({
    ...rest,
    tools: input.model.capabilities.tools ? [...tools] : [],
  });
  const { request } = built;
  request.messages = guardToolPairs(request.messages);
  const knob = request.params.maxOutputTokens;
  request.maxOutputTokens = Math.min(
    input.model.maxOutputTokens,
    typeof knob === "number" ? knob : defaultMaxOutputTokens,
  );
  return built;
}

/**
 * 由事件构建本步的模型请求（{@link assembleModelRequest}）并给出输入 token 估算。
 *
 * 调用方不变式：不得在「已记录 tool_call、尚未记录其 tool_result」之间构建请求——
 * 否则配对守卫会给进行中的调用补上 unknown 结果并发给模型。运行循环在工具结果落日志后才进入下一步。
 */
function buildRequest(
  deps: Pick<ModelStepDeps, "config">,
  events: ConversationEvent[],
  input: ModelStepInput,
  info: ModelInfo,
  params: Record<string, ParamValue>,
  runtime: Runtime,
  tools: StepTools,
  wrapUp: boolean,
): { request: ModelRequest; meta: ModelCallMeta; estimate: number } {
  const { request, meta, mediaTokens } = assembleModelRequest({
    events,
    agent: input.agent,
    agentVersion: input.agentVersion,
    model: info,
    step: input.step,
    absorbedUpToSeq: input.absorbedUpToSeq,
    params,
    tools: tools.list,
    toolSearch: tools.toolSearch,
    ...(wrapUp && { toolChoice: "none" as const }),
    mediaInfo: tools.media.info,
    media: tools.media.bytes,
    mediaBudgetBytes: deps.config().attachments.requestMediaBytes,
    defaultMaxOutputTokens: runtime.maxOutputTokens,
  });
  return {
    request,
    meta,
    estimate: estimateTokens(request.messages, request.system, request.tools, mediaTokens),
  };
}

/**
 * 取本次构建要用到的附件（只取该模型会用到的：不支持的图片 / PDF 只发占位，行与字节都不取）：先查行信息，
 * 按 {@link planMedia}（只看声明大小、页数与日志）决定保留哪些，再只取保留的字节（`text/*` 只取开头），
 * 并入 `tools.media`。先查本次运行的缓存（键含 etag），未命中才取。
 * 取不到（确定不存在）的缓存为 null；暂时故障抛 {@link MediaUnavailableError}，不缓存，下一次尝试重新取。
 */
async function loadMedia(
  deps: ModelStepDeps,
  input: ModelStepInput,
  events: ConversationEvent[],
  info: ModelInfo,
  tools: StepTools,
): Promise<void> {
  const cache = tools.media;
  const look = mediaRefs(events, info).filter((id) => !cache.looked.has(id));
  if (look.length > 0) {
    if (deps.media) {
      let rows: Map<string, MediaInfo>;
      try {
        rows = await deps.media.info(input.orgId, input.conversationId, look);
      } catch (err) {
        throw new MediaUnavailableError(err);
      }
      for (const [id, row] of rows) cache.info.set(id, row);
    }
    for (const id of look) cache.looked.add(id);
  }
  const budget = deps.config().attachments.requestMediaBytes;
  const plan = planMedia(events, info, cache.info, budget);
  const runKey = (id: string) =>
    MediaCache.key(id, cache.info.get(id) as MediaInfo, plan.caps.get(id));
  const need: string[] = [];
  for (const id of plan.fetch) {
    if (cache.bytes.has(id)) continue;
    const hit = cache.run.get(runKey(id));
    if (hit) cache.bytes.set(id, hit);
    else need.push(id);
  }
  if (need.length === 0 || !deps.media) return;
  const caps = new Map(
    need.flatMap((id) => (plan.caps.has(id) ? [[id, plan.caps.get(id) as number]] : [])),
  );
  let got: Map<string, MediaBytes | null>;
  try {
    got = await deps.media.fetch(
      input.orgId,
      input.conversationId,
      need,
      caps.size > 0 ? caps : undefined,
    );
  } catch (err) {
    throw new MediaUnavailableError(err);
  }
  for (const id of need) {
    const b = got.get(id) ?? null;
    cache.bytes.set(id, b);
    if (b) cache.run.set(runKey(id), b);
  }
}

/**
 * 上一次成功调用的「未校正估算 vs 真实输入 token」：最近的 usage 及其之前最近的 model_call。
 * 真实输入取 `inputTokens + cacheReadTokens + cacheWriteTokens`（`inputTokens` 只是未缓存部分，
 * 见 plugin-sdk `ModelUsage`）；只用 `inputTokens` 会在大量缓存命中时把估算压到下限，压缩永不触发。
 */
function lastActual(events: ConversationEvent[]): { estimate: number; inputTokens: number } | null {
  let usage: (ConversationEvent & { type: "usage" }) | undefined;
  // compaction calls have their own request (not a model_call): only step usage calibrates
  for (const e of events) if (e.type === "usage" && e.payload.purpose !== "compaction") usage = e;
  if (!usage) return null;
  let estimate: number | undefined;
  for (const e of events) {
    if (e.seq >= usage.seq) break;
    if (e.type === "model_call") estimate = e.payload.request.estimatedInputTokens;
  }
  if (estimate === undefined) return null;
  const { inputTokens, cacheReadTokens, cacheWriteTokens } = usage.payload;
  return { estimate, inputTokens: inputTokens + cacheReadTokens + cacheWriteTokens };
}

/** 最近一条摘要之后连续失败的压缩次数。 */
function consecutiveCompactionFailures(events: ConversationEvent[]): number {
  let n = 0;
  for (const e of events) {
    if (e.type === "compaction_summary") n = 0;
    else if (e.type === "compaction_failed") n++;
  }
  return n;
}

/**
 * 压缩：校正后的估算达到阈值、且不在失败退避期内时，用主模型生成摘要（非流式消费）。
 * 通过 → `compaction_summary`；过短或出错 → `compaction_failed`（attempt 从 1 起，连续失败递增），
 * 本步按原样继续。主模型此刻解析不了时跳过压缩，交给降级梯子处理。
 */
async function maybeCompact(
  deps: ModelStepDeps,
  input: ModelStepInput,
  events: ConversationEvent[],
  runtime: Runtime,
  tools: StepTools,
): Promise<ConversationEvent[]> {
  if (compactionBackoff(events)) return events;
  let provider: ModelProvider;
  let info: ModelInfo;
  try {
    ({ provider, info } = await deps.registry.resolve(input.agent.model));
  } catch (err) {
    deps.log.warn("compaction skipped: model unavailable", { model: input.agent.model, err });
    return events;
  }
  try {
    await loadMedia(deps, input, events, info, tools);
  } catch (err) {
    if (!(err instanceof MediaUnavailableError)) throw err;
    // 存储暂时不可用：本步跳过压缩，交给降级梯子（会按可重试错误处理）
    deps.log.warn("compaction skipped: attachment storage unavailable", {
      conversationId: input.conversationId,
      err,
    });
    return events;
  }
  const { estimate: raw } = buildRequest(
    deps,
    events,
    input,
    info,
    attemptParams(input.agent, info, false).value,
    runtime,
    tools,
    false,
  );
  const estimate = calibrate(raw, lastActual(events));
  if (!shouldCompact(estimate, info, runtime.compactionThreshold)) return events;
  const plan = compactionPlan(events, runtime.keepRecentTurns);
  if (!plan) return events;

  const { runId, step, signal, conversationId } = input;
  const ref = input.agent.model;
  const request = buildCompactionRequest(plan.transcript, info.id);
  const attemptNo = consecutiveCompactionFailures(events) + 1;
  // hooks see compaction calls like step attempts (I-1): same scope, chat runs only
  const scope = hookScope(deps.hooks, input);
  const hookBase = scope && {
    ...scope,
    purpose: "compaction" as const,
    step,
    attempt: 1,
    provider: ref.provider,
    model: ref.model,
  };
  if (hookBase && deps.hooks?.has("model.request")) {
    let verdict: Awaited<ReturnType<HookRunner["run"]>>;
    try {
      verdict = await deps.hooks.run(
        "model.request",
        { ...hookBase, request: hookRequestOf(request, deps.log) },
        signal,
      );
    } catch (e) {
      // run() rejects only when the run's signal aborted: an abort, never a deny
      if (signal.aborted) throw new StepAborted();
      throw e;
    }
    if (!verdict.allowed) {
      // compaction fails (generic reason in the log, raw detail only in the audit row, R12); the
      // step continues and its own request meets the hooks next
      const site = {
        orgId: input.orgId,
        conversationId,
        runId,
        ...(input.accountId !== undefined && { accountId: input.accountId }),
        ...(input.agentId !== undefined && { agentId: input.agentId }),
        idemKey: `hook_denied_compaction:${runId}:${step}:${attemptNo}`,
      };
      const denied = hookDeniedEvent(site, "model.request", verdict, { step, attempt: 1 });
      const entry = hookDeniedAudit(site, denied.payload, verdict);
      entry.detail = { ...entry.detail, purpose: "compaction" };
      const failed: AppendEvent = {
        type: "compaction_failed",
        runId,
        payload: {
          attempt: attemptNo,
          reason: `compaction request blocked by the "${verdict.plugin}" policy hook (${verdict.cause})`,
        },
      };
      deps.log.warn("compaction blocked by a policy hook", {
        conversationId,
        plugin: verdict.plugin,
        cause: verdict.cause,
      });
      const written = await deps.db.transaction().execute(async (t) => {
        const out = await deps.eventLog.append(conversationId, [failed], t);
        await audit(t, entry);
        return out;
      });
      if (written.length > 0) {
        await deps.eventLog.notify(conversationId, Math.max(...written.map((e) => e.seq)));
      }
      return mergeLocal(events, written);
    }
  }

  let failure: string | null = null;
  let summary = "";
  let usage: ModelUsage | null = null;
  const sentAt = Date.now();
  try {
    let partial = "";
    const out = await consumeModelStream(
      provider,
      request,
      info.streamIdleTimeoutMs ?? runtime.streamIdleMs,
      signal,
      (ev) => {
        if (ev.type === "text_delta") partial += ev.text;
      },
    );
    usage = out.usage;
    if (hookBase && deps.hooks) {
      fireObserve(
        deps.hooks,
        "model.response",
        {
          ...hookBase,
          outcome: "ok",
          content: out.content,
          stopReason: out.stopReason,
          usage: out.usage,
          latencyMs: Date.now() - sentAt,
        },
        signal,
        deps.log,
      );
    }
    const final = out.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    summary = (final || partial).trim();
    if (!acceptSummary(summary, plan.transcript)) {
      failure = `summary too short (${summary.length} chars)`;
    }
  } catch (err) {
    if (err instanceof StepAborted) throw err;
    if (hookBase && deps.hooks) {
      fireObserve(
        deps.hooks,
        "model.response",
        {
          ...hookBase,
          outcome: "failed",
          content: [],
          stopReason: null,
          usage: null,
          latencyMs: Date.now() - sentAt,
          errorCode: classify(err).code,
        },
        signal,
        deps.log,
      );
    }
    failure = err instanceof Error ? err.message : String(err);
  }

  const event: AppendEvent =
    failure === null
      ? {
          type: "compaction_summary",
          runId,
          payload: { coversUpToSeq: plan.coversUpToSeq, text: summary },
        }
      : {
          type: "compaction_failed",
          runId,
          payload: { attempt: attemptNo, reason: failure },
        };
  if (failure !== null) {
    deps.log.warn("compaction failed", { conversationId, reason: failure });
  }
  // the compaction call's usage (I-1): logged with the outcome in one append (one transaction), marked
  // `purpose: "compaction"` so step consumers (calibration, trajectory steps, replay plans) skip it
  const batch: AppendEvent[] = [event];
  if (usage !== null) {
    batch.push({
      type: "usage",
      runId,
      idemKey: idem.compactionUsage(runId, step, attemptNo),
      payload: { step, provider: ref.provider, model: ref.model, ...usage, purpose: "compaction" },
    });
  }
  const written = await appendCounted(deps, input, batch);
  const usageEvent = written.find((e) => e.type === "usage");
  if (deps.usageReport && usageEvent) void deps.usageReport.enqueue(conversationId, usageEvent.seq);
  return mergeLocal(events, written);
}

/** Merges written events into the local list (idempotent hits already in it are not added twice). */
function mergeLocal(
  events: ConversationEvent[],
  written: readonly ConversationEvent[],
): ConversationEvent[] {
  const fresh = written.filter((w) => !events.some((e) => e.seq === w.seq));
  return fresh.length === 0 ? events : [...events, ...fresh];
}

/**
 * 降级梯子：主模型 → 主模型重试一次（等 `retryAfterMs ?? 1000`，可被中止）→ `agent.fallback`（若有）。
 * 建议等待超过 `MAX_RETRY_AFTER_MS` 时跳过同模型重试。
 * 每次尝试解析出模型后、写 `model_call` 之前写本步的尾部提醒（均按本步幂等，只写一次）：所用模型不支持工具而本步有工具
 * → {@link TOOLS_UNSUPPORTED_REMINDER}；然后是轮次提醒或收尾提醒（收尾提醒因此位于请求末尾）。
 * 每次实际尝试写自己的 `model_call`（attempt 从 1 连续递增，跳过的不计）；重试前经 sink 发 `step_reset`。
 * 不可重试的失败或梯子用尽 → `RunError`。
 */
async function ladder(
  deps: ModelStepDeps,
  input: ModelStepInput,
  events: ConversationEvent[],
  runtime: Runtime,
  tools: StepTools,
  wrapUp: boolean,
  streamed: { text: string },
): Promise<{ outcome: StreamOutcome; ref: ModelRef }> {
  const { conversationId, runId, step, signal, sink, agent } = input;
  const turnReminder = wrapUp
    ? WRAP_UP_REMINDER
    : turnLimitReminder(step, input.maxSteps ?? runtime.maxSteps);
  let evs = events;
  const rungs: { ref: ModelRef; fallback: boolean }[] = [
    { ref: agent.model, fallback: false },
    { ref: agent.model, fallback: false },
  ];
  if (agent.fallback) rungs.push({ ref: agent.fallback, fallback: true });

  let last: Failure | undefined;
  let attempt = 0;
  // hooks fire only for chat runs that have a registry (eval replays omit it, P-18)
  const scope = hookScope(deps.hooks, input);
  /** 本次尝试发出的请求里带了字节的附件（供应商拒收时写 media_excluded）。 */
  let sentMedia: string[] = [];
  for (const rung of rungs) {
    if (last && !rung.fallback && (last.retryAfterMs ?? 0) > MAX_RETRY_AFTER_MS) {
      deps.log.warn("model retry skipped: suggested wait exceeds cap", {
        conversationId,
        runId,
        step,
        retryAfterMs: last.retryAfterMs,
      });
      continue;
    }
    attempt++;
    if (last) {
      sink({ kind: "step_reset", runId, step });
      streamed.text = "";
      if (!rung.fallback) await abortableSleep(last.retryAfterMs ?? DEFAULT_RETRY_DELAY_MS, signal);
    }
    sentMedia = [];
    /** When the request went out (model.response fires only for sent requests). */
    let sentAt: number | undefined;
    try {
      const { provider, info } = await deps.registry.resolve(rung.ref);
      if (tools.list.length > 0 && !info.capabilities.tools) {
        evs = await appendLocal(deps.eventLog, conversationId, evs, {
          type: "reminder",
          runId,
          idemKey: idem.toolsUnsupported(runId, step),
          payload: { step, text: TOOLS_UNSUPPORTED_REMINDER },
        });
      }
      if (turnReminder !== null) {
        evs = await appendLocal(deps.eventLog, conversationId, evs, {
          type: "reminder",
          runId,
          idemKey: idem.reminder(runId, step),
          payload: { step, text: turnReminder },
        });
      }
      const params = attemptParams(agent, info, rung.fallback);
      await loadMedia(deps, input, evs, info, tools);
      const { request, meta, estimate } = buildRequest(
        deps,
        evs,
        input,
        info,
        params.value,
        runtime,
        tools,
        wrapUp,
      );
      sentMedia = (meta.media ?? []).flatMap((m) =>
        m.outcome === "bytes" ? [m.attachmentId] : [],
      );
      // model.request before model_call: a denied request is never logged as sent nor sent (a denial
      // logged before a crash is sticky: runStep checks it before compaction)
      if (scope && deps.hooks?.has("model.request")) {
        let verdict: Awaited<ReturnType<HookRunner["run"]>>;
        try {
          verdict = await deps.hooks.run(
            "model.request",
            {
              ...scope,
              purpose: "step",
              step,
              attempt,
              provider: rung.ref.provider,
              model: rung.ref.model,
              request: hookRequestOf(request, deps.log),
            },
            signal,
          );
        } catch (e) {
          // run() rejects only when the run's signal aborted: an abort, never a deny
          if (signal.aborted) throw new StepAborted();
          throw e;
        }
        if (!verdict.allowed) {
          await recordHookDenial(
            deps,
            {
              orgId: input.orgId,
              conversationId,
              runId,
              ...(input.accountId !== undefined && { accountId: input.accountId }),
              ...(input.agentId !== undefined && { agentId: input.agentId }),
              idemKey: idem.hookDenied(runId, step, attempt),
            },
            "model.request",
            verdict,
            { step, attempt },
          );
          throw new RunError("run.hook_denied", modelDeniedText(verdict.plugin, verdict.reason));
        }
      }
      // 请求里的工具定义（含目录里的）按指纹存进 tool_specs，与 model_call 同一事务
      // （请求可由日志 + tool_specs 还原）
      const sent = new Set([...meta.tools, ...(meta.catalog ?? [])].map((t) => t.specHash));
      const written = await deps.db.transaction().execute(async (t) => {
        await recordToolSpecs(
          t,
          tools.list.filter((x) => sent.has(x.specHash)),
        );
        return deps.eventLog.append(
          conversationId,
          [
            {
              type: "model_call",
              runId,
              idemKey: idem.modelCall(runId, step, attempt),
              payload: {
                step,
                attempt,
                provider: rung.ref.provider,
                model: rung.ref.model,
                fallback: rung.fallback,
                request: {
                  ...meta,
                  maxOutputTokens: request.maxOutputTokens,
                  ...(params.dropped.length > 0 && { droppedParams: params.dropped }),
                  estimatedInputTokens: estimate,
                },
              },
            },
          ],
          t,
        );
      });
      await deps.eventLog.notify(conversationId, Math.max(...written.map((e) => e.seq)));
      sentAt = Date.now();
      const outcome = await consumeModelStream(
        provider,
        request,
        info.streamIdleTimeoutMs ?? runtime.streamIdleMs,
        signal,
        (ev) => {
          if (ev.type === "text_delta") {
            streamed.text += ev.text;
            sink({ kind: "text", runId, step, text: ev.text });
          } else {
            sink({ kind: "thinking", runId, step, text: ev.text });
          }
        },
      );
      if (scope && deps.hooks) {
        fireObserve(
          deps.hooks,
          "model.response",
          {
            ...scope,
            purpose: "step",
            step,
            attempt,
            provider: rung.ref.provider,
            model: rung.ref.model,
            outcome: "ok",
            content: outcome.content,
            stopReason: outcome.stopReason,
            usage: outcome.usage,
            latencyMs: Date.now() - sentAt,
          },
          signal,
          deps.log,
        );
      }
      return { outcome, ref: rung.ref };
    } catch (err) {
      if (err instanceof StepAborted) throw err;
      if (signal.aborted) throw new StepAborted();
      // a hook denial is final (not retried, not reclassified)
      if (err instanceof RunError) throw err;
      const f = classify(err);
      if (scope && deps.hooks && sentAt !== undefined) {
        fireObserve(
          deps.hooks,
          "model.response",
          {
            ...scope,
            purpose: "step",
            step,
            attempt,
            provider: rung.ref.provider,
            model: rung.ref.model,
            outcome: "failed",
            content: [],
            stopReason: null,
            usage: null,
            latencyMs: Date.now() - sentAt,
            errorCode: f.code,
          },
          signal,
          deps.log,
        );
      }
      deps.log.warn("model call attempt failed", {
        conversationId,
        runId,
        step,
        attempt,
        code: f.code,
        retryable: f.retryable,
        error: f.message,
      });
      if (!f.retryable) {
        if (REJECTS_MEDIA.has(f.code) && sentMedia.length > 0) {
          // 记录失败不能掩盖原来的失败码：只记 warn，本次运行照常以原错误失败
          try {
            await excludeMedia(deps, input, attempt, sentMedia);
          } catch (e) {
            deps.log.warn("cannot record media_excluded", { conversationId, runId, step, err: e });
          }
        }
        throw new RunError(f.code, f.message);
      }
      last = f;
    }
  }
  const f = last as Failure;
  throw new RunError(f.code, f.message);
}

/** 不可重试、且可能由请求里的媒体引起的失败：带了媒体字节时写 `media_excluded`（Ruling M8）。 */
const REJECTS_MEDIA = new Set(["model.invalid_request", "model.context_overflow"]);

/**
 * 供应商拒收了带媒体的请求：把这些附件记进 `media_excluded`（每条最多 {@link MEDIA_EXCLUDED_MAX_IDS} 个），
 * 之后的请求一律换成占位，会话不会因同一个附件永久卡住（可由日志推出）。本次运行照常失败。
 */
async function excludeMedia(
  deps: ModelStepDeps,
  input: ModelStepInput,
  attempt: number,
  ids: readonly string[],
): Promise<void> {
  const { conversationId, runId, step } = input;
  const events: AppendEvent[] = [];
  for (let i = 0; i < ids.length; i += MEDIA_EXCLUDED_MAX_IDS) {
    events.push({
      type: "media_excluded",
      runId,
      idemKey: idem.mediaExcluded(runId, step, attempt, i / MEDIA_EXCLUDED_MAX_IDS),
      payload: {
        attachmentIds: ids.slice(i, i + MEDIA_EXCLUDED_MAX_IDS),
        reason: "provider_rejected",
      },
    });
  }
  deps.log.warn("model provider rejected a request with media; excluding the attachments", {
    conversationId,
    runId,
    step,
    attachmentIds: ids,
  });
  await deps.eventLog.append(conversationId, events);
}

function classify(err: unknown): Failure {
  if (isModelError(err)) {
    return {
      retryable: isRetryableKind(err.kind),
      code: `model.${err.kind}`,
      message: err.message,
      retryAfterMs: err.retryAfterMs,
    };
  }
  if (err instanceof MediaUnavailableError) {
    return {
      retryable: true,
      code: "run.storage_unavailable",
      message: err.message,
      retryAfterMs: undefined,
    };
  }
  // 供应商插件在调用途中被撤销 / 升级 / 重新加载（排空时限到了，或调用落在正在撤销的实例上）：同模型重试会实时
  // 向注册表取到新实例（I2）；插件真的停用了时重试解析失败，按 model_unavailable 结束
  if (
    err instanceof ExtensionUnloadedError ||
    (err instanceof Error && err.cause instanceof ExtensionUnloadedError)
  ) {
    return {
      retryable: true,
      code: "run.provider_unavailable",
      message: err.message,
      retryAfterMs: undefined,
    };
  }
  if (err instanceof ProviderListError) {
    return {
      retryable: true,
      code: "run.provider_unavailable",
      message: err.message,
      retryAfterMs: undefined,
    };
  }
  if (err instanceof ApiError && err.code === "agent.model_unavailable") {
    return {
      retryable: false,
      code: "run.model_unavailable",
      message: err.message,
      retryAfterMs: undefined,
    };
  }
  return {
    retryable: false,
    code: "run.provider_error",
    message: err instanceof Error ? err.message : String(err),
    retryAfterMs: undefined,
  };
}

/** 可被中止的等待（本进程发起的模型调用自己的计时器，结束即清除）；中止 → StepAborted。 */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new StepAborted());
    const onAbort = () => {
      clearTimeout(timer);
      reject(new StepAborted());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * 消费一次模型流，带空闲看门狗：两次事件之间超过 `idleMs` → 本地中止并按 `ModelError("timeout")` 抛出。
 * 外部 `signal` 触发 → `StepAborted`。每次 `next()` 都与停止信号竞速，供应商不响应 signal 也不会卡住。
 * 运行时与评测单步回放（`evals/step-replay.ts`）、评委共用。
 */
export async function consumeModelStream(
  provider: ModelProvider,
  request: ModelRequest,
  idleMs: number,
  signal: AbortSignal,
  onDelta: (ev: Exclude<ModelStreamEvent, { type: "message_complete" }>) => void,
): Promise<StreamOutcome> {
  if (signal.aborted) throw new StepAborted();
  const local = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stop!: () => void;
  const stopped = new Promise<never>((_, reject) => {
    stop = () => reject(new StepAborted());
  });
  stopped.catch(() => {});
  const halt = () => {
    if (local.signal.aborted) return;
    local.abort();
    stop();
  };
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      halt();
    }, idleMs);
  };
  signal.addEventListener("abort", halt, { once: true });

  let it: AsyncIterator<ModelStreamEvent> | undefined;
  try {
    arm();
    it = provider.stream(request, { signal: local.signal })[Symbol.asyncIterator]();
    for (;;) {
      const next = it.next();
      next.catch(() => {});
      const r = await Promise.race([next, stopped]);
      if (r.done) break;
      arm();
      const ev = r.value;
      if (ev.type === "message_complete") {
        return { content: ev.content, stopReason: ev.stopReason, usage: ev.usage };
      }
      onDelta(ev);
    }
    throw new ModelError("server", "Model stream ended without message_complete");
  } catch (err) {
    if (signal.aborted) throw new StepAborted();
    if (timedOut) {
      throw new ModelError("timeout", `Model stream idle for more than ${idleMs}ms`, {
        cause: err,
      });
    }
    throw err;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", halt);
    // 提前结束（完成、出错、超时、中止）都通知生成器收尾；不等待，避免卡在不响应的供应商上。
    it?.return?.()?.catch(() => {});
  }
}
