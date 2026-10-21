import type { Span, StatusMark } from "@capybara-hq/design";
import { apiFetch } from "./api";

/**
 * 内核轨迹 API 的类型（`packages/kernel/src/evals/trajectory*.ts`；只声明界面用到的字段）。Web 层不 import 内核代码。
 * - 列表：`GET /orgs/:orgId/trajectories`（组织管理员看全部，agent 负责人看自己负责的；不写审计）；
 * - 详情：`GET /orgs/:orgId/trajectories/:conversationId?limit&before|runId`（按运行分页；每次查看写审计）。
 */

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface TrajectoryModelCall {
  seq: number;
  step: number;
  attempt: number;
  provider: string;
  model: string;
  fallback: boolean;
  startedAt: string;
  latencyMs: number | null;
  outcome: "ok" | "failed" | "pending";
  usage: ModelUsage | null;
  /** 估算成本（币种见详情的 `currency`）；没有用量或没有价格时为 null。 */
  cost: number | null;
  request: {
    params?: Record<string, string | number | boolean>;
    tools?: { key: string; specHash: string }[];
    [key: string]: unknown;
  };
}

export interface TrajectoryToolCall {
  callId: string;
  step: number;
  toolKey: string;
  input: unknown;
  startedAt: string | null;
  durationMs: number | null;
  result: { content: string; isError: boolean; outputId?: string } | null;
  approval: {
    approvalId: string;
    requestedAt: string;
    decision: "approved" | "denied" | "expired" | "cancelled" | null;
    scope?: "once" | "session" | "always";
    byAccountId: string | null;
    decidedAt: string | null;
  } | null;
  question: {
    questionId: string;
    askedAt: string;
    outcome: "answered" | "expired" | "cancelled" | null;
    byAccountId: string | null;
  } | null;
}

export interface TrajectoryStep {
  step: number;
  modelCalls: TrajectoryModelCall[];
  toolCalls: TrajectoryToolCall[];
  text: string;
  stopReason: string | null;
}

export interface TrajectoryRun {
  runId: string;
  agentVersion: number;
  triggerAccountId: string;
  startedAt: string;
  endedAt: string | null;
  end: { kind: "finished" | "failed" | "aborted"; detail: string } | null;
  steps: TrajectoryStep[];
  totals: {
    usage: ModelUsage;
    cost: number | null;
    modelCalls: number;
    toolCalls: number;
    durationMs: number | null;
  };
}

export interface TrajectoryDetail {
  conversation: {
    id: string;
    agentId: string;
    accountId: string;
    title: string | null;
    kind: "chat" | "eval";
  };
  /** 本页的运行，按时间正序。 */
  runs: TrajectoryRun[];
  currency: string;
  /** 更早一页的游标（作为 `before` 传回）；没有更早的运行为 null。 */
  next?: string | null;
}

/** 运行状态（`runs.status`）。 */
export const RUN_STATUSES = [
  "queued",
  "running",
  "waiting",
  "completed",
  "failed",
  "aborted",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

type MarkStatus = Parameters<typeof StatusMark>[0]["status"];

/** 运行状态在 `StatusMark` 上的编码（spec §2.4：中止按已取消显示）。 */
export const runStatusMark = (s: RunStatus): MarkStatus =>
  s === "completed" ? "success" : s === "aborted" ? "cancelled" : s;

export interface TrajectoryListItem {
  conversationId: string;
  agentId: string;
  agentName: string;
  accountId: string;
  title: string | null;
  updatedAt: string;
  lastRun: { runId: string; status: RunStatus; startedAt: string | null } | null;
}

/** 评测集（`/orgs/:orgId/eval-sets`，组织管理员）。 */
export interface EvalSetSummary {
  id: string;
  agentId: string;
  name: string;
  caseCount: number;
}

const org = (orgId: string) => `/api/v1/orgs/${encodeURIComponent(orgId)}`;

const query = (params: Record<string, string | number | undefined>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v));
  const s = q.toString();
  return s === "" ? "" : `?${s}`;
};

