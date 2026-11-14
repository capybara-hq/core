import { createHash } from "node:crypto";
import {
  type ContentBlock,
  type ConversationSource,
  isModelError,
  isRetryableKind,
  type Logger,
  ModelError,
  type ModelInfo,
  type ModelRequest,
  type ModelStreamEvent,
  type ModelUsage,
  type ParamValue,
  type StopReason,
  sanitizeParams,
} from "@capybara-hq/plugin-sdk";
import type { AgentDefinition, ModelRef } from "../agents/definition.js";
import type { KernelConfig } from "../config/schema.js";
import type { AppendEvent, EventLog } from "../conversations/event-log.js";
import { type ConversationEvent, MEDIA_EXCLUDED_MAX_IDS } from "../conversations/events.js";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { ExtensionUnloadedError } from "../extensions/inflight.js";
import type { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { hasInvocation, skillLoadOffered } from "../skills/catalog.js";
import type { ToolRegistry, UnavailableTool } from "../tools/registry.js";
import type { CompactionProgress, CompactionProgressSink } from "./compaction-progress.js";
import type {
  CompactionSettings,
  CompactionSettingsService,
} from "./compaction-settings.service.js";
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
  chunkTranscript,
  compactionBackoff,
  compactionChunkSize,
  compactionInputBudget,
  compactionPlan,
  compactionRequestOverhead,
  extractSummary,
  MIN_COMPACTION_CHUNK_TOKENS,
  nextTranscriptChunk,
  openingSeqs,
  shouldCompact,
  summarySavedTokens,
} from "./context/compaction.js";
import {
  applyFit,
  estimateAfterFit,
  type FitPlan,
  planFit,
  planningBounds,
  planReactiveTrim,
  planSqueezedFit,
  sentOutputCap,
} from "./context/fit.js";
import { guardToolPairs } from "./context/pairing.js";
import { TOOLS_UNSUPPORTED_REMINDER, turnLimitReminder } from "./context/reminders.js";
import { calibrate, estimateTokens } from "./context/tokens.js";
import { toolSetChange } from "./context/tool-changes.js";
import {
  type ConversationKindForHooks,
  fireObserve,
  type HookDenial,
  type HookRunner,
  hookDeniedAudit,
  hookDeniedEvent,
  hookRequestOf,
  hookScope,
  recordHookDenial,
} from "./hook-calls.js";
import type { SubagentParent } from "./loop.js";
import { MediaCache } from "./media-cache.js";
import { type BoundProvider, ProviderListError, type ProviderRegistry } from "./providers.js";
import type { StepLog } from "./step-log.js";
import { budgetRunOf, subagentBudgetUsedUp } from "./subagents/limits.js";

/** 单轮收尾的尾部提醒（模型可见，英文；spec 6 轮次额度收尾）。 */
export const WRAP_UP_REMINDER =
  "Step limit reached. Do not call tools. Summarize what you found and what remains for the user.";

/**
 * The tail reminder of a sub-agent's final call once its tree used its token budget (model-visible,
 * English; sub-agents spec §8.3): the child hands back what it found instead of ending with nothing.
 */
export const BUDGET_WRAP_UP_REMINDER =
  "The sub-agents' token budget is used up, so this is your last reply. Do not call tools. " +
  "Report what you found so far, with the sources and details that matter, and what remains " +
  "unfinished.";

/** Why a run makes its final, tool-less call: its step limit, or its tree's token budget. */
export type WrapUpReason = "max_steps" | "budget";

export { TOOLS_UNSUPPORTED_REMINDER } from "./context/reminders.js";

/** 不可用工具提醒的前缀（模型可见，英文）。 */
export const TOOLS_UNAVAILABLE_PREFIX = "The following tools are unavailable in this run: ";

/** 本 run 中此前有工具不可用、现在全部恢复时的提醒（模型可见，英文）。 */
export const TOOLS_AVAILABLE_AGAIN = "All previously unavailable tools are available again.";

/** 不可用工具提醒：`The following tools are unavailable in this run: <ref> (<reason>), ...`。 */
export function toolsUnavailableReminder(unavailable: readonly UnavailableTool[]): string {
  return `${TOOLS_UNAVAILABLE_PREFIX}${unavailable.map((u) => `${u.ref} (${u.reason})`).join(", ")}`;
}

/**
 * `run_failed` message of a model request denied by a policy hook (user-facing, never model-visible);
 * also the message of the `model.hook_denied` error a denied `ctx.models.embed` call rejects with.
 */
export const modelDeniedText = (plugin: string, reason: string) =>
  `Model request blocked by the "${plugin}" policy hook: ${reason}`;

/**
 * The `run.context_too_large` message (user-facing, not model-visible): the hard fit guard could
 * not bring the request under `W - O - R` even after dropping all older history and truncating the
 * latest turn, so the system prompt, tools and the latest message are themselves too large
 * (context compaction spec §4.3 point 4).
 */
export const contextTooLargeText = (model: ModelInfo, target: number, estimate: number) =>
  `The request is too large for the model "${model.displayName}" (estimated ${estimate} input tokens, ` +
  `at most ${target} fit in its ${model.contextWindow}-token context window after the output cap and ` +
  "reserve). Shorten the message or choose a model with a larger context window.";

/** 可重试错误在同一模型上重试前的默认等待（供应商未给 retryAfterMs 时）。 */
const DEFAULT_RETRY_DELAY_MS = 1000;

/**
 * 供应商建议等待（retryAfterMs）的上限。超过它就不在同一模型上等待重试，直接切兜底（没有兜底则失败），
 * 避免一次运行被「请 10 分钟后再试」之类的建议长时间挂起。
 */
const MAX_RETRY_AFTER_MS = 10_000;

/** 读事件日志的分页大小。 */
const READ_PAGE = 1000;

/**
 * 流式增量的出口（推给前端等订阅方）；`step_reset` 表示丢弃本步已推出的增量、重新开始。
 * `stream_end` (the step's model stream completed) and `step_end` (the step's `assistant_message`
 * is logged) carry no delta: the run worker's sink writes and then clears the step's live draft on
 * them (spec 2026-11-07 §3.2) and publishes neither.
 */
export type StreamSink = (delta: {
  kind: "text" | "thinking" | "step_reset" | "stream_end" | "step_end";
  runId: string;
  step: number;
  text?: string;
}) => void;

