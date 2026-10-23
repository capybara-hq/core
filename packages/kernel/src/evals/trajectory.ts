import type { ModelUsage } from "@capybara-hq/plugin-sdk";
import type { ConversationEvent, EventPayload } from "../conversations/events.js";
import { costOf, type PriceTable, priceKey } from "../models/prices.js";

/**
 * 轨迹读模型（D6、C2）：由会话事件日志推出每次运行的步骤、模型调用与工具调用，纯函数、不读库。
 * 延迟与耗时只由事件的 `created_at` 推出，不加事件字段；成本读时按价格表算，不写日志。
 */

/** 一次模型请求（一条 `model_call` 事件）。 */
export interface TrajectoryModelCall {
  seq: number;
  step: number;
  attempt: number;
  provider: string;
  model: string;
  fallback: boolean;
  startedAt: string;
  /** 该步 `usage` 时间 − `model_call` 时间；失败 / 进行中为 null。 */
  latencyMs: number | null;
  /** 该步写了 usage 且本次是最后一次尝试 → ok；运行未结束且该步还没有回复 → pending；其余为 failed。 */
  outcome: "ok" | "failed" | "pending";
  usage: ModelUsage | null;
  /** 估算成本（币种见响应的 `currency`）；没有用量或没有价格时为 null。 */
  cost: number | null;
  request: EventPayload<"model_call">["request"];
}

/** A plugin policy hook's denial (`hook_denied`); `detail` is the raw hook error, never model-visible. */
export interface TrajectoryHookDenial {
  plugin: string;
  reason: string;
  cause: "deny" | "hook_error" | "timeout";
  detail?: string;
}

/** 一次工具调用（模型回复里的一个 `tool_call` 块）。 */
export interface TrajectoryToolCall {
  callId: string;
  step: number;
  toolKey: string;
  /** 取自该步 `assistant_message` 里的 `tool_call` 块。 */
  input: unknown;
  /** 最后一次 `tool_call_started`（输入请求之后会再次执行）；从未开始执行（如审批被拒）为 null。 */
  startedAt: string | null;
  /** `tool_result` − 最后一次 `tool_call_started`；不含等待审批 / 用户输入的时间。 */
  durationMs: number | null;
  result: { content: string; isError: boolean; outputId?: string } | null;
  /** 最近一次审批（定义变了会重新审批）。 */
  approval: {
    approvalId: string;
    requestedAt: string;
    decision: "approved" | "denied" | "expired" | "cancelled" | null;
    scope?: "once" | "session" | "always";
    byAccountId: string | null;
    decidedAt: string | null;
  } | null;
  /** 最近一次输入请求（`ask_user`、插件 `input_required`、MCP elicitation）。 */
  question: {
    questionId: string;
    askedAt: string;
    outcome: "answered" | "expired" | "cancelled" | null;
    byAccountId: string | null;
  } | null;
  /** A `tool.preExecute` policy hook denied the call (it never started). */
  hookDenied?: TrajectoryHookDenial;
}

export interface TrajectoryStep {
  step: number;
  /**
   * A `model.request` policy hook denied the step's request (attempt number included). The denied
   * attempt has no `model_call` (it was never sent), so the denial sits on the step, next to
   * `modelCalls`.
   */
  modelHookDenied?: TrajectoryHookDenial & { attempt?: number };
  modelCalls: TrajectoryModelCall[];
  toolCalls: TrajectoryToolCall[];
  /** 该步模型回复里的文本块（不含 thinking）按顺序拼接；还没有回复时为空串。 */
  text: string;
  stopReason: string | null;
}