export const listTrajectories = (
  orgId: string,
  q: { agentId?: string; status?: RunStatus; before?: string; limit: number },
) =>
  apiFetch<{ items: TrajectoryListItem[]; next: string | null }>(
    `${org(orgId)}/trajectories${query({ limit: q.limit, agentId: q.agentId, status: q.status, before: q.before })}`,
  );

/** 按运行分页读轨迹：最新的 `limit` 次运行，或 `before` 之前的 `limit` 次。 */
export const getTrajectory = (
  orgId: string,
  conversationId: string,
  q: { limit: number; before?: string },
) =>
  apiFetch<TrajectoryDetail>(
    `${org(orgId)}/trajectories/${encodeURIComponent(conversationId)}${query({ limit: q.limit, before: q.before })}`,
  );

export const listEvalSets = (orgId: string) =>
  apiFetch<{ sets: EvalSetSummary[] }>(`${org(orgId)}/eval-sets`);

export const addEvalCase = (
  orgId: string,
  setId: string,
  body: { conversationId: string; runId: string },
) =>
  apiFetch<{ case: { id: string } }>(`${org(orgId)}/eval-sets/${encodeURIComponent(setId)}/cases`, {
    method: "POST",
    body: JSON.stringify(body),
  });

/** 瀑布图里一个 span 对应的轨迹对象（详情区按它渲染）。 */
export type SpanSource =
  | { kind: "run"; run: TrajectoryRun }
  | { kind: "step"; run: TrajectoryRun; step: TrajectoryStep }
  | { kind: "model"; run: TrajectoryRun; call: TrajectoryModelCall }
  | { kind: "tool"; run: TrajectoryRun; call: TrajectoryToolCall }
  | { kind: "approval"; run: TrajectoryRun; call: TrajectoryToolCall }
  | { kind: "question"; run: TrajectoryRun; call: TrajectoryToolCall };

/** 本次请求的输入总量（未缓存 + 缓存读 + 缓存写，见 SDK `ModelUsage`）。 */
export const inputTotal = (u: ModelUsage) => u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;

const grouped = new Intl.NumberFormat("en-US");

/** 瀑布 span 的名称（界面文案，调用方按语言给出）。模型与工具 span 用供应商 / 模型名与工具 key，不翻译。 */
export interface SpanLabels {
  run(version: number): string;
  step(n: number): string;
  approval: string;
  question: string;
}

/**
 * 由轨迹推出瀑布图的 span 与各 span 的来源。层级：run → step → model / tool → wait（审批、提问），按深度优先排列；
 * `startMs` 相对最早一次运行的开始。未结束的为 pending、时长 null；失败 / 中止的运行、出错或没有结果就结束的工具、
 * 运行已结束却仍为 pending 的模型调用为 error。
 */