export interface ModelStepDeps {
  db: KernelSchemaDb;
  eventLog: EventLog;
  /**
   * The step's transactional writes (a model call with its tool specs, a denial with its audit row,
   * usage events with their owed `usage.report` deliveries, a sub-agent's counted usage).
   */
  stepLog: Pick<StepLog, "appendCounted" | "appendReported" | "appendAudited" | "appendWithSpecs">;
  registry: Pick<ProviderRegistry, "resolve">;
  /** 工具注册表：每步开始时解析 agent 引用的工具（状态可能在步骤之间变化）。 */
  tools: Pick<ToolRegistry, "forAgent">;
  config: Pick<KernelConfigService, "get">;
  /**
   * The compaction settings in effect for the run's organization (context compaction spec §4.8):
   * resolved once per model step.
   */
  compactionSettings: Pick<CompactionSettingsService, "resolve">;
  /**
   * Ephemeral compaction progress (context compaction spec §4.6): display-only, never in the log.
   * Absent in eval replays and single-step replays, which have no live conversation to show it on.
   */
  compactionProgress?: CompactionProgressSink;
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
  /**
   * The conversation's source (memory plugin spec §6.2): extension tools limited by
   * `spec.sources` are listed by it.
   */
  source: ConversationSource;
  /** Hooks fire for `chat` and `subagent` (never for eval replays). */
  conversationKind?: ConversationKindForHooks;
  /** A sub-agent's run: where it was dispatched from (hook payloads carry it as `parent`). */
  parent?: SubagentParent;
  /** A sub-agent's run without a live parent (a child case's eval replay, `LoopContext`). */
  subagent?: boolean;
  /**
   * A sub-agent's run (phase C): the parent run whose budget run's `subagent_tokens_used` counts
   * every usage event this step writes (step, wrap-up and compaction calls; spec §8.3, agent map
   * spec §6).
   */
  parentRunId?: string;
  /**
   * The run's step limit (`LoopContext.limits.maxSteps`) for the turn-limit reminder; a child's
   * may be below `runtime.maxSteps` (final review m4). Absent: the run has no step limit, and no
   * reminder is sent.
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

/**
 * The ladder's three rungs: the main model, one same-model retry and the fallback (see `ladder`).
 * A step may make more calls than this: reactive `model.context_overflow` fix-ups retry on the same
 * rung, all within {@link MAX_STEP_MODEL_CALLS}.
 */
export const MAX_MODEL_ATTEMPTS = 3;

/**
 * The most `model_call` rows one step may write (context compaction spec §4.4): the ladder's three
 * rungs plus up to two reactive-overflow fix-up retries. The ladder stops before a further attempt,
 * so a persistent `model.context_overflow` cannot loop.
 */
export const MAX_STEP_MODEL_CALLS = MAX_MODEL_ATTEMPTS + 2;

/** 本步解析出的工具与是否启用 ToolSearch（见 `ToolRegistry.forAgent`），以及本步已取的附件字节。 */
export interface StepTools {
  list: RequestTool[];
  toolSearch: boolean;
  /** 本步已取到的附件信息与字节；同一步的多次构建（压缩估算、各次尝试）共用。只缓存成功的结果。 */
  media: StepMedia;
}

/** What `ToolRegistry.forAgent` resolved for one request: the tools, ToolSearch and unavailable ones. */
export interface ResolvedAgentTools {
  tools: RequestTool[];
  toolSearch: boolean;
  unavailable: UnavailableTool[];
}

/**
 * The agent's tools for one request, resolved now (connectors and extensions can change between
 * steps): disabled tools and disabled sub-agent tools, a sub-agent's narrower roster, sandbox
 * scoping and replay mode, with `Skill` offered when the log has a catalog snapshot or an
 * invocation. The automatic step path and a manual compact run resolve them the same way, so the
 * compaction sees the same history a step would.
 */
export async function resolveAgentTools(
  deps: Pick<ModelStepDeps, "tools">,
  input: Pick<
    ModelStepInput,
    | "orgId"
    | "conversationId"
    | "agent"
    | "parent"
    | "parentRunId"
    | "subagent"
    | "source"
    | "conversationKind"
  >,
  events: readonly ConversationEvent[],
): Promise<ResolvedAgentTools> {
  const resolved = await deps.tools.forAgent(input.orgId, {
    disabledTools: input.agent.disabledTools,
    subagentTools: input.agent.subagentTools,
    subagents: input.agent.subagents,
    child: input.parent !== undefined || input.parentRunId !== undefined || input.subagent === true,
    forkChild: input.parent?.forSkill === true,
    sandboxConversationId: input.parent?.rootConversationId ?? input.conversationId,
    replay: input.conversationKind === "eval",
    source: input.source,
    skillLoad: skillLoadOffered(
      events.findLast(
        (e): e is Extract<ConversationEvent, { type: "skills_catalog" }> =>
          e.type === "skills_catalog",
      ),
      hasInvocation(events),
    ),
  });
  return {
    tools: resolved.tools,
    toolSearch: resolved.toolSearch === true,
    unavailable: resolved.unavailable,
  };
}

/** The step's {@link StepTools} from resolved tools: a fresh attachment cache unless one is shared. */
export function stepToolsOf(
  resolved: ResolvedAgentTools,
  input: Pick<ModelStepInput, "mediaCache">,
  deps: Pick<ModelStepDeps, "config">,
): StepTools {
  return {
    list: resolved.tools,
    toolSearch: resolved.toolSearch,
    media: {
      looked: new Set(),
      info: new Map(),
      bytes: new Map(),
      run: input.mediaCache ?? new MediaCache(deps.config.get().attachments.requestMediaBytes),
    },
  };
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
  toolsChanged: (runId: string, step: number, keys: readonly string[]) =>
    `tools_changed:${runId}:${step}:${createHash("sha256")
      .update(JSON.stringify([...keys].sort()))
      .digest("hex")
      .slice(0, 16)}`,
  modelCall: modelCallIdemKey,
  hookDenied: (runId: string, step: number, attempt: number) =>
    `hook_denied:${runId}:${step}:${attempt}`,
  /**
   * Usage of a compaction call: `n` is the compaction's ordinal in the step
   * ({@link compactionOrdinal}). A chunked compaction sends one call per chunk, so the chunk index
   * (1-based) is part of the key (context compaction spec §4.5).
   */
  compactionUsage: (runId: string, step: number, n: number, chunk?: number) =>
    chunk === undefined
      ? `usage_compaction:${runId}:${step}:${n}`
      : `usage_compaction:${runId}:${step}:${n}:${chunk}`,
  /**
   * The outcome of one compaction: `n` is its ordinal in the step ({@link compactionOrdinal}), so a
   * proactive summary and a forced one in the same step are two events (spec §4.4, revision
   * 2026-11-15). Retrying the same compaction after a crash writes nothing new; a manual compact run
   * is keyed by its run id and step 0 (context compaction spec §4.7).
   */
  compactionSummary: (runId: string, step: number, n: number) =>
    `compaction_summary:${runId}:${step}:${n}`,
  compactionFailed: (runId: string, step: number, n: number) =>
    `compaction_failed:${runId}:${step}:${n}`,
  mediaExcluded: (runId: string, step: number, attempt: number, part: number) =>
    `media_excluded:${runId}:${step}:${attempt}:${part}`,
};

/** The step result of a sub-agent whose budget a compaction call used up: no step request. */
const BUDGET_STOP: ModelStepResult = {
  content: [],
  stopReason: "end_turn",
  reused: false,
  aborted: false,
  usage: null,
  budget: true,
};

/** A forced compaction in the ladder used up the sub-agent's budget (see {@link BUDGET_STOP}). */
class BudgetUsedUp extends Error {
  constructor() {
    super("sub-agent budget used up by a compaction call");
    this.name = "BudgetUsedUp";
  }
}

/**
 * A sub-agent checks its budget again after a compaction call, so the step's own request is not a
 * second call over the cap (review M5; the loop checks before each step); the budget wrap-up is the
 * one call allowed over it.
 */
async function budgetUsedUpAfterCompaction(
  deps: ModelStepDeps,
  input: ModelStepInput,
  wrapUpReason: WrapUpReason | null,
): Promise<boolean> {
  if (wrapUpReason === "budget" || input.parentRunId === undefined) return false;
  return subagentBudgetUsedUp(
    deps.db,
    deps.config,
    input.orgId,
    input.parent?.budgetRunId ?? (await budgetRunOf(deps.db, input.parentRunId)),
  );
}

/** The reactive trim cannot reach any of its targets: no trim retry (spec §4.3 point 6). */
class NoReactiveTrim extends Error {
  constructor() {
    super("no reachable reactive trim");
    this.name = "NoReactiveTrim";
  }
}

/** The external signal fired: the step ends as aborted. */
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
  return runStep(deps, input, null);
}

