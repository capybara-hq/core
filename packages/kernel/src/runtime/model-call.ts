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
import type { AgentDefinition, ModelRef } from "../agents/definition.js";
import type { KernelConfig } from "../config/schema.js";
import type { AppendEvent, EventLog } from "../conversations/event-log.js";
import type { ConversationEvent } from "../conversations/events.js";
import type { KernelDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import type { ToolRegistry, UnavailableTool } from "../tools/registry.js";
import { recordToolSpecs } from "../tools/specs.js";
import {
  buildModelRequest,
  latestSummary,
  type ModelCallMeta,
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
import { ProviderListError, type ProviderRegistry } from "./providers.js";

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
  registry: ProviderRegistry;
  /** 工具注册表：每步开始时解析 agent 引用的工具（状态可能在步骤之间变化）。 */
  tools: Pick<ToolRegistry, "forAgent">;
  config: () => KernelConfig;
  log: Logger;
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
}

export interface ModelStepResult {
  content: ContentBlock[];
  stopReason: StopReason | "aborted";
  /** 本步的 `assistant_message` 已存在（幂等命中），未调用模型。 */
  reused: boolean;
  aborted: boolean;
  usage: ModelUsage | null;
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

/** 本步解析出的工具与是否启用 tool_search（见 `ToolRegistry.forAgent`）。 */
interface StepTools {
  list: RequestTool[];
  toolSearch: boolean;
}

const idem = {
  assistant: assistantIdemKey,
  usage: (runId: string, step: number) => `usage:${runId}:${step}`,
  reminder: (runId: string, step: number) => `reminder:${runId}:${step}`,
  toolsUnavailable: (runId: string, step: number) => `tools_unavailable:${runId}:${step}`,
  toolsUnsupported: (runId: string, step: number) => `tools_unsupported:${runId}:${step}`,
  modelCall: modelCallIdemKey,
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

interface StreamOutcome {
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
  if (existing) return existing;

  const runtime = deps.config().runtime;
  /** 本次尝试已流出的文本；中止时写进 aborted 的 assistant_message。 */
  const streamed = { text: "" };
  try {
    if (signal.aborted) throw new StepAborted();
    let events = await readAll(deps.eventLog, conversationId);
    // 每步实时解析（应用 / 插件状态可能在步骤之间变化），解析结果记在 model_call；收尾调用同样带工具
    const resolved = await deps.tools.forAgent(input.orgId, { tools: input.agent.tools ?? [] });
    const tools: StepTools = { list: resolved.tools, toolSearch: resolved.toolSearch === true };
    events = await maybeCompact(deps, input, events, runtime, tools);

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
    await deps.eventLog.append(conversationId, [
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

/** 追加一条事件并并入本地事件列表（幂等命中已在列表中的不重复加入）。 */
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

/**
 * 由事件构建模型请求：`buildModelRequest`（注入 `params` 与本步工具：模型不支持工具时不带；收尾调用带
 * `toolChoice: "none"`）→ `guardToolPairs`。输出上限：
 * 参数里有 `maxOutputTokens` 旋钮时取 `min(模型上限, 旋钮)`，否则 `min(模型上限, runtime.maxOutputTokens)`。
 *
 * 调用方不变式：不得在「已记录 tool_call、尚未记录其 tool_result」之间构建请求——
 * 否则配对守卫会给进行中的调用补上 unknown 结果并发给模型。运行循环在工具结果落日志后才进入下一步。
 */
function buildRequest(
  events: ConversationEvent[],
  input: ModelStepInput,
  info: ModelInfo,
  params: Record<string, ParamValue>,
  runtime: Runtime,
  tools: StepTools,
  wrapUp: boolean,
): { request: ModelRequest; meta: ModelCallMeta; estimate: number } {
  const { request, meta } = buildModelRequest({
    events,
    agent: input.agent,
    agentVersion: input.agentVersion,
    model: info,
    step: input.step,
    absorbedUpToSeq: input.absorbedUpToSeq,
    params,
    tools: info.capabilities.tools ? tools.list : [],
    toolSearch: tools.toolSearch,
    ...(wrapUp && { toolChoice: "none" as const }),
  });
  request.messages = guardToolPairs(request.messages);
  const knob = params.maxOutputTokens;
  request.maxOutputTokens = Math.min(
    info.maxOutputTokens,
    typeof knob === "number" ? knob : runtime.maxOutputTokens,
  );
  return {
    request,
    meta,
    estimate: estimateTokens(request.messages, request.system, request.tools),
  };
}

/**
 * 上一次成功调用的「未校正估算 vs 真实输入 token」：最近的 usage 及其之前最近的 model_call。
 * 真实输入取 `inputTokens + cacheReadTokens + cacheWriteTokens`（`inputTokens` 只是未缓存部分，
 * 见 plugin-sdk `ModelUsage`）；只用 `inputTokens` 会在大量缓存命中时把估算压到下限，压缩永不触发。
 */
function lastActual(events: ConversationEvent[]): { estimate: number; inputTokens: number } | null {
  let usage: (ConversationEvent & { type: "usage" }) | undefined;
  for (const e of events) if (e.type === "usage") usage = e;
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
  const { request } = buildRequest(
    events,
    input,
    info,
    attemptParams(input.agent, info, false).value,
    runtime,
    tools,
    false,
  );
  const estimate = calibrate(
    estimateTokens(request.messages, request.system, request.tools),
    lastActual(events),
  );
  if (!shouldCompact(estimate, info, runtime.compactionThreshold)) return events;
  const plan = compactionPlan(events, runtime.keepRecentTurns);
  if (!plan) return events;

  let failure: string | null = null;
  let summary = "";
  try {
    let partial = "";
    const out = await consume(
      provider,
      buildCompactionRequest(plan.transcript, info.id),
      info.streamIdleTimeoutMs ?? runtime.streamIdleMs,
      input.signal,
      (ev) => {
        if (ev.type === "text_delta") partial += ev.text;
      },
    );
    const final = out.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    summary = (final || partial).trim();
    if (!acceptSummary(summary, plan.transcript)) {
      failure = `summary too short (${summary.length} chars)`;
    }
  } catch (err) {
    if (err instanceof StepAborted) throw err;
    failure = err instanceof Error ? err.message : String(err);
  }

  const event: AppendEvent =
    failure === null
      ? {
          type: "compaction_summary",
          runId: input.runId,
          payload: { coversUpToSeq: plan.coversUpToSeq, text: summary },
        }
      : {
          type: "compaction_failed",
          runId: input.runId,
          payload: { attempt: consecutiveCompactionFailures(events) + 1, reason: failure },
        };
  if (failure !== null) {
    deps.log.warn("compaction failed", { conversationId: input.conversationId, reason: failure });
  }
  return appendLocal(deps.eventLog, input.conversationId, events, event);
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
  const turnReminder = wrapUp ? WRAP_UP_REMINDER : turnLimitReminder(step, runtime.maxSteps);
  let evs = events;
  const rungs: { ref: ModelRef; fallback: boolean }[] = [
    { ref: agent.model, fallback: false },
    { ref: agent.model, fallback: false },
  ];
  if (agent.fallback) rungs.push({ ref: agent.fallback, fallback: true });

  let last: Failure | undefined;
  let attempt = 0;
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
      const { request, meta, estimate } = buildRequest(
        evs,
        input,
        info,
        params.value,
        runtime,
        tools,
        wrapUp,
      );
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
      const outcome = await consume(
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
      return { outcome, ref: rung.ref };
    } catch (err) {
      if (err instanceof StepAborted) throw err;
      if (signal.aborted) throw new StepAborted();
      const f = classify(err);
      deps.log.warn("model call attempt failed", {
        conversationId,
        runId,
        step,
        attempt,
        code: f.code,
        retryable: f.retryable,
        error: f.message,
      });
      if (!f.retryable) throw new RunError(f.code, f.message);
      last = f;
    }
  }
  const f = last as Failure;
  throw new RunError(f.code, f.message);
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
 */
async function consume(
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
