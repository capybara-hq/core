"use client";

import {
  Card,
  formatSpanDuration,
  IoBlock,
  KeyValue,
  type MetricProps,
  Stack,
  Text,
} from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import {
  inputTotal,
  type ModelUsage,
  type SpanLabels,
  type SpanSource,
  type TrajectoryHookDenial,
  type TrajectoryModelCall,
  type TrajectoryRun,
  type TrajectoryToolCall,
} from "../lib/trajectories";
import { formatTime } from "./ApprovalCard";

/**
 * 轨迹查看器的共用部件（运行记录页 `/trajectories/[conversationId]` 与评测用例的快照轨迹
 * `/evals/[setId]/cases/[caseId]` 共用）：瀑布 span 名称、页头指标、选中 span 的详情。
 */

export const grouped = new Intl.NumberFormat("en-US");

/**
 * 估算成本：按界面语言的货币格式（`Intl.NumberFormat` 的 currency 样式，最多 6 位小数，如 `$0.0064`）；
 * 没有价格为 `—`（C2）。币种不是合法的 ISO 4217 代码时退回 `0.0064 XYZ`。
 */
export function formatCost(cost: number | null, currency: string, locale: string): string {
  if (cost === null) return "—";
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      maximumFractionDigits: 6,
    }).format(cost);
  } catch {
    return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 6 }).format(cost)} ${currency}`;
  }
}

/** 按当前界面语言格式化成本（见 {@link formatCost}）。 */
export function useFormatCost(): (cost: number | null, currency: string) => string {
  const locale = useLocale();
  return (cost, currency) => formatCost(cost, currency, locale);
}

export const usageTotal = (u: ModelUsage) => inputTotal(u) + u.outputTokens;

/** 瀑布 span 名称（按界面语言）。 */
export function useSpanLabels(): SpanLabels {
  const t = useTranslations("trajectories.detail.spans");
  return {
    run: (version) => t("run", { version }),
    step: (n) => t("step", { n }),
    approval: t("approval"),
    question: t("question"),
  };
}

/** 页头指标：已加载运行的总 token、成本（估算；有任一运行没有价格为 `—`）、调用数（模型 + 工具）、耗时。 */
export function useTrajectoryMetrics(runs: TrajectoryRun[], currency: string): MetricProps[] {
  const t = useTranslations("trajectories.detail.metrics");
  const formatCost = useFormatCost();
  const tokens = runs.reduce((n, r) => n + usageTotal(r.totals.usage), 0);
  const cost = runs.reduce<number | null>(
    (n, r) => (n === null || r.totals.cost === null ? null : n + r.totals.cost),
    0,
  );
  const calls = runs.reduce((n, r) => n + r.totals.modelCalls + r.totals.toolCalls, 0);
  const durations = runs.flatMap((r) =>
    r.totals.durationMs === null ? [] : [r.totals.durationMs],
  );
  return [
    { label: t("tokens"), value: grouped.format(tokens) },
    { label: t("cost"), value: formatCost(runs.length === 0 ? null : cost, currency) },
    { label: t("calls"), value: grouped.format(calls) },
    {
      label: t("duration"),
      value: formatSpanDuration(
        durations.length === 0 ? null : durations.reduce((a, b) => a + b, 0),
      ),
    },
  ];
}

/** 选中 span 的详情。 */
export function SpanDetail({ source, currency }: { source: SpanSource; currency: string }) {
  switch (source.kind) {
    case "run":
      return <RunDetail run={source.run} currency={currency} />;
    case "step":
      return <StepDetail step={source.step} />;
    case "model":
      return <ModelDetail call={source.call} currency={currency} />;
    default:
      // 工具调用与它的审批 / 提问等待：都显示该工具调用（含审批链与提问）
      return <ToolDetail call={source.call} />;
  }
}

/**
 * 运行结束的原因（`end.detail`）：结束 / 中止原因走 `trajectories.endDetail.*`，失败码走 `errors.*`，都没有时显示原始码。
 */
function useEndDetail(): (detail: string) => string {
  const td = useTranslations("trajectories.endDetail");
  const te = useTranslations("errors");
  return (detail) => (td.has(detail) ? td(detail) : te.has(detail) ? te(detail) : detail);
}

function RunDetail({ run, currency }: { run: TrajectoryRun; currency: string }) {
  const t = useTranslations("trajectories.detail.run");
  const locale = useLocale();
  const formatCost = useFormatCost();
  const endDetail = useEndDetail();
  const rows: { k: ReactNode; v: ReactNode }[] = [
    { k: t("version"), v: `v${run.agentVersion}` },
    { k: t("trigger"), v: run.triggerAccountId },
    { k: t("started"), v: formatTime(run.startedAt, locale) },
    { k: t("ended"), v: run.endedAt === null ? t("running") : formatTime(run.endedAt, locale) },
    {
      k: t("result"),
      v:
        run.end === null
          ? t("running")
          : `${t(`end.${run.end.kind}`)} · ${endDetail(run.end.detail)}`,
    },
    { k: t("tokens"), v: grouped.format(usageTotal(run.totals.usage)) },
    { k: t("cost"), v: formatCost(run.totals.cost, currency) },
    {
      k: t("calls"),
      v: t("callsValue", { model: run.totals.modelCalls, tool: run.totals.toolCalls }),
    },
    { k: t("duration"), v: formatSpanDuration(run.totals.durationMs) },
  ];
  return (
    <Card title={t("title", { id: run.runId })}>
      <KeyValue keyWidth="16ch" rows={rows} />
    </Card>
  );
}

/** Rows describing a policy hook denial (shared by step and tool details). */
function useHookRows() {
  const t = useTranslations("trajectories.detail.hook");
  return (d: TrajectoryHookDenial & { attempt?: number }): { k: ReactNode; v: ReactNode }[] => [
    { k: t("title"), v: <Text tone="fail">{d.plugin}</Text> },
    { k: t("cause"), v: t(`causes.${d.cause}`) },
    { k: t("reason"), v: d.reason },
    ...(d.attempt !== undefined ? [{ k: t("attempt"), v: String(d.attempt) }] : []),
    ...(d.detail !== undefined ? [{ k: t("detail"), v: d.detail }] : []),
  ];
}

function StepDetail({ step }: { step: TrajectoryRun["steps"][number] }) {
  const t = useTranslations("trajectories.detail.step");
  const hookRows = useHookRows();
  const rows: { k: ReactNode; v: ReactNode }[] = [
    { k: t("stopReason"), v: step.stopReason ?? "—" },
    ...(step.modelHookDenied !== undefined ? hookRows(step.modelHookDenied) : []),
  ];
  return (
    <Card title={t("title", { n: step.step })}>
      <Stack gap={12}>
        <KeyValue keyWidth="16ch" rows={rows} />
        <Stack gap={4}>
          <Text variant="small" tone="muted">
            {t("text")}
          </Text>
          {step.text === "" ? (
            <Text tone="muted">{t("noText")}</Text>
          ) : (
            <Text pre>{step.text}</Text>
          )}
        </Stack>
      </Stack>
    </Card>
  );
}

function ModelDetail({ call, currency }: { call: TrajectoryModelCall; currency: string }) {
  const t = useTranslations("trajectories.detail.model");
  const locale = useLocale();
  const formatCost = useFormatCost();
  const params = Object.entries(call.request.params ?? {});
  const tools = (call.request.tools ?? []).map((x) => x.key);
  const u = call.usage;
  const rows: { k: ReactNode; v: ReactNode }[] = [
    { k: t("provider"), v: call.provider },
    { k: t("model"), v: call.model },
    { k: t("attempt"), v: t("attemptValue", { n: call.attempt + 1 }) },
    { k: t("fallback"), v: call.fallback ? t("fallbackYes") : t("fallbackNo") },
    { k: t("outcome"), v: t(`outcomes.${call.outcome}`) },
    {
      k: t("tokens"),
      v:
        u === null
          ? "—"
          : t("tokensValue", {
              input: grouped.format(u.inputTokens),
              output: grouped.format(u.outputTokens),
              cacheRead: grouped.format(u.cacheReadTokens),
              cacheWrite: grouped.format(u.cacheWriteTokens),
            }),
    },
    { k: t("latency"), v: formatSpanDuration(call.latencyMs) },
    { k: t("cost"), v: formatCost(call.cost, currency) },
    {
      k: t("params"),
      v: params.length === 0 ? "—" : params.map(([k, v]) => `${k}=${v}`).join(", "),
    },
    { k: t("tools"), v: tools.length === 0 ? "—" : tools.join(", ") },
    { k: t("started"), v: formatTime(call.startedAt, locale) },
  ];
  return (
    <Card title={t("title", { name: `${call.provider}/${call.model}` })}>
      <KeyValue keyWidth="16ch" rows={rows} />
    </Card>
  );
}

/** 任意值的展示文本：字符串原样，其余缩进 JSON。 */
export const pretty = (v: unknown) => {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2) ?? "";
  } catch {
    return String(v);
  }
};

function ToolDetail({ call }: { call: TrajectoryToolCall }) {
  const t = useTranslations("trajectories.detail.tool");
  const locale = useLocale();
  const hookRows = useHookRows();
  const rows: { k: ReactNode; v: ReactNode }[] = [
    { k: t("duration"), v: formatSpanDuration(call.durationMs) },
    {
      k: t("started"),
      v: call.startedAt === null ? t("notStarted") : formatTime(call.startedAt, locale),
    },
  ];
  if (call.result?.isError) rows.push({ k: t("result"), v: <Text tone="fail">{t("error")}</Text> });
  if (call.hookDenied !== undefined) rows.push(...hookRows(call.hookDenied));
  const ap = call.approval;
  if (ap !== null) {
    rows.push(
      { k: t("approvalRequested"), v: formatTime(ap.requestedAt, locale) },
      { k: t("decision"), v: t(`decisions.${ap.decision ?? "pending"}`) },
      ...(ap.scope !== undefined ? [{ k: t("scope"), v: t(`scopes.${ap.scope}`) }] : []),
      ...(ap.byAccountId !== null ? [{ k: t("by"), v: ap.byAccountId }] : []),
      ...(ap.decidedAt !== null
        ? [{ k: t("decidedAt"), v: formatTime(ap.decidedAt, locale) }]
        : []),
    );
  }
  const q = call.question;
  if (q !== null) {
    rows.push(
      { k: t("asked"), v: formatTime(q.askedAt, locale) },
      { k: t("questionOutcome"), v: t(`questionOutcomes.${q.outcome ?? "pending"}`) },
      ...(q.byAccountId !== null ? [{ k: t("by"), v: q.byAccountId }] : []),
    );
  }
  return (
    <Card title={t("title", { name: call.toolKey })}>
      <Stack gap={12}>
        <IoBlock label="IN" text={pretty(call.input)} />
        <IoBlock label="OUT" text={call.result === null ? t("noResult") : call.result.content} />
        <KeyValue keyWidth="16ch" rows={rows} />
      </Stack>
    </Card>
  );
}