/**
 * 单轮收尾：到达步数上限时调用一次。写入收尾 `reminder`（位于请求末尾）；照常带工具（历史里有工具调用时
 * 部分供应商要求请求声明工具，也保持缓存前缀稳定），但 `toolChoice: "none"`——模型只能回复文本。
 * 其余与 `runModelStep` 相同（幂等、降级、中止）。
 *
 * `reason: "budget"`: a sub-agent whose tree used its token budget makes this one call to hand back
 * what it found (sub-agents spec §8.3); it is not stopped by the budget again (one call over).
 */
export function runFinalWrapUp(
  deps: ModelStepDeps,
  input: ModelStepInput,
  reason: WrapUpReason = "max_steps",
): Promise<ModelStepResult> {
  return runStep(deps, input, reason);
}

async function runStep(
  deps: ModelStepDeps,
  input: ModelStepInput,
  /** The final call's reason, or null for an ordinary step. */
  wrapUpReason: WrapUpReason | null,
): Promise<ModelStepResult> {
  const wrapUp = wrapUpReason !== null;
  const { conversationId, runId, step, signal, sink } = input;
  const existing = await findExisting(deps.eventLog, conversationId, runId, step);
  if (existing) {
    // a crash between the assistant_message and clearing its draft leaves one behind
    sink({ kind: "step_end", runId, step });
    return existing;
  }

  const runtime = deps.config.get().runtime;
  /** 本次尝试已流出的文本；中止时写进 aborted 的 assistant_message。 */
  const streamed = { text: "" };
  try {
    if (signal.aborted) throw new StepAborted();
    let events = await readAllEvents(deps.eventLog, conversationId);
    // an earlier execution of this run already sent this step (it streamed, then crashed or was
    // handed over): this one starts at offset 0, so viewers drop that attempt's draft first
    if (
      events.some((e) => e.type === "model_call" && e.runId === runId && e.payload.step === step)
    ) {
      sink({ kind: "step_reset", runId, step });
    }
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
    // a skills catalog snapshot (Ruling M17; an empty one too) or a person's skill invocation in the
    // log → Skill is offered (see skillLoadOffered)
    const resolved = await resolveAgentTools(deps, input, events);
    const tools: StepTools = stepToolsOf(resolved, input, deps);
    const beforeCompaction = events.length;
    // the org's effective compaction settings, once for this step (org > platform > built-in)
    const compaction = await deps.compactionSettings.resolve(input.orgId);
    events = await maybeCompact(deps, input, events, runtime, compaction, tools);
    // a sub-agent checks its budget again after a compaction call, so the step's own request is
    // not a second call over the cap (review M5; the loop checks before each step); the budget
    // wrap-up is the one call allowed over it
    if (
      events.length !== beforeCompaction &&
      (await budgetUsedUpAfterCompaction(deps, input, wrapUpReason))
    ) {
      return BUDGET_STOP;
    }

    // the tool set changed since the previous request (an extension switched on, a sub-agent
    // roster added): tell the model before this request (tool naming spec §9.1). Keyed by the new
    // set, so a retried step finds it in the log (previousToolSet applies it) and writes nothing
    const toolKeys = resolved.tools.map((t) => t.key);
    const change = toolSetChange(events, toolKeys);
    if (change !== null) {
      events = await appendLocal(deps.eventLog, conversationId, events, {
        type: "tools_changed",
        runId,
        idemKey: idem.toolsChanged(runId, step, toolKeys),
        payload: { step, ...change },
      });
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

    let laddered: Awaited<ReturnType<typeof ladder>>;
    try {
      laddered = await ladder(
        deps,
        input,
        events,
        runtime,
        compaction,
        tools,
        wrapUpReason,
        streamed,
      );
    } catch (e) {
      // a forced compaction inside the ladder used up a sub-agent's budget (the same check as
      // after the proactive compaction above)
      if (e instanceof BudgetUsedUp) return BUDGET_STOP;
      throw e;
    }
    const { outcome, ref } = laddered;
    // assistant_message and usage in one append = one transaction, which also owes the usage's
    // usage.report delivery (transactional outbox spec §8.1)
    await appendCounted(deps, input, [
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
    sink({ kind: "step_end", runId, step });
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
    sink({ kind: "step_end", runId, step });
    return { content, stopReason: "aborted", reused: false, aborted: true, usage: null };
  }
}

/**
 * Appends a model call's events (its reply or compaction outcome with its `usage`; also the usage
 * of a `WebFetch` extraction call, `tools/builtins/web/extract.ts`) in one transaction that also
 * owes the `usage.report` delivery of the usage events it newly wrote (transactional outbox spec
 * §8.1). For a sub-agent's run (`input.parentRunId`) that transaction also adds their tokens to the
 * budget run's `subagent_tokens_used` (sub-agents spec §8.3): a usage event already in the log (an
 * idempotent hit after a crash) adds nothing, so each call counts and is reported exactly once.
 */
export async function appendCounted(
  deps: {
    eventLog: Pick<EventLog, "notify">;
    stepLog: Pick<StepLog, "appendCounted" | "appendReported">;
  },
  input: {
    conversationId: string;
    parentRunId?: string | undefined;
    /** The run's budget window (agent map spec §6), when known; else the parent run's. */
    budgetRunId?: string | undefined;
    parent?: { budgetRunId?: string | undefined } | undefined;
  },
  events: AppendEvent[],
): Promise<ConversationEvent[]> {
  const { conversationId, parentRunId } = input;
  const budgetRunId = input.budgetRunId ?? input.parent?.budgetRunId;
  const out =
    parentRunId === undefined
      ? await deps.stepLog.appendReported(conversationId, events)
      : await deps.stepLog.appendCounted(
          conversationId,
          { parentRunId, ...(budgetRunId !== undefined && { budgetRunId }) },
          events,
        );
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

/** 读会话的全部事件（读到当前 last_seq），按 seq 升序。A manual compact run reads it the same way. */
export async function readAllEvents(
  eventLog: Pick<EventLog, "readAfter">,
  conversationId: string,
): Promise<ConversationEvent[]> {
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
 * Appends one event and merges it into the step's local event list (an idempotent hit already in
 * the list is not added twice). The gap merge is {@link mergeWritten}'s: events written elsewhere
 * after `readAll` have a lower seq than this one, and a list that skipped them would claim to
 * include them through the request's `toSeq`.
 */
async function appendLocal(
  eventLog: EventLog,
  conversationId: string,
  events: ConversationEvent[],
  event: AppendEvent,
): Promise<ConversationEvent[]> {
  const [written] = await eventLog.append(conversationId, [event]);
  if (!written) return events;
  return mergeWritten(eventLog, conversationId, events, [written]);
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
  /**
   * The cap recorded in `model_call.request.maxOutputTokens` (a baseline replay only): the runtime
   * may have clamped it below the knob (context compaction spec §4.3), so a replay that recomputed
   * it from the knob would send a larger cap than the recorded one. Given, it wins over the knob.
   */
  recordedMaxOutputTokens?: number;
  /**
   * A recorded hard-fit plan (context compaction spec §4.3/§4.9): applied after the pairing guard,
   * so a replayed request equals the one that was sent. The plan's message indexes refer to the
   * assembled (post-guard) request; the runtime computes it on the same list.
   */
  fit?: FitPlan;
}

/**
 * 发给模型的请求（纯函数）：`buildModelRequest`（注入 `params` 与本步工具：模型不支持工具时不带；收尾调用带
 * `toolChoice: "none"`）→ `guardToolPairs` → the recorded `fit` plan (when given). 输出上限：参数里有
 * `maxOutputTokens` 旋钮时取 `min(模型上限, 旋钮)`，否则 `min(模型上限, defaultMaxOutputTokens)`；记录了输出
 * 上限的基线回放（`recordedMaxOutputTokens`）原样取记录值，旋钮不再覆盖。
 * 运行时（{@link runModelStep}）与由日志还原请求（`evals/reconstruct.ts`）共用这一份，二者不会漂移。
 */
export function assembleModelRequest(input: AssembleModelRequestInput): {
  request: ModelRequest;
  meta: ModelCallMeta;
  mediaTokens: number;
} {
  const { defaultMaxOutputTokens, recordedMaxOutputTokens, tools, fit, ...rest } = input;
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
  // the recorded cap already carries the clamp against the recorded window and estimate
  if (recordedMaxOutputTokens !== undefined) request.maxOutputTokens = recordedMaxOutputTokens;
  if (fit !== undefined) request.messages = applyFit(request, fit).messages;
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
    mediaBudgetBytes: deps.config.get().attachments.requestMediaBytes,
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
  const budget = deps.config.get().attachments.requestMediaBytes;
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
  for (const e of events) if (e.type === "usage" && e.payload.purpose === undefined) usage = e;
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

/** The step an event of a run belongs to, when its payload names one. */
function stepOf(e: ConversationEvent): number | undefined {
  const step = (e.payload as { step?: unknown }).step;
  return typeof step === "number" ? step : undefined;
}

/**
 * The ordinal of the next compaction of this run's `step`: 1 + the `compaction_summary` /
 * `compaction_failed` events the step already wrote (context compaction spec §4.4, revision
 * 2026-11-15). It keys the compaction's events (summary, failure, usage, hook denial), so every
 * compaction of a step writes its own, while a crash-retried compaction (nothing written yet) gets
 * the same keys again. Outcome events record their step, so they are counted by it. Older ones
 * have none: a run's step N compacts after every event of its earlier steps, so those are counted
 * from the run's last event of an earlier step on. The backoff keeps counting consecutive failures
 * ({@link consecutiveCompactionFailures}).
 */
function compactionOrdinal(
  events: readonly ConversationEvent[],
  runId: string,
  step: number,
): number {
  let recorded = 0;
  let legacy = 0;
  for (const e of events) {
    if (e.runId !== runId) continue;
    const of = stepOf(e);
    if (e.type === "compaction_summary" || e.type === "compaction_failed") {
      if (of === undefined) legacy++;
      else if (of === step) recorded++;
      continue;
    }
    if (of !== undefined && of < step) legacy = 0;
  }
  return recorded + legacy + 1;
}

/** Estimated input tokens of a plain text (a user message's only content). */
function textTokens(text: string): number {
  return estimateTokens([{ role: "user", content: [{ type: "text", text }] }], []);
}

/** Options of {@link maybeCompact}. */
interface CompactOptions {
  /**
   * The reactive path (context compaction spec §4.4): summarise regardless of the trigger,
   * `enabled: false` and the failure backoff. A proactive call leaves all of them in force.
   */
  force?: boolean;
  /**
   * The model to summarise with (default the agent's main model). The reactive path passes the rung
   * that overflowed: a fallback rung may have a smaller window and the summary must fit it.
   */
  ref?: ModelRef;
  /** Whether `ref` is the fallback rung (its saved params are `fallbackParams`). */
  fallback?: boolean;
}

/** What one compaction execution wrote: the events, the summary's seq and whether it failed. */
export interface CompactionOutcome {
  /** The step's event list with what the compaction wrote merged in (unchanged when it wrote none). */
  events: ConversationEvent[];
  /** The seq of the `compaction_summary` written; null when none was (skipped or failed). */
  summarySeq: number | null;
  /** Whether a `compaction_failed` was written (a failed call, a denial or a failed acceptance). */
  failed: boolean;
}

/**
 * Compaction: summarize the earlier conversation with the main model (consumed non-streaming) when
 * the calibrated estimate crosses the trigger (context compaction spec §4.1). The hard line
 * (`estimate + output > window`) ignores `enabled: false` and the failure backoff; the proactive
 * trigger respects both. Accepted → `compaction_summary`; too short or an error →
 * `compaction_failed` (attempt from 1, consecutive failures increment), and the step continues
 * unchanged. When the main model cannot be resolved right now, compaction is skipped and the
 * fallback ladder handles the step.
 *
 * `opts.force` (the reactive path, spec §4.4, and a manual compact run, spec §4.7) bypasses the
 * trigger, `enabled` and the backoff, and `opts.ref` makes it summarise with the rung's model rather
 * than the agent's main model.
 *
 * The one execution both paths run: the automatic step path through {@link maybeCompact} and a
 * manual compact run through `CompactionService.force`.
 */
export async function runCompaction(
  deps: ModelStepDeps,
  input: ModelStepInput,
  events: ConversationEvent[],
  runtime: Runtime,
  compaction: CompactionSettings,
  tools: StepTools,
  opts: CompactOptions = {},
): Promise<CompactionOutcome> {
  /** Nothing was written (the compaction was skipped): the step's own path just continues. */
  const skipped = (evs: ConversationEvent[]): CompactionOutcome => ({
    events: evs,
    summarySeq: null,
    failed: false,
  });
  const modelRef = opts.ref ?? input.agent.model;
  let provider: BoundProvider;
  let info: ModelInfo;
  try {
    ({ provider, info } = await deps.registry.resolve(input.orgId, modelRef));
  } catch (err) {
    deps.log.warn("compaction skipped: model unavailable", { model: modelRef, err });
    return skipped(events);
  }
  try {
    await loadMedia(deps, input, events, info, tools);
  } catch (err) {
    if (!(err instanceof MediaUnavailableError)) throw err;
    // storage is temporarily unavailable: skip compaction for this step and leave it to the
    // fallback ladder, which treats it as a retryable error
    deps.log.warn("compaction skipped: attachment storage unavailable", {
      conversationId: input.conversationId,
      err,
    });
    return skipped(events);
  }
  const { request: built, estimate: raw } = buildRequest(
    deps,
    events,
    input,
    info,
    attemptParams(input.agent, info, opts.fallback === true).value,
    runtime,
    tools,
    false,
  );
  const estimate = calibrate(raw, lastActual(events));
  // The trigger's output cap is the step's own cap, min(agent max, model max) (spec §4.1), not the
  // settings' maxOutputTokens — that one caps the summary call (spec §4.8).
  const output = built.maxOutputTokens;
  // planned with the bounds every step request uses (spec §4.1): O_p and R_p
  const bounds = planningBounds(info.contextWindow, output, compaction.reserveTokens);
  // The hard line ignores both gates: enabled: false turns proactive early compaction off only,
  // and backoff only delays proactive attempts (context compaction spec §4.1). The reactive path
  // (`force`) ignores the trigger entirely (spec §4.4).
  if (!opts.force) {
    if (estimate + bounds.output <= info.contextWindow && compactionBackoff(events))
      return skipped(events);
    if (!shouldCompact(estimate, info.contextWindow, { ...compaction, maxOutputTokens: output })) {
      return skipped(events);
    }
  }
  // the input room left for the kept tail: the planning target `W - O_p - R_p`, minus the system
  // prompt and tool definitions every request carries
  const tailBudget = bounds.target - estimateTokens([], built.system, built.tools);
  const plan = compactionPlan(events, compaction, tailBudget);
  if (!plan) return skipped(events);
  // decided now and recorded in the summary (spec §4.2): the request never depends on later events
  const opening = openingSeqs(events, input.runId, plan.coversUpToSeq, input.absorbedUpToSeq);

  const { runId, step, signal, conversationId } = input;
  const ref = modelRef;
  // §4.6 progress: from here the compaction is certain, so the conversation may show a row. It is
  // display-only (Redis + a bus message, never the log); a lost update costs nothing.
  const startedAt = Date.now();
  const progressOf = (progress: CompactionProgress): void => {
    deps.compactionProgress?.update({
      runId,
      conversationId,
      ...(input.agentId !== undefined && { agentId: input.agentId }),
      progress,
    });
  };
  progressOf({ phase: "preparing", step, startedAt });
  // the summary call's output cap: the org's effective setting, never above the model's own cap
  // (context compaction spec §4.8)
  const summaryCap = Math.min(compaction.maxOutputTokens, info.maxOutputTokens);
  // the payload's attempt drives the backoff; the keys use the compaction's ordinal in the step
  const attemptNo = consecutiveCompactionFailures(events) + 1;
  const ordinal = compactionOrdinal(events, runId, step);
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
  // §4.5: one summary call's input room is B = Wc - Cmax - R. The room the running summary takes
  // in the next call (at least half of the output cap) and the request's fixed overhead (the
  // instruction and the transcript wrapper) are subtracted from it, leaving the chunk size. A
  // transcript over it is summarised chunk by chunk, each call sent the running summary before its
  // chunk; the actual running summary can be up to the full output cap, so each call after the
  // first shrinks its chunk to that estimate. A degenerate budget (a window smaller than the cap,
  // the reserve, the overhead and the allowance, or one that leaves less than a usable chunk)
  // leaves the single call as before: a chunk below the floor would fail the first call instead.
  const budget = compactionInputBudget(info.contextWindow, summaryCap, compaction.reserveTokens);
  const overhead = compactionRequestOverhead();
  const allowance = Math.ceil(summaryCap / 2);
  const baseChunkSize = compactionChunkSize(budget, summaryCap);
  // the whole transcript is one call unless it is over a usable base chunk size
  let remaining: string | null =
    baseChunkSize >= MIN_COMPACTION_CHUNK_TOKENS && textTokens(plan.transcript) > baseChunkSize
      ? plan.transcript
      : null;
  /** Whether this compaction is chunked (real `i/N` progress only in this path). */
  const chunked = remaining !== null;
  /** The chunk count the current chunk size plans (updated when the running summary shrinks it). */
  let plannedChunks = chunked ? chunkTranscript(plan.transcript, baseChunkSize).length : 0;
  let lastChunkSize = baseChunkSize;

  let failure: string | null = null;
  /** The 1-based chunk whose call failed or was denied, when the compaction was chunked. */
  let failedChunk: number | null = null;
  let denial: { verdict: HookDenial; chunk: number } | null = null;
  let summary = "";
  /** Whether the compaction really took more than one call. */
  let multiChunk = false;
  /** The chunk calls made; the total is known only when the compaction ends. */
  let attempted = 0;
  const usages: { chunk: number | undefined; usage: ModelUsage }[] = [];
  for (;;) {
    let chunkText: string;
    if (remaining === null) {
      chunkText = plan.transcript;
    } else {
      // this call's chunk: the previous call's summary may be longer than the allowance, so
      // reserve its real estimate (the allowance is only the floor)
      const held = Math.max(
        allowance,
        summary === "" ? 0 : textTokens(`[Earlier summary]\n${summary}\n\n`),
      );
      const size = Math.min(baseChunkSize, budget - overhead - held);
      // A chunk below the floor would make nextTranscriptChunk clamp to one token: fail with a
      // clear reason instead of a call storm (context compaction spec §4.5).
      if (size < MIN_COMPACTION_CHUNK_TOKENS) {
        failure = `the running summary leaves too little room for a chunk (${Math.max(0, size)} tokens, at least ${MIN_COMPACTION_CHUNK_TOKENS} needed)`;
        failedChunk = attempted + 1;
        break;
      }
      const next = nextTranscriptChunk(remaining, size);
      if (next === null) break;
      chunkText = next.chunk;
      remaining = next.rest.length === 0 ? null : next.rest;
      if (remaining !== null) multiChunk = true;
      // the real total, recomputed only when the running summary shrank this call's chunk
      if (size !== lastChunkSize) {
        lastChunkSize = size;
        plannedChunks =
          attempted + 1 + (remaining === null ? 0 : chunkTranscript(remaining, size).length);
      }
    }
    attempted++;
    const chunkNo = attempted;
    const current = {
      phase: "summarizing" as const,
      step,
      startedAt,
      ...(chunked ? { chunk: chunkNo, chunks: plannedChunks } : {}),
      chars: 0,
    };
    progressOf(current);
    // call 1 summarises chunk 1; call i carries the running summary before its chunk, which the
    // instruction merges (compactionPlan formats a previous summary the same way)
    const callInput = summary === "" ? chunkText : `[Earlier summary]\n${summary}\n\n${chunkText}`;
    const request = buildCompactionRequest(callInput, info.id, summaryCap);
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
        if (signal.aborted) {
          // an aborted attempt leaves no partial summary: drop the progress key now rather than
          // leaving the writer-local throttle entry behind until the TTL (folded review Minor)
          deps.compactionProgress?.clear(runId);
          throw new StepAborted();
        }
        throw e;
      }
      if (!verdict.allowed) {
        denial = { verdict, chunk: chunkNo };
        break;
      }
    }
    const sentAt = Date.now();
    try {
      let partial = "";
      const out = await consumeModelStream(
        provider,
        request,
        info.streamIdleTimeoutMs ?? runtime.streamIdleMs,
        signal,
        (ev) => {
          if (ev.type !== "text_delta") return;
          partial += ev.text;
          // throttled by the sink (≤ once per 200 ms); real characters, never a percentage
          progressOf({
            phase: "summarizing",
            step,
            startedAt,
            ...(chunked ? { chunk: chunkNo, chunks: plannedChunks } : {}),
            chars: partial.length,
          });
        },
      );
      usages.push({ chunk: multiChunk ? chunkNo : undefined, usage: out.usage });
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
      // store only the <summary> block: the <analysis> scratchpad must not enter later requests
      summary = extractSummary(final || partial);
      // an intermediate call with nothing to carry forward would silently drop every chunk before
      // it: fail the compaction instead (spec §4.5), no partial summary
      if (remaining !== null && summary === "") {
        failure = "a chunk produced no summary";
        failedChunk = multiChunk ? chunkNo : null;
        break;
      }
      // the last call's text is the summary, accepted against the full transcript (spec §4.5)
      if (remaining === null && !acceptSummary(summary, plan.transcript)) {
        failure = `summary too short (${summary.length} chars)`;
        failedChunk = multiChunk ? chunkNo : null;
      }
    } catch (err) {
      if (err instanceof StepAborted) {
        // aborted mid-call: clear the progress key here (the success and failure paths clear at
        // the end; the abort path throws past them)
        deps.compactionProgress?.clear(runId);
        throw err;
      }
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
      failedChunk = multiChunk ? chunkNo : null;
      break;
    }
    if (failure !== null || denial !== null) break;
    // the whole transcript was this one call, or its last chunk is done
    if (remaining === null) break;
  }

  // only a compaction that still has something to write shows the writing phase: a failed or denied
  // one jumps straight to its failure event (folded review Minor)
  if (failure === null && denial === null) {
    progressOf({ phase: "writing", step, startedAt });
  }

  /** The chunk a failure stopped at, for the reason (empty when the compaction was not chunked). */
  const chunkNote = (chunk: number | null): string => (chunk === null ? "" : ` (chunk ${chunk})`);

  /** One usage event per completed call (spec §4.5); a chunked call carries its chunk index. */
  const usageEvents = (): AppendEvent[] =>
    usages.map(({ chunk, usage }) => ({
      type: "usage" as const,
      runId,
      idemKey: idem.compactionUsage(runId, step, ordinal, chunk),
      payload: {
        step,
        provider: ref.provider,
        model: ref.model,
        ...usage,
        purpose: "compaction" as const,
        ...(chunk !== undefined ? { chunk, chunks: attempted } : {}),
      },
    }));

  if (denial !== null) {
    // compaction fails (generic reason in the log, raw detail only in the audit row, R12); the
    // step continues and its own request meets the hooks next
    const verdict = denial.verdict;
    const site = {
      orgId: input.orgId,
      conversationId,
      runId,
      ...(input.accountId !== undefined && { accountId: input.accountId }),
      ...(input.agentId !== undefined && { agentId: input.agentId }),
      idemKey: `hook_denied_compaction:${runId}:${step}:${ordinal}`,
    };
    const denied = hookDeniedEvent(site, "model.request", verdict, { step, attempt: 1 });
    const entry = hookDeniedAudit(site, denied.payload, verdict);
    entry.detail = { ...entry.detail, purpose: "compaction" };
    const failed: AppendEvent = {
      type: "compaction_failed",
      runId,
      idemKey: idem.compactionFailed(runId, step, ordinal),
      payload: {
        attempt: attemptNo,
        step,
        reason: `compaction request blocked by the "${verdict.plugin}" policy hook (${verdict.cause})${chunkNote(multiChunk ? denial.chunk : null)}`,
      },
    };
    deps.log.warn("compaction blocked by a policy hook", {
      conversationId,
      plugin: verdict.plugin,
      cause: verdict.cause,
    });
    // the chunk calls that completed before the denial are still billed and reported
    const billed = usages.length > 0 ? await appendCounted(deps, input, usageEvents()) : [];
    const written = await deps.stepLog.appendAudited(conversationId, [failed], entry);
    if (written.length > 0) {
      await deps.eventLog.notify(conversationId, Math.max(...written.map((e) => e.seq)));
    }
    const merged = await mergeWritten(deps.eventLog, conversationId, events, [
      ...billed,
      ...written,
    ]);
    deps.compactionProgress?.clear(runId);
    return { events: merged, summarySeq: null, failed: true };
  }

  if (failure !== null) {
    deps.log.warn("compaction failed", { conversationId, reason: failure });
  }
  const event: AppendEvent =
    failure === null
      ? {
          type: "compaction_summary",
          runId,
          // the manual compact run's run id is in it; a crash-retried attempt writes nothing twice
          idemKey: idem.compactionSummary(runId, step, ordinal),
          payload: {
            coversUpToSeq: plan.coversUpToSeq,
            text: summary,
            // the run's opening messages the summary covers: request building re-renders them
            ...(opening.length > 0 && { openingSeqs: opening }),
            // what compaction saved: the estimated transcript input minus the stored summary
            // output (context compaction spec §4.9)
            savedTokens: summarySavedTokens(plan.transcript, summary),
            step,
          },
        }
      : {
          type: "compaction_failed",
          runId,
          idemKey: idem.compactionFailed(runId, step, ordinal),
          payload: { attempt: attemptNo, step, reason: `${failure}${chunkNote(failedChunk)}` },
        };
  // the compaction calls' usage (I-1): logged with the outcome in one append (one transaction),
  // marked `purpose: "compaction"` so step consumers (calibration, trajectory steps, replay plans)
  // skip it; a chunked compaction writes one per call, each keyed by its chunk
  const batch: AppendEvent[] = [event, ...usageEvents()];
  const written = await appendCounted(deps, input, batch);
  const merged = await mergeWritten(deps.eventLog, conversationId, events, written);
  deps.compactionProgress?.clear(runId);
  return {
    events: merged,
    summarySeq:
      failure === null ? (written.find((e) => e.type === "compaction_summary")?.seq ?? null) : null,
    failed: failure !== null,
  };
}

/**
 * The automatic path's compaction: {@link runCompaction} under the trigger's gates, returning only
 * the step's event list (the step does not care whether a summary was written).
 */
async function maybeCompact(
  deps: ModelStepDeps,
  input: ModelStepInput,
  events: ConversationEvent[],
  runtime: Runtime,
  compaction: CompactionSettings,
  tools: StepTools,
  opts: CompactOptions = {},
): Promise<ConversationEvent[]> {
  return (await runCompaction(deps, input, events, runtime, compaction, tools, opts)).events;
}

/**
 * Merges events we just wrote into the step's local list, reading any gap first (the guarantee
 * {@link appendLocal} gives): another writer may have appended an event between the local maximum
 * and a seq we wrote, and a request built from a list that skipped it would claim (through its
 * `toSeq`) to include an event it does not carry. Idempotent hits already in the list are not added
 * twice; the result is ordered by seq.
 */
async function mergeWritten(
  eventLog: Pick<EventLog, "readAfter">,
  conversationId: string,
  events: ConversationEvent[],
  written: readonly ConversationEvent[],
): Promise<ConversationEvent[]> {
  const fresh = written
    .filter((w) => !events.some((e) => e.seq === w.seq))
    .sort((a, b) => a.seq - b.seq);
  if (fresh.length === 0) return events;
  const out = [...events];
  let after = events.reduce((m, e) => Math.max(m, e.seq), 0);
  for (const w of fresh) {
    while (w.seq > after + 1) {
      const page = await eventLog.readAfter(
        conversationId,
        after,
        Math.min(READ_PAGE, w.seq - after - 1),
      );
      const inGap = page.filter((e) => e.seq > after && e.seq < w.seq);
      out.push(...inGap);
      const last = inGap.at(-1);
      if (!last || inGap.length < page.length) break;
      after = last.seq;
    }
    out.push(w);
    after = w.seq;
  }
  return out.sort((a, b) => a.seq - b.seq);
}

/**
 * 降级梯子：主模型 → 主模型重试一次（等 `retryAfterMs ?? 1000`，可被中止）→ `agent.fallback`（若有）。
 * 建议等待超过 `MAX_RETRY_AFTER_MS` 时跳过同模型重试。
 * 每次尝试解析出模型后、写 `model_call` 之前写本步的尾部提醒（均按本步幂等，只写一次）：所用模型不支持工具而本步有工具
 * → {@link TOOLS_UNSUPPORTED_REMINDER}；然后是轮次提醒或收尾提醒（收尾提醒因此位于请求末尾）。
 * 每次实际尝试写自己的 `model_call`（attempt 从 1 连续递增，跳过的不计）；重试前经 sink 发 `step_reset`。
 * 不可重试的失败或梯子用尽 → `RunError`; except that the agent's own model failing to resolve as
 * `agent.model_unavailable` (gone from the list, disabled since the agent was saved, its provider
 * not configured in the org: spec B §5.3) goes straight to `agent.fallback` when there is one,
 * without the same-model retry.
 */
async function ladder(
  deps: ModelStepDeps,
  input: ModelStepInput,
  events: ConversationEvent[],
  runtime: Runtime,
  compaction: CompactionSettings,
  tools: StepTools,
  wrapUpReason: WrapUpReason | null,
  streamed: { text: string },
): Promise<{ outcome: StreamOutcome; ref: ModelRef }> {
  const { conversationId, runId, step, signal, sink, agent } = input;
  const wrapUp = wrapUpReason !== null;
  const turnReminder =
    wrapUpReason === "budget"
      ? BUDGET_WRAP_UP_REMINDER
      : wrapUp
        ? WRAP_UP_REMINDER
        : input.maxSteps === undefined
          ? null
          : turnLimitReminder(step, input.maxSteps);
  let evs = events;
  const rungs: { ref: ModelRef; fallback: boolean }[] = [
    { ref: agent.model, fallback: false },
    { ref: agent.model, fallback: false },
  ];
  if (agent.fallback) rungs.push({ ref: agent.fallback, fallback: true });

  let last: Failure | undefined;
  /** The agent's model did not resolve (`agent.model_unavailable`): only the fallback is left. */
  let mainUnavailable = false;
  /** A reactive overflow used up this step's fix-ups: only the fallback (a different window) is left. */
  let skipToFallback = false;
  let attempt = 0;
  // hooks fire only for chat runs that have a registry (eval replays omit it, P-18)
  const scope = hookScope(deps.hooks, input);
  /** The attachments whose bytes the last sent request carried (a provider rejection excludes them). */
  let sentMedia: string[] = [];
  for (const rung of rungs) {
    if ((mainUnavailable || skipToFallback) && !rung.fallback) continue;
    if (last && !rung.fallback && (last.retryAfterMs ?? 0) > MAX_RETRY_AFTER_MS) {
      deps.log.warn("model retry skipped: suggested wait exceeds cap", {
        conversationId,
        runId,
        step,
        retryAfterMs: last.retryAfterMs,
      });
      continue;
    }
    // reactive `model.context_overflow` fix-ups, at most one of each per rung (context compaction
    // spec §4.4): media exclusion, forced compaction, then a progressive trim
    let mediaFixup = false;
    let compactFixup = false;
    let trimFixup = false;
    /** Force a compaction call before this rung's next attempt. */
    let forceCompact = false;
    /** Apply the progressive reactive trim to this rung's next attempt. */
    let trimPending = false;
    /** This attempt is a same-rung overflow fix-up (no same-model retry delay). */
    let sameRung = false;
    for (;;) {
      // a step writes at most MAX_STEP_MODEL_CALLS model_call rows, then stops: never a loop
      if (attempt >= MAX_STEP_MODEL_CALLS) break;
      attempt++;
      if (last) {
        sink({ kind: "step_reset", runId, step });
        streamed.text = "";
        if (!rung.fallback && !sameRung) {
          await abortableSleep(last.retryAfterMs ?? DEFAULT_RETRY_DELAY_MS, signal);
        }
      }
      sameRung = false;
      sentMedia = [];
      /** Whether this attempt applies the reactive trim. */
      const trimForAttempt = trimPending;
      trimPending = false;
      /** When the request went out (model.response fires only for sent requests). */
      let sentAt: number | undefined;
      /** Whether this attempt resolved its model (a failure before it is a resolve failure). */
      let resolved = false;
      try {
        const { provider, info } = await deps.registry.resolve(input.orgId, rung.ref);
        resolved = true;
        if (forceCompact) {
          forceCompact = false;
          // the rung's model, not the agent's: a fallback may have a smaller window (spec §4.4)
          const before = evs;
          evs = await maybeCompact(deps, input, evs, runtime, compaction, tools, {
            force: true,
            ref: rung.ref,
            fallback: rung.fallback,
          });
          if (evs !== before && (await budgetUsedUpAfterCompaction(deps, input, wrapUpReason))) {
            throw new BudgetUsedUp();
          }
        }
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
        // the hard fit guard (context compaction spec §4.3): the target is `W - O_p - R_p` (the
        // planning bounds, §4.1), a request over it is trimmed deterministically, and only then is
        // the cap clamped from the input actually sent, keeping the reserve (`clamp(O, 1, W - input
        // - R_p)`). The plan is recorded and replayed byte-for-byte. The last resorts, in order
        // (§4.3 point 5): one forced compaction with this rung's model, the squeezed fit, then
        // `run.context_too_large` before any call.
        const fit = async () => {
          await loadMedia(deps, input, evs, info, tools);
          const built = buildRequest(deps, evs, input, info, params.value, runtime, tools, wrapUp);
          const { request, estimate } = built;
          const fitInput = {
            events: evs,
            request,
            model: info,
            maxOutputTokens: request.maxOutputTokens,
            reserveTokens: compaction.reserveTokens,
            estimate,
          };
          const { target } = planningBounds(
            info.contextWindow,
            request.maxOutputTokens,
            compaction.reserveTokens,
          );
          const planned = trimForAttempt ? planReactiveTrim(fitInput) : planFit(fitInput);
          const reached =
            planned === null || estimateAfterFit(request, estimate, planned) <= target;
          return { ...built, fitInput, target, planned, reached };
        };
        let fitted = await fit();
        // the reactive trim reaches none of its targets (or there is nothing to trim): no retry,
        // the overflow surfaces (spec §4.3 point 6)
        if (trimForAttempt && fitted.planned === null) throw new NoReactiveTrim();
        if (!trimForAttempt && !fitted.reached && !compactFixup) {
          // the strict plan cannot reach the target (a fallback rung with a smaller window, a huge
          // latest turn): compact once with this rung's model (a fallback's window may be smaller,
          // spec §4.4), rebuild and plan again within this attempt. It is the rung's compaction
          // fix-up, so a later context_overflow on this rung goes to the trim.
          compactFixup = true;
          const before = evs;
          evs = await maybeCompact(deps, input, evs, runtime, compaction, tools, {
            force: true,
            ref: rung.ref,
            fallback: rung.fallback,
          });
          if (evs !== before) {
            if (await budgetUsedUpAfterCompaction(deps, input, wrapUpReason)) {
              throw new BudgetUsedUp();
            }
            fitted = await fit();
          }
        }
        const { request, meta, estimate, fitInput } = fitted;
        /** `O`: the configured cap (min of the agent's and the model's), before the clamp. */
        const output = request.maxOutputTokens;
        let target = fitted.target;
        let planned = fitted.planned;
        if (!trimForAttempt && !fitted.reached) {
          // still out of reach: plan against `W - 1 - R_p` (the output takes what is left, the
          // reserve stays); the cap sent is clamped after it like any other
          ({ plan: planned, target } = planSqueezedFit(fitInput));
        }
        let sentEstimate = estimate;
        if (planned !== null) {
          const after = estimateAfterFit(request, estimate, planned);
          // a reactive trim plan reached its target; the ordinary guard stays strict and fails
          // before any provider call
          if (!trimForAttempt && after > target) {
            throw new RunError("run.context_too_large", contextTooLargeText(info, target, after));
          }
          sentEstimate = after;
        }
        // O' = clamp(O, 1, W - inputAfterFit - R_p): recorded as the request's maxOutputTokens
        request.maxOutputTokens = sentOutputCap(
          info.contextWindow,
          output,
          sentEstimate,
          compaction.reserveTokens,
        );
        const sentRequest = planned === null ? request : applyFit(request, planned);
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
                request: hookRequestOf(sentRequest, deps.log),
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
        const written = await deps.stepLog.appendWithSpecs(
          conversationId,
          tools.list.filter((x) => sent.has(x.specHash)),
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
                  ...(planned !== null && { fit: planned }),
                  // the request actually sent (post-fit): calibration and the trigger read this value
                  estimatedInputTokens: sentEstimate,
                },
              },
            },
          ],
        );
        await deps.eventLog.notify(conversationId, Math.max(...written.map((e) => e.seq)));
        sentAt = Date.now();
        const outcome = await consumeModelStream(
          provider,
          sentRequest,
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
        // the draft's last write, before the assistant_message is logged
        sink({ kind: "stream_end", runId, step });
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
        if (err instanceof BudgetUsedUp) throw err;
        if (err instanceof NoReactiveTrim) {
          // nothing was sent for this attempt: it takes no number, and the overflow that asked for
          // the trim is what the rung ends with (a fallback model, a different window, may remain)
          attempt--;
          if (!rung.fallback && agent.fallback) {
            skipToFallback = true;
            break;
          }
          const f = last as Failure;
          throw new RunError(f.code, f.message);
        }
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
        if (
          !resolved &&
          !rung.fallback &&
          agent.fallback &&
          err instanceof ApiError &&
          !(err instanceof ProviderListError) &&
          err.code === "agent.model_unavailable"
        ) {
          mainUnavailable = true;
          last = f;
          break;
        }
        if (f.code === "model.context_overflow") {
          // reactive fix-ups, one of each per rung (context compaction spec §4.4). Each retries this
          // rung in the same step, so it consumes one attempt.
          if (sentMedia.length > 0 && !mediaFixup) {
            mediaFixup = true;
            // record the rejection and merge it in: the retry rebuilds from the log and the bytes
            // become "rejected" placeholders. A failed write cannot change the log, so retrying
            // the same bytes would overflow again: skip the media retry and fall through to the
            // forced compaction instead.
            let recorded = false;
            try {
              evs = await mergeWritten(
                deps.eventLog,
                conversationId,
                evs,
                await excludeMedia(deps, input, attempt, sentMedia),
              );
              recorded = true;
            } catch (e) {
              deps.log.warn("cannot record media_excluded", {
                conversationId,
                runId,
                step,
                err: e,
              });
            }
            if (recorded) {
              last = f;
              sameRung = true;
              continue;
            }
          }
          if (!compactFixup) {
            compactFixup = true;
            forceCompact = true;
            last = f;
            sameRung = true;
            continue;
          }
          if (!trimFixup) {
            trimFixup = true;
            trimPending = true;
            last = f;
            sameRung = true;
            continue;
          }
          // exhausted: a fallback model (a different window) is the only rung worth trying
          if (!rung.fallback && agent.fallback) {
            skipToFallback = true;
            last = f;
            break;
          }
          throw new RunError(f.code, f.message);
        }
        if (!f.retryable) {
          if (REJECTS_MEDIA.has(f.code) && sentMedia.length > 0) {
            // recording the failure must not hide the original code: log only, and fail the run
            // with the original error as before
            try {
              await excludeMedia(deps, input, attempt, sentMedia);
            } catch (e) {
              deps.log.warn("cannot record media_excluded", {
                conversationId,
                runId,
                step,
                err: e,
              });
            }
          }
          throw new RunError(f.code, f.message);
        }
        last = f;
        break;
      }
    }
  }
  const f = last as Failure;
  throw new RunError(f.code, f.message);
}

/** 不可重试、且可能由请求里的媒体引起的失败：带了媒体字节时写 `media_excluded`（Ruling M8）。 */
const REJECTS_MEDIA = new Set(["model.invalid_request"]);

/**
 * 供应商拒收了带媒体的请求：把这些附件记进 `media_excluded`（每条最多 {@link MEDIA_EXCLUDED_MAX_IDS} 个），
 * 之后的请求一律换成占位，会话不会因同一个附件永久卡住（可由日志推出）。
 *
 * The reactive path merges the returned events into the step's local list and retries in the same
 * step (context compaction spec §4.4); the non-retryable path lets the run fail as before.
 */
async function excludeMedia(
  deps: ModelStepDeps,
  input: ModelStepInput,
  attempt: number,
  ids: readonly string[],
): Promise<ConversationEvent[]> {
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
  return deps.eventLog.append(conversationId, events);
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
  provider: BoundProvider,
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
