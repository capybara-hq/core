import type { StatusMark } from "@capybara-hq/design";
import type { ParamValue } from "./agents";
import { apiFetch } from "./api";
import type { ModelRef } from "./conversations";
import type { TrajectoryRun } from "./trajectories";

/**
 * 内核评测 API 的类型（`packages/kernel/src/evals/{sets,runs}.service.ts`、`diff.ts`、`judge.ts`；只声明界面用到的
 * 字段）。Web 层不 import 内核代码。全部接口要 `evals.manage`（组织管理员）。
 * - 评测集与用例：`/orgs/:orgId/eval-sets[/:setId[/cases[/sample|/:caseId]]]`；
 * - 运行：`POST /eval-sets/:setId/runs[/estimate]`、`GET /eval-sets/:setId/runs`、`/eval-runs/:runId[/results|/cancel]`；
 * - 人工标注：`PUT /eval-results/:resultId/label`；
 * - 评委用途是否已映射：`GET /orgs/:orgId/model-purposes`（`org.models.manage`，同为管理员）。
 */

export interface EvalSet {
  id: string;
  agentId: string;
  name: string;
  description: string;
  rubric: string | null;
  caseCount: number;
  createdAt: string;
}

export interface EvalCase {
  id: string;
  sourceConversationId: string;
  sourceRunId: string;
  agentVersion: number;
  title: string;
  replayableSteps: number;
  createdAt: string;
}

export interface EvalSetDetail extends EvalSet {
  cases: EvalCase[];
}

/** 用例详情：快照还原的轨迹（快照里的全部运行）。 */
export interface EvalCaseDetail {
  case: EvalCase;
  trajectory: TrajectoryRun[];
  currency: string;
}

export interface EvalCandidate {
  agentVersion?: number;
  model?: ModelRef;
  modelParams?: Record<string, ParamValue>;
  instructions?: string;
}

export type EvalMode = "step" | "run";

/** 运行前的估算（D5）。 */
export interface EvalEstimate {
  cases: number;
  modelRequests: number;
  judgeRequests: number;
  estimatedTokens: number;
  /** 有用例的候选模型没有价格 → null。 */
  estimatedCost: number | null;
  currency: string;
}

export interface EvalSummary {
  done: number;
  errors: number;
  skipped: number;
  toolCallsMatchRate: number | null;
  meanTextSimilarity: number | null;
  judgePassRate: number | null;
  judgeErrors: number;
  humanPassRate: number | null;
  labeled: number;
  drifted: number;
}

export const EVAL_RUN_STATUSES = [
  "queued",
  "running",
  "completed",
  "cancelled",
  "capped",
  "failed",
] as const;
export type EvalRunStatus = (typeof EVAL_RUN_STATUSES)[number];

export interface EvalRun {
  id: string;
  setId: string;
  mode: EvalMode;
  candidate: EvalCandidate;
  judge: boolean;
  status: EvalRunStatus;
  tokenCap: number;
  tokensUsed: number;
  casesTotal: number;
  casesDone: number;
  estimate: EvalEstimate;
  /** 运行结束后才有。 */
  summary: EvalSummary | null;
  /** failed 的原因（如 `eval.too_many_errors`）。 */
  error: { code: string; message: string } | null;
  createdAt: string;
  finishedAt: string | null;
}

export type EvalResultStatus = "pending" | "running" | "done" | "error" | "skipped";
export type JudgeStatus = "none" | "pending" | "done" | "error" | "skipped";
export type EvalLabel = "pass" | "fail";

export interface ToolCallDiffEntry {
  index: number;
  kind: "same" | "args_changed" | "name_changed" | "added" | "removed";
  baseline?: { name: string; input: unknown };
  candidate?: { name: string; input: unknown };
}

export interface StructuralDiff {
  toolCalls: ToolCallDiffEntry[];
  toolCallsMatch: boolean;
  textSimilarity: number;
  stopReasonMatch: boolean;
}