export interface TrajectoryRun {
  runId: string;
  agentVersion: number;
  triggerAccountId: string;
  startedAt: string;
  endedAt: string | null;
  /** `detail`：结束原因（finished / aborted 的 `reason`）或失败码（`error.code`）。 */
  end: { kind: "finished" | "failed" | "aborted"; detail: string } | null;
  steps: TrajectoryStep[];
  totals: {
    usage: ModelUsage;
    /** 各次成功调用的成本之和；任一成功调用没有价格时为 null（部分求和会误导）。 */
    cost: number | null;
    modelCalls: number;
    toolCalls: number;
    /** `endedAt − startedAt`（含等待审批 / 输入的时间）；运行未结束为 null。 */
    durationMs: number | null;
  };
}

type Ev<T extends ConversationEvent["type"]> = Extract<ConversationEvent, { type: T }>;

const iso = (d: Date): string => d.toISOString();

const denialOf = (e: Ev<"hook_denied">): TrajectoryHookDenial => ({
  plugin: e.payload.plugin,
  reason: e.payload.reason,
  cause: e.payload.cause,
  ...(e.payload.detail !== undefined && { detail: e.payload.detail }),
});
const ms = (from: Date, to: Date): number => to.getTime() - from.getTime();

const zeroUsage = (): ModelUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

const usageOf = (p: EventPayload<"usage">): ModelUsage => ({
  inputTokens: p.inputTokens,
  outputTokens: p.outputTokens,
  cacheReadTokens: p.cacheReadTokens,
  cacheWriteTokens: p.cacheWriteTokens,
});

/** 一次运行的事件，按 seq 升序。 */
interface RunEvents {
  started: Ev<"run_started">;
  events: ConversationEvent[];
}

/**
 * 由会话事件推出各次运行的轨迹，按 `run_started` 的 seq 排序。没有 `run_started` 的运行（排队时就被中止 /
 * 判为孤儿，从未开始）不出现；没有 `runId` 的事件（用户消息等）不属于任何运行。
 */
export function buildTrajectory(
  events: readonly ConversationEvent[],
  prices: PriceTable,
): TrajectoryRun[] {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const byRun = new Map<string, ConversationEvent[]>();
  for (const e of sorted) {
    if (e.runId === null) continue;
    let list = byRun.get(e.runId);
    if (!list) {
      list = [];
      byRun.set(e.runId, list);
    }
    list.push(e);
  }
  const runs: RunEvents[] = [];
  for (const list of byRun.values()) {
    const started = list.find((e): e is Ev<"run_started"> => e.type === "run_started");
    if (started) runs.push({ started, events: list });
  }
  runs.sort((a, b) => a.started.seq - b.started.seq);
  return runs.map((r) => buildRun(r, prices));
}

