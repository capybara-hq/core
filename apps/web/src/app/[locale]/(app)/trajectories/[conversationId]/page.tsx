"use client";

import {
  Button,
  Card,
  Dialog,
  Field,
  formatSpanDuration,
  IoBlock,
  KeyValue,
  type MetricProps,
  Select,
  Skeleton,
  SpanWaterfall,
  Stack,
  Text,
  TracePage,
  useToast,
} from "@capybara-hq/design";
import { useParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import { formatTime } from "../../../../../components/ApprovalCard";
import { FormError } from "../../../../../components/form-error";
import { OrgGate } from "../../../../../components/OrgGate";
import { useSession } from "../../../../../components/shell/session";
import { ApiClientError } from "../../../../../lib/api";
import { canUpdateOrg } from "../../../../../lib/org-settings";
import {
  addEvalCase,
  getTrajectory,
  indexTrajectory,
  inputTotal,
  listEvalSets,
  type ModelUsage,
  type SpanSource,
  type TrajectoryDetail,
  type TrajectoryModelCall,
  type TrajectoryRun,
  type TrajectoryToolCall,
} from "../../../../../lib/trajectories";
import { useErrorMessage } from "../../../../../lib/use-error-message";
import { useLoad } from "../../../../../lib/use-load";

/** 每次读多少次运行（按运行分页，不一次读全对话）。 */
const RUN_PAGE = 10;

const grouped = new Intl.NumberFormat("en-US");
const costFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 });

/** 估算成本：`0.0064 USD`；没有价格为 `—`（C2）。 */
const formatCost = (cost: number | null, currency: string) =>
  cost === null ? "—" : `${costFormat.format(cost)} ${currency}`;

const usageTotal = (u: ModelUsage) => inputTotal(u) + u.outputTokens;

/**
 * `/[locale]/trajectories/[conversationId]`：轨迹查看器（TracePage，D6）。上方 Span 瀑布，下方选中 span 的详情；
 * 页头是已加载运行的合计（总 token、估算成本、调用数、耗时）。按运行分页：先读最新的 {@link RUN_PAGE} 次，
 * 「加载更早的运行」再往前翻。每次读取都会由内核记入审计（页面上有提示）。「加入评测集」只对组织管理员显示。
 */
export default function TrajectoryPage() {
  const { conversationId } = useParams<{ conversationId: string }>();
  return (
    <OrgGate>
      {(orgId) => (
        <TrajectoryInOrg key={`${orgId}\n${conversationId}`} orgId={orgId} id={conversationId} />
      )}
    </OrgGate>
  );
}

function TrajectoryInOrg({ orgId, id }: { orgId: string; id: string }) {
  const t = useTranslations("trajectories");
  const errorMessage = useErrorMessage();
  const { state } = useLoad(() => getTrajectory(orgId, id, { limit: RUN_PAGE }), [orgId, id]);
  if (state.kind === "ready") return <Trajectory orgId={orgId} first={state.data} />;
  return (
    <TracePage
      header={{ parent: { label: t("title"), href: "/trajectories" }, title: t("title") }}
      waterfall={state.kind === "loading" ? <Skeleton rows={6} /> : null}
      detail={
        state.kind === "error" ? (
          <FormError message={errorMessage(new ApiClientError(0, state.code, ""))} />
        ) : null
      }
    />
  );
}

