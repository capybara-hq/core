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
const costFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 });

/** 估算成本：`0.0064 USD`；没有价格为 `—`（C2）。 */
export const formatCost = (cost: number | null, currency: string) =>
  cost === null ? "—" : `${costFormat.format(cost)} ${currency}`;

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

function RunDetail({ run, currency }: { run: TrajectoryRun; currency: string }) {
  const t = useTranslations("trajectories.detail.run");
  const locale = useLocale();
  const rows: { k: ReactNode; v: ReactNode }[] = [
    { k: t("version"), v: `v${run.agentVersion}` },
    { k: t("trigger"), v: run.triggerAccountId },
    { k: t("started"), v: formatTime(run.startedAt, locale) },
    { k: t("ended"), v: run.endedAt === null ? t("running") : formatTime(run.endedAt, locale) },
    {
      k: t("result"),
      v: run.end === null ? t("running") : `${t(`end.${run.end.kind}`)} · ${run.end.detail}`,
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

function StepDetail({ step }: { step: TrajectoryRun["steps"][number] }) {
  const t = useTranslations("trajectories.detail.step");
  return (
    <Card title={t("title", { n: step.step })}>
      <Stack gap={12}>
        <KeyValue keyWidth="16ch" rows={[{ k: t("stopReason"), v: step.stopReason ?? "—" }]} />
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
  const rows: { k: ReactNode; v: ReactNode }[] = [
    { k: t("duration"), v: formatSpanDuration(call.durationMs) },
    {
      k: t("started"),
      v: call.startedAt === null ? t("notStarted") : formatTime(call.startedAt, locale),
    },
  ];
  if (call.result?.isError) rows.push({ k: t("result"), v: <Text tone="fail">{t("error")}</Text> });
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