/** 评委结论，或没有结论时的原因（`unparseable` 或错误码）。 */
export type JudgeOutcome =
  | { verdict: EvalLabel; score: number; reason: string; provider: string; model: string }
  | { error: string; provider?: string; model?: string };

export interface EvalResult {
  id: string;
  caseId: string;
  step: number | null;
  modelCallSeq: number | null;
  status: EvalResultStatus;
  /** 单步：`{content, stopReason}`；整轮：`{toolCalls, finalContent, stopReason, …}`。 */
  baseline: unknown;
  candidate: unknown;
  diff: StructuralDiff | null;
  judge: JudgeOutcome | null;
  judgeStatus: JudgeStatus;
  drift: string[];
  error: { code: string; message: string } | null;
  evalConversationId: string | null;
  label: EvalLabel | null;
  labelNote: string | null;
  labeledBy: string | null;
  labeledAt: string | null;
}

/** 用途映射（只用到评委用途 `eval` 是否有生效的映射）。 */
export interface PurposeView {
  purpose: string;
  effective: { model: ModelRef; params: Record<string, ParamValue> } | null;
}

/** 评委用途名（C9）。 */
export const EVAL_PURPOSE = "eval";

/** 运行仍在执行（页面轮询、可以取消）。 */
export const runActive = (s: EvalRunStatus) => s === "queued" || s === "running";

type MarkStatus = Parameters<typeof StatusMark>[0]["status"];

/** 运行状态在 `StatusMark` 上的编码：达到上限按已取消的符号显示（文字另给）。 */
export const evalRunMark = (s: EvalRunStatus): MarkStatus =>
  s === "completed" ? "success" : s === "capped" ? "cancelled" : s;

/** 结果状态在 `StatusMark` 上的编码。 */
export const evalResultMark = (s: EvalResultStatus): MarkStatus =>
  s === "done"
    ? "success"
    : s === "error"
      ? "failed"
      : s === "skipped"
        ? "cancelled"
        : s === "pending"
          ? "queued"
          : "running";

type Block = { type: string; text?: string; name?: string; input?: unknown };
type Side = { toolCalls: { name: string; input: unknown }[]; text: string };

/** 回复内容块里的工具调用与文本（与内核 `replyParts` 同一规则：忽略 thinking，文本以换行拼接）。 */
function partsOf(content: unknown): Side {
  const toolCalls: Side["toolCalls"] = [];
  const texts: string[] = [];
  for (const b of Array.isArray(content) ? (content as Block[]) : []) {
    if (b.type === "tool_call" && typeof b.name === "string") {
      toolCalls.push({ name: b.name, input: b.input });
    } else if (b.type === "text" && typeof b.text === "string") texts.push(b.text);
  }
  return { toolCalls, text: texts.join("\n") };
}

/**
 * 结果一边（基线或候选）的工具调用与回复文本：单步取该次回复的内容块，整轮取工具调用序列与最后一次回复。
 * 没有内容（未做完 / 出错）时为空。
 */
export function sideOf(mode: EvalMode, v: unknown): Side {
  if (v === null || typeof v !== "object") return { toolCalls: [], text: "" };
  if (mode === "step") return partsOf((v as { content?: unknown }).content);
  const r = v as { toolCalls?: Side["toolCalls"]; finalContent?: unknown };
  return {
    toolCalls: Array.isArray(r.toolCalls) ? r.toolCalls : [],
    text: partsOf(r.finalContent).text,
  };
}

/** 比率（0–1）显示为百分比；没有数据为 `—`。 */
export const formatRate = (r: number | null | undefined) =>
  r === null || r === undefined ? "—" : `${Math.round(r * 100)}%`;

const org = (orgId: string) => `/api/v1/orgs/${encodeURIComponent(orgId)}`;
const sets = (orgId: string) => `${org(orgId)}/eval-sets`;
const enc = encodeURIComponent;

export const listEvalSets = (orgId: string) => apiFetch<{ sets: EvalSet[] }>(sets(orgId));

export const createEvalSet = (
  orgId: string,
  body: { agentId: string; name: string; description?: string; rubric?: string },
) => apiFetch<{ set: EvalSet }>(sets(orgId), { method: "POST", body: JSON.stringify(body) });