function Trajectory({ orgId, first }: { orgId: string; first: TrajectoryDetail }) {
  const t = useTranslations("trajectories");
  const { me } = useSession();
  const errorMessage = useErrorMessage();
  const admin = canUpdateOrg(me);
  const conv = first.conversation;
  /** 「加载更早的运行」读到的运行（按时间正序，拼在第一页前面）。 */
  const [earlier, setEarlier] = useState<{ runs: TrajectoryRun[]; next: string | null } | null>(
    null,
  );
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [earlierError, setEarlierError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const runs = [...(earlier?.runs ?? []), ...first.runs];
  const next = earlier !== null ? earlier.next : (first.next ?? null);
  const { spans, sources } = indexTrajectory(runs, {
    run: (version) => t("detail.spans.run", { version }),
    step: (n) => t("detail.spans.step", { n }),
    approval: t("detail.spans.approval"),
    question: t("detail.spans.question"),
  });
  const lastRun = runs.at(-1);
  // 缺省选中最近一次运行
  const selectedId =
    selected !== null && sources.has(selected)
      ? selected
      : lastRun === undefined
        ? null
        : `run:${lastRun.runId}`;
  const source = selectedId === null ? undefined : sources.get(selectedId);

  const loadEarlier = async () => {
    if (next === null) return;
    setLoadingEarlier(true);
    setEarlierError(null);
    try {
      const page = await getTrajectory(orgId, conv.id, { limit: RUN_PAGE, before: next });
      setEarlier((e) => ({ runs: [...page.runs, ...(e?.runs ?? [])], next: page.next ?? null }));
    } catch (e) {
      setEarlierError(errorMessage(e));
    } finally {
      setLoadingEarlier(false);
    }
  };

  const tokens = runs.reduce((n, r) => n + usageTotal(r.totals.usage), 0);
  const cost = runs.reduce<number | null>(
    (n, r) => (n === null || r.totals.cost === null ? null : n + r.totals.cost),
    0,
  );
  const calls = runs.reduce((n, r) => n + r.totals.modelCalls + r.totals.toolCalls, 0);
  const durations = runs.flatMap((r) =>
    r.totals.durationMs === null ? [] : [r.totals.durationMs],
  );
  const metrics: MetricProps[] = [
    { label: t("detail.metrics.tokens"), value: grouped.format(tokens) },
    {
      label: t("detail.metrics.cost"),
      value: formatCost(runs.length === 0 ? null : cost, first.currency),
    },
    { label: t("detail.metrics.calls"), value: grouped.format(calls) },
    {
      label: t("detail.metrics.duration"),
      value: formatSpanDuration(
        durations.length === 0 ? null : durations.reduce((a, b) => a + b, 0),
      ),
    },
  ];
  // 加入评测集：选中 span 所在的运行（没有选中时为最近一次）
  const targetRun = source?.run ?? lastRun;

  return (
    <>
      <TracePage
        header={{
          parent: { label: t("title"), href: "/trajectories" },
          title: conv.title ?? t("untitled"),
          metrics,
          ...(admin && {
            actions: [
              { label: t("addToSet.action"), variant: "default", onSelect: () => setAdding(true) },
            ],
          }),
        }}
        waterfall={
          <Stack gap={0}>
            {next !== null ? (
              <Stack direction="row" gap={8} align="center">
                <Button
                  variant="ghost"
                  size={24}
                  onClick={() => void loadEarlier()}
                  loading={loadingEarlier}
                >
                  {t("detail.loadEarlier")}
                </Button>
                {earlierError !== null ? <Text tone="fail">{earlierError}</Text> : null}
              </Stack>
            ) : null}
            <SpanWaterfall
              label={t("detail.waterfall")}
              spans={spans}
              selectedId={selectedId}
              onSelect={setSelected}
              labels={{ empty: t("detail.empty") }}
            />
          </Stack>
        }
        detail={
          <section aria-label={t("detail.region")}>
            <Stack gap={12}>
              <Text variant="small" tone="muted">
                {t("detail.audited")}
              </Text>
              {source === undefined ? (
                <Text tone="muted">{t("detail.selectHint")}</Text>
              ) : (
                <SpanDetail source={source} currency={first.currency} />
              )}
            </Stack>
          </section>
        }
      />
      {admin && adding && targetRun !== undefined ? (
        <AddToSetDialog
          orgId={orgId}
          agentId={conv.agentId}
          conversationId={conv.id}
          run={targetRun}
          onClose={() => setAdding(false)}
        />
      ) : null}
    </>
  );
}

/** 选中 span 的详情。 */
function SpanDetail({ source, currency }: { source: SpanSource; currency: string }) {
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

const pretty = (v: unknown) => {
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

/** 把一次运行加入该 agent 的评测集（组织管理员；`POST /eval-sets/:setId/cases`）。 */
function AddToSetDialog({
  orgId,
  agentId,
  conversationId,
  run,
  onClose,
}: {
  orgId: string;
  agentId: string;
  conversationId: string;
  run: TrajectoryRun;
  onClose(): void;
}) {
  const t = useTranslations("trajectories.addToSet");
  const tc = useTranslations("common");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const { state } = useLoad(
    () => listEvalSets(orgId).then((r) => r.sets.filter((s) => s.agentId === agentId)),
    [orgId, agentId],
  );
  const sets = state.kind === "ready" ? state.data : [];
  const [setId, setSetId] = useState<string | null>(null);
  const chosen = sets.find((s) => s.id === setId) ?? sets[0];
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const finished = run.end !== null;

  const submit = async () => {
    if (chosen === undefined) return;
    setPending(true);
    setError(null);
    try {
      await addEvalCase(orgId, chosen.id, { conversationId, runId: run.runId });
      toast.success(t("added", { name: chosen.name }));
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t("title")}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {tc("cancel")}
          </Button>
          <Button
            variant="primary"
            onClick={() => void submit()}
            loading={pending}
            disabled={chosen === undefined || !finished || pending}
          >
            {t("submit")}
          </Button>
        </>
      }
    >
      <Stack gap={12}>
        <KeyValue rows={[{ k: t("run"), v: run.runId }]} />
        {state.kind === "loading" ? (
          <Skeleton rows={2} />
        ) : state.kind === "error" ? (
          <FormError message={errorMessage(new ApiClientError(0, state.code, ""))} />
        ) : sets.length === 0 ? (
          <Text tone="muted">{t("noSets")}</Text>
        ) : (
          <Field label={t("set")}>
            <Select
              value={chosen?.id ?? ""}
              onChange={(e) => setSetId(e.target.value)}
              options={sets.map((s) => ({ value: s.id, label: s.name }))}
            />
          </Field>
        )}
        {!finished ? <Text tone="warn">{t("runNotFinished")}</Text> : null}
        {error !== null ? <FormError message={error} /> : null}
      </Stack>
    </Dialog>
  );
}