export function indexTrajectory(
  runs: readonly TrajectoryRun[],
  labels: SpanLabels,
): {
  spans: Span[];
  sources: Map<string, SpanSource>;
} {
  const spans: Span[] = [];
  const sources = new Map<string, SpanSource>();
  if (runs.length === 0) return { spans, sources };
  const base = Math.min(...runs.map((r) => Date.parse(r.startedAt)));
  const off = (iso: string) => Date.parse(iso) - base;
  const diff = (from: string, to: string) => Date.parse(to) - Date.parse(from);
  const add = (span: Span, source: SpanSource) => {
    spans.push(span);
    sources.set(span.id, source);
    return span;
  };

  for (const run of runs) {
    const ended = run.end !== null;
    const runId = `run:${run.runId}`;
    add(
      {
        id: runId,
        kind: "run",
        label: labels.run(run.agentVersion),
        startMs: off(run.startedAt),
        durationMs: run.totals.durationMs,
        status: run.end === null ? "pending" : run.end.kind === "finished" ? "ok" : "error",
      },
      { kind: "run", run },
    );
    for (const step of run.steps) {
      const stepId = `step:${run.runId}:${step.step}`;
      const stepSpan = add(
        {
          id: stepId,
          parentId: runId,
          kind: "step",
          label: labels.step(step.step),
          startMs: 0,
          durationMs: null,
          status: "ok",
        },
        { kind: "step", run, step },
      );
      const children: Span[] = [];
      for (const call of step.modelCalls) {
        const meta =
          call.usage === null
            ? undefined
            : `↑${grouped.format(inputTotal(call.usage))} ↓${grouped.format(call.usage.outputTokens)}`;
        children.push(
          add(
            {
              id: `model:${run.runId}:${call.seq}`,
              parentId: stepId,
              kind: "model",
              label: `${call.provider}/${call.model}`,
              startMs: off(call.startedAt),
              durationMs: call.latencyMs,
              // 运行已结束仍没有结果的调用（没写 usage 就停了）算失败
              status:
                call.outcome === "ok"
                  ? "ok"
                  : call.outcome === "failed" || ended
                    ? "error"
                    : "pending",
              ...(meta !== undefined && { meta }),
            },
            { kind: "model", run, call },
          ),
        );
      }
      for (const call of step.toolCalls) {
        const toolId = `tool:${run.runId}:${call.callId}`;
        const start =
          call.startedAt ??
          call.approval?.requestedAt ??
          call.question?.askedAt ??
          step.modelCalls.at(-1)?.startedAt ??
          run.startedAt;
        children.push(
          add(
            {
              id: toolId,
              parentId: stepId,
              kind: "tool",
              label: call.toolKey,
              startMs: off(start),
              durationMs: call.durationMs,
              status:
                call.result === null
                  ? ended
                    ? "error"
                    : "pending"
                  : call.result.isError
                    ? "error"
                    : "ok",
            },
            { kind: "tool", run, call },
          ),
        );
        const ap = call.approval;
        if (ap !== null) {
          children.push(
            add(
              {
                id: `approval:${run.runId}:${ap.approvalId}`,
                parentId: toolId,
                kind: "wait",
                label: labels.approval,
                startMs: off(ap.requestedAt),
                durationMs: ap.decidedAt === null ? null : diff(ap.requestedAt, ap.decidedAt),
                status:
                  ap.decision === null
                    ? ended
                      ? "error"
                      : "pending"
                    : ap.decision === "approved"
                      ? "ok"
                      : "error",
              },
              { kind: "approval", run, call },
            ),
          );
        }
        const q = call.question;
        if (q !== null) {
          children.push(
            add(
              {
                id: `question:${run.runId}:${q.questionId}`,
                parentId: toolId,
                kind: "wait",
                label: labels.question,
                startMs: off(q.askedAt),
                durationMs: null,
                status:
                  q.outcome === null
                    ? ended
                      ? "error"
                      : "pending"
                    : q.outcome === "answered"
                      ? "ok"
                      : "error",
              },
              { kind: "question", run, call },
            ),
          );
        }
      }
      // 步骤：从最早的子 span 开始，到最晚结束的子 span；有子 span 未结束则时长未知、为 pending
      const start =
        children.length === 0 ? off(run.startedAt) : Math.min(...children.map((c) => c.startMs));
      const pending = children.some((c) => c.status === "pending");
      const end = Math.max(start, ...children.map((c) => c.startMs + (c.durationMs ?? 0)));
      const last = step.modelCalls.at(-1);
      stepSpan.startMs = start;
      stepSpan.durationMs = pending ? null : end - start;
      stepSpan.status = pending
        ? "pending"
        : last === undefined || last.outcome !== "ok"
          ? "error"
          : "ok";
    }
  }
  return { spans, sources };
}

/** 瀑布图的 span（见 {@link indexTrajectory}）。 */
export function trajectorySpans(runs: TrajectoryRun[], labels: SpanLabels): Span[] {
  return indexTrajectory(runs, labels).spans;
}