export const getEvalSet = (orgId: string, setId: string) =>
  apiFetch<{ set: EvalSetDetail }>(`${sets(orgId)}/${enc(setId)}`);

export const deleteEvalSet = (orgId: string, setId: string) =>
  apiFetch<void>(`${sets(orgId)}/${enc(setId)}`, { method: "DELETE" });

export const addEvalCase = (
  orgId: string,
  setId: string,
  body: { conversationId: string; runId: string },
) =>
  apiFetch<{ case: EvalCase }>(`${sets(orgId)}/${enc(setId)}/cases`, {
    method: "POST",
    body: JSON.stringify(body),
  });

export interface SampleInput {
  count: number;
  status?: "completed" | "failed" | "any";
  minToolCalls?: number;
  from?: string;
  to?: string;
}

export const sampleEvalCases = (orgId: string, setId: string, body: SampleInput) =>
  apiFetch<{ added: number; skipped: number }>(`${sets(orgId)}/${enc(setId)}/cases/sample`, {
    method: "POST",
    body: JSON.stringify(body),
  });

export const getEvalCase = (orgId: string, setId: string, caseId: string) =>
  apiFetch<EvalCaseDetail>(`${sets(orgId)}/${enc(setId)}/cases/${enc(caseId)}`);

export const removeEvalCase = (orgId: string, setId: string, caseId: string) =>
  apiFetch<void>(`${sets(orgId)}/${enc(setId)}/cases/${enc(caseId)}`, { method: "DELETE" });

export interface RunInput {
  mode: EvalMode;
  candidate: EvalCandidate;
  judge: boolean;
}

export const estimateEvalRun = (orgId: string, setId: string, body: RunInput) =>
  apiFetch<{ estimate: EvalEstimate }>(`${sets(orgId)}/${enc(setId)}/runs/estimate`, {
    method: "POST",
    body: JSON.stringify(body),
  });

export const startEvalRun = (
  orgId: string,
  setId: string,
  body: RunInput & { tokenCap?: number },
) =>
  apiFetch<{ run: EvalRun }>(`${sets(orgId)}/${enc(setId)}/runs`, {
    method: "POST",
    body: JSON.stringify(body),
  });

export const listEvalRuns = (orgId: string, setId: string) =>
  apiFetch<{ runs: EvalRun[] }>(`${sets(orgId)}/${enc(setId)}/runs`);

export const getEvalRun = (orgId: string, runId: string) =>
  apiFetch<{ run: EvalRun }>(`${org(orgId)}/eval-runs/${enc(runId)}`);

export const cancelEvalRun = (orgId: string, runId: string) =>
  apiFetch<{ run: EvalRun }>(`${org(orgId)}/eval-runs/${enc(runId)}/cancel`, { method: "POST" });

/** 一页结果的上限（内核 1–200）。 */
export const RESULT_PAGE = 200;

/** 读一次运行的全部结果（按 id 游标逐页读）。 */
export async function listAllEvalResults(orgId: string, runId: string): Promise<EvalResult[]> {
  const out: EvalResult[] = [];
  let after: string | null = null;
  do {
    const q: string = `?limit=${RESULT_PAGE}${after === null ? "" : `&after=${enc(after)}`}`;
    const page: { results: EvalResult[]; next: string | null } = await apiFetch(
      `${org(orgId)}/eval-runs/${enc(runId)}/results${q}`,
    );
    out.push(...page.results);
    after = page.next;
  } while (after !== null);
  return out;
}

export const labelEvalResult = (
  orgId: string,
  resultId: string,
  body: { label: EvalLabel | null; note?: string },
) =>
  apiFetch<{ result: EvalResult }>(`${org(orgId)}/eval-results/${enc(resultId)}/label`, {
    method: "PUT",
    body: JSON.stringify(body),
  });

export const listModelPurposes = (orgId: string) =>
  apiFetch<{ purposes: PurposeView[] }>(`${org(orgId)}/model-purposes`);