function buildRun({ started, events }: RunEvents, prices: PriceTable): TrajectoryRun {
  const runId = started.runId ?? "";
  const endEvent = events.find(
    (e): e is Ev<"run_finished" | "run_failed" | "run_aborted"> =>
      e.type === "run_finished" || e.type === "run_failed" || e.type === "run_aborted",
  );
  const end: TrajectoryRun["end"] =
    endEvent === undefined
      ? null
      : endEvent.type === "run_finished"
        ? { kind: "finished", detail: endEvent.payload.reason }
        : endEvent.type === "run_failed"
          ? { kind: "failed", detail: endEvent.payload.error.code }
          : // 评测回放被停下时给出具体原因（capped / too_many_errors / claim_lost / cancelled / shutdown）
            { kind: "aborted", detail: endEvent.payload.detail ?? endEvent.payload.reason };

  const modelCalls = new Map<number, Ev<"model_call">[]>();
  const assistants = new Map<number, Ev<"assistant_message">[]>();
  const usages = new Map<number, Ev<"usage">[]>();
  const toolStarts = new Map<string, Ev<"tool_call_started">>(); // callId → 最后一次
  const toolResults = new Map<string, Ev<"tool_result">>();
  const approvals = new Map<string, Ev<"approval_requested">>(); // callId → 最近一次
  const decisions = new Map<string, Ev<"approval_decided">>(); // approvalId → 决定
  const questions = new Map<string, Ev<"question_asked">>(); // callId → 最近一次
  const answers = new Map<string, Ev<"question_answered">>(); // questionId → 结果
  const toolDenials = new Map<string, Ev<"hook_denied">>(); // callId → denial
  const modelDenials = new Map<number, Ev<"hook_denied">>(); // step → denial
  /** 步骤里出现过的调用 id（按首次出现），用于给不在 assistant_message 里的调用兜底。 */
  const stepCalls = new Map<number, string[]>();
  const steps = new Set<number>();
  const noteCall = (step: number, callId: string) => {
    steps.add(step);
    const list = stepCalls.get(step) ?? [];
    if (!list.includes(callId)) list.push(callId);
    stepCalls.set(step, list);
  };

  for (const e of events) {
    switch (e.type) {
      case "model_call": {
        steps.add(e.payload.step);
        const list = modelCalls.get(e.payload.step) ?? [];
        list.push(e);
        modelCalls.set(e.payload.step, list);
        break;
      }
      case "assistant_message":
        steps.add(e.payload.step);
        assistants.set(e.payload.step, [...(assistants.get(e.payload.step) ?? []), e]);
        break;
      case "usage":
        steps.add(e.payload.step);
        usages.set(e.payload.step, [...(usages.get(e.payload.step) ?? []), e]);
        break;
      case "tool_call_started":
        noteCall(e.payload.step, e.payload.callId);
        toolStarts.set(e.payload.callId, e);
        break;
      case "tool_result":
        noteCall(e.payload.step, e.payload.callId);
        if (!toolResults.has(e.payload.callId)) toolResults.set(e.payload.callId, e);
        break;
      case "approval_requested":
        noteCall(e.payload.step, e.payload.callId);
        approvals.set(e.payload.callId, e);
        break;
      case "approval_decided":
        decisions.set(e.payload.approvalId, e);
        break;
      case "question_asked":
        noteCall(e.payload.step, e.payload.callId);
        questions.set(e.payload.callId, e);
        break;
      case "question_answered":
        answers.set(e.payload.questionId, e);
        break;
      case "hook_denied":
        if (e.payload.callId !== undefined) {
          noteCall(e.payload.step, e.payload.callId);
          toolDenials.set(e.payload.callId, e);
        } else {
          steps.add(e.payload.step);
          modelDenials.set(e.payload.step, e);
        }
        break;
      default:
        break;
    }
  }

  const totals: TrajectoryRun["totals"] = {
    usage: zeroUsage(),
    cost: 0,
    modelCalls: 0,
    toolCalls: 0,
    durationMs: endEvent === undefined ? null : ms(started.createdAt, endEvent.createdAt),
  };

  const out: TrajectoryStep[] = [...steps]
    .sort((a, b) => a - b)
    .map((step) => {
      const calls = modelCalls.get(step) ?? [];
      // 回复与用量按该步最后一次 model_call 之后的第一条配对（步骤被重新发起时，较早的属于之前的尝试）
      const after = calls.at(-1)?.seq ?? Number.NEGATIVE_INFINITY;
      const msg = assistants.get(step)?.find((x) => x.seq > after);
      const u = usages.get(step)?.find((x) => x.seq > after);
      const modelOut = calls.map((c, i): TrajectoryModelCall => {
        const last = i === calls.length - 1;
        const ok = last && u !== undefined;
        const callUsage = ok ? usageOf(u.payload) : null;
        const cost =
          callUsage === null
            ? null
            : costOf(callUsage, prices.get(priceKey(c.payload.provider, c.payload.model)));
        return {
          seq: c.seq,
          step,
          attempt: c.payload.attempt,
          provider: c.payload.provider,
          model: c.payload.model,
          fallback: c.payload.fallback,
          startedAt: iso(c.createdAt),
          latencyMs: ok ? ms(c.createdAt, u.createdAt) : null,
          outcome: ok ? "ok" : last && msg === undefined && end === null ? "pending" : "failed",
          usage: callUsage,
          cost,
          request: c.payload.request,
        };
      });

      // 工具调用：以模型回复里的 tool_call 块为准（带 input），其后补上日志里出现但不在块里的调用
      const blocks = (msg?.payload.content ?? []).flatMap((b) =>
        b.type === "tool_call" ? [b] : [],
      );
      const ids = blocks.map((b) => b.id);
      for (const id of stepCalls.get(step) ?? []) if (!ids.includes(id)) ids.push(id);
      const toolOut = ids.map((callId): TrajectoryToolCall => {
        const block = blocks.find((b) => b.id === callId);
        const startedEv = toolStarts.get(callId);
        const res = toolResults.get(callId);
        const ap = approvals.get(callId);
        const dec = ap === undefined ? undefined : decisions.get(ap.payload.approvalId);
        const q = questions.get(callId);
        const ans = q === undefined ? undefined : answers.get(q.payload.questionId);
        const denied = toolDenials.get(callId);
        return {
          ...(denied !== undefined && { hookDenied: denialOf(denied) }),
          callId,
          step,
          toolKey:
            startedEv?.payload.toolKey ??
            res?.payload.toolKey ??
            ap?.payload.toolKey ??
            block?.name ??
            "",
          input: block?.input ?? null,
          startedAt: startedEv === undefined ? null : iso(startedEv.createdAt),
          durationMs:
            startedEv !== undefined && res !== undefined
              ? ms(startedEv.createdAt, res.createdAt)
              : null,
          result:
            res === undefined
              ? null
              : {
                  content: res.payload.content,
                  isError: res.payload.isError,
                  ...(res.payload.outputId !== undefined && { outputId: res.payload.outputId }),
                },
          approval:
            ap === undefined
              ? null
              : {
                  approvalId: ap.payload.approvalId,
                  requestedAt: iso(ap.createdAt),
                  decision: dec?.payload.decision ?? null,
                  ...(dec?.payload.scope !== undefined && { scope: dec.payload.scope }),
                  byAccountId: dec?.payload.byAccountId ?? null,
                  decidedAt: dec === undefined ? null : iso(dec.createdAt),
                },
          question:
            q === undefined
              ? null
              : {
                  questionId: q.payload.questionId,
                  askedAt: iso(q.createdAt),
                  outcome: ans?.payload.outcome ?? null,
                  byAccountId: ans?.payload.byAccountId ?? null,
                },
        };
      });

      for (const c of modelOut) {
        totals.modelCalls++;
        if (c.usage === null) continue;
        totals.usage.inputTokens += c.usage.inputTokens;
        totals.usage.outputTokens += c.usage.outputTokens;
        totals.usage.cacheReadTokens += c.usage.cacheReadTokens;
        totals.usage.cacheWriteTokens += c.usage.cacheWriteTokens;
        totals.cost = totals.cost === null || c.cost === null ? null : totals.cost + c.cost;
      }
      totals.toolCalls += toolOut.length;

      const modelDenied = modelDenials.get(step);
      return {
        step,
        ...(modelDenied !== undefined && {
          modelHookDenied: {
            ...denialOf(modelDenied),
            ...(modelDenied.payload.attempt !== undefined && {
              attempt: modelDenied.payload.attempt,
            }),
          },
        }),
        modelCalls: modelOut,
        toolCalls: toolOut,
        text: (msg?.payload.content ?? [])
          .flatMap((b) => (b.type === "text" ? [b.text] : []))
          .join(""),
        stopReason: msg?.payload.stopReason ?? null,
      };
    });

  return {
    runId,
    agentVersion: started.payload.agentVersion,
    triggerAccountId: started.payload.triggerAccountId,
    startedAt: iso(started.createdAt),
    endedAt: endEvent === undefined ? null : iso(endEvent.createdAt),
    end,
    steps: out,
    totals,
  };
}
