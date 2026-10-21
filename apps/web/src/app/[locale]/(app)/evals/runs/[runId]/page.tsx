"use client";

import {
  Button,
  Card,
  CodeBlock,
  type Column,
  DataTable,
  DetailPage,
  Field,
  Input,
  KeyValue,
  type MetricProps,
  Skeleton,
  Stack,
  StatusMark,
  Text,
  useToast,
} from "@capybara-hq/design";
import { useParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { formatTime } from "../../../../../../components/ApprovalCard";
import { FormError } from "../../../../../../components/form-error";
import { OrgGate } from "../../../../../../components/OrgGate";
import { formatCost, grouped } from "../../../../../../components/TrajectoryParts";
import { Link } from "../../../../../../i18n/navigation";
import { ApiClientError } from "../../../../../../lib/api";
import { lineDiff } from "../../../../../../lib/diff";
import {
  cancelEvalRun,
  type EvalLabel,
  type EvalResult,
  type EvalRun,
  evalResultMark,
  evalRunMark,
  formatRate,
  getEvalRun,
  getEvalSet,
  labelEvalResult,
  listAllEvalResults,
  runActive,
  sideOf,
  type ToolCallDiffEntry,
} from "../../../../../../lib/evals";
import { useErrorMessage } from "../../../../../../lib/use-error-message";
import { useLoad } from "../../../../../../lib/use-load";

/** 执行中的运行每隔多久重读一次（浏览器内轮询）。 */
const POLL_MS = 5000;

const TABS = ["results", "summary"] as const;
type Tab = (typeof TABS)[number];

/**
 * `/[locale]/evals/runs/[runId]`：评测运行（DetailPage）。页头是状态、进度、token 用量 / 上限与汇总比率；
 * 排队或执行中每 5 秒重读运行与结果，可以取消。「结果」标签页列出每条结果，选中后 Inspector 显示文本差异
 * （lineDiff + CodeBlock）、工具调用差异、评委理由与人工标注；整轮回放的结果可以跳到评测对话的轨迹。
 * 「汇总」标签页是汇总数字与候选设置。
 */
export default function EvalRunPage() {
  const { runId } = useParams<{ runId: string }>();
  return (
    <OrgGate>
      {(orgId) => <EvalRunInOrg key={`${orgId}\n${runId}`} orgId={orgId} runId={runId} />}
    </OrgGate>
  );
}

type Loaded = { run: EvalRun; results: EvalResult[]; titles: Map<string, string> };

function EvalRunInOrg({ orgId, runId }: { orgId: string; runId: string }) {
  const t = useTranslations("evals");
  const errorMessage = useErrorMessage();
  const { state, reload, set } = useLoad(async (): Promise<Loaded> => {
    const { run } = await getEvalRun(orgId, runId);
    const [results, setDetail] = await Promise.all([
      listAllEvalResults(orgId, runId),
      // 用例标题只用于显示：读不到时显示用例 id
      getEvalSet(orgId, run.setId).then(
        (r) => r.set,
        () => null,
      ),
    ]);
    return {
      run,
      results,
      titles: new Map((setDetail?.cases ?? []).map((c) => [c.id, c.title])),
    };
  }, [orgId, runId]);
  const active = state.kind === "ready" && runActive(state.data.run.status);
  // 执行中：每 5 秒重读（reload 保留上一次的数据，不闪回加载中）
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(reload, POLL_MS);
    return () => clearInterval(timer);
  }, [active, reload]);

  if (state.kind === "ready") {
    return <EvalRunView orgId={orgId} data={state.data} onChange={set} onReload={reload} />;
  }
  return (
    <DetailPage
      header={{ parent: { label: t("title"), href: "/evals" }, title: t("title") }}
      tabs={{
        label: t("run.tabsLabel"),
        items: TABS.map((x) => ({ id: x, label: t(`run.tabs.${x}`) })),
        value: "results",
      }}
    >
      {state.kind === "loading" ? (
        <Skeleton rows={6} />
      ) : (
        <FormError message={errorMessage(new ApiClientError(0, state.code, ""))} />
      )}
    </DetailPage>
  );
}

function EvalRunView({
  orgId,
  data,
  onChange,
  onReload,
}: {
  orgId: string;
  data: Loaded;
  onChange(data: Loaded): void;
  onReload(): void;
}) {
  const t = useTranslations("evals");
  const te = useTranslations("errors");
  const locale = useLocale();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const { run, results, titles } = data;
  const [tab, setTab] = useState<Tab>("results");
  const [selected, setSelected] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const active = runActive(run.status);
  const title = (r: EvalResult) => titles.get(r.caseId) ?? r.caseId;
  const current = results.find((r) => r.id === selected);
  const s = run.summary;

  const cancel = async () => {
    // 页头按钮没有加载态：请求进行中再点不重复发
    if (cancelling) return;
    setCancelling(true);
    try {
      const r = await cancelEvalRun(orgId, run.id);
      onChange({ ...data, run: r.run });
      toast.success(t("run.cancelled"));
      onReload();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setCancelling(false);
    }
  };

  /** 标注写入后：换掉表里这条结果，再重读运行（汇总随之更新）。 */
  const labeled = useCallback(
    (r: EvalResult) => {
      onChange({ ...data, results: data.results.map((x) => (x.id === r.id ? r : x)) });
      onReload();
    },
    [data, onChange, onReload],
  );

  const metrics: MetricProps[] = [
    {
      label: t("run.metrics.progress"),
      value: t("run.progressValue", { done: run.casesDone, total: run.casesTotal }),
    },
    {
      label: t("run.metrics.tokens"),
      value: t("run.tokensValue", {
        used: grouped.format(run.tokensUsed),
        cap: grouped.format(run.tokenCap),
      }),
    },
    { label: t("run.metrics.toolMatch"), value: formatRate(s?.toolCallsMatchRate) },
    { label: t("run.metrics.judgePass"), value: formatRate(s?.judgePassRate) },
    { label: t("run.metrics.humanPass"), value: formatRate(s?.humanPassRate) },
  ];

  const reason = (code: string) => (te.has(code) ? te(code) : code);
  const notice: ReactNode =
    run.status === "capped" ? (
      <Text tone="warn">
        {t("run.capped", {
          used: grouped.format(run.tokensUsed),
          cap: grouped.format(run.tokenCap),
        })}
      </Text>
    ) : run.status === "failed" ? (
      <Text tone="fail">{t("run.failed", { reason: reason(run.error?.code ?? "unknown") })}</Text>
    ) : run.status === "cancelled" ? (
      <Text tone="muted">{t("run.cancelledNotice")}</Text>
    ) : active ? (
      <Text tone="muted">{t("run.polling")}</Text>
    ) : null;

  const judgeCell = (r: EvalResult): ReactNode => {
    if (r.judge !== null && "verdict" in r.judge) {
      return (
        <Text tone={r.judge.verdict === "pass" ? "ok" : "fail"}>
          {t(`run.verdict.${r.judge.verdict}`)}
        </Text>
      );
    }
    if (r.judgeStatus === "done") return "—";
    return <Text tone="muted">{t(`run.judgeStatus.${r.judgeStatus}`)}</Text>;
  };

  const columns: Column<EvalResult>[] = [
    { key: "case", header: t("run.columns.case"), cell: (r) => <Text truncate>{title(r)}</Text> },
    {
      key: "step",
      header: t("run.columns.step"),
      width: 90,
      tone: "muted",
      cell: (r) => (r.step === null ? t("run.wholeRun") : t("run.stepValue", { n: r.step })),
    },
    {
      key: "status",
      header: t("run.columns.status"),
      width: 110,
      cell: (r) => (
        <StatusMark status={evalResultMark(r.status)} label={t(`run.resultStatus.${r.status}`)} />
      ),
    },
    {
      key: "tools",
      header: t("run.columns.tools"),
      width: 100,
      cell: (r) =>
        r.diff === null ? (
          "—"
        ) : (
          <Text tone={r.diff.toolCallsMatch ? "ok" : "fail"}>
            {r.diff.toolCallsMatch ? t("run.match") : t("run.mismatch")}
          </Text>
        ),
    },
    {
      key: "similarity",
      header: t("run.columns.similarity"),
      width: 110,
      align: "right",
      cell: (r) => formatRate(r.diff?.textSimilarity),
    },
    { key: "judge", header: t("run.columns.judge"), width: 100, cell: judgeCell },
    {
      key: "label",
      header: t("run.columns.label"),
      width: 100,
      cell: (r) =>
        r.label === null ? (
          "—"
        ) : (
          <Text tone={r.label === "pass" ? "ok" : "fail"}>{t(`run.verdict.${r.label}`)}</Text>
        ),
    },
  ];

  return (
    <DetailPage
      header={{
        parent: { label: t("title"), href: `/evals/${encodeURIComponent(run.setId)}` },
        title: t("run.title", { time: formatTime(run.createdAt, locale) }),
        status: (
          <StatusMark status={evalRunMark(run.status)} label={t(`runStatus.${run.status}`)} />
        ),
        metrics,
        ...(active && {
          actions: [{ label: t("run.cancel"), variant: "default", onSelect: () => void cancel() }],
        }),
      }}
      tabs={{
        label: t("run.tabsLabel"),
        items: TABS.map((x) => ({
          id: x,
          label: t(`run.tabs.${x}`),
          ...(x === "results" && { count: results.length }),
        })),
        value: tab,
        onChange: (x) => setTab(x as Tab),
      }}
      inspectorTitle={t("run.inspector.title")}
      inspector={
        <section aria-label={t("run.inspector.title")}>
          {current === undefined ? (
            <Text tone="muted">{t("run.inspector.selectHint")}</Text>
          ) : (
            <ResultInspector
              key={current.id}
              orgId={orgId}
              mode={run.mode}
              result={current}
              title={title(current)}
              onLabeled={labeled}
            />
          )}
        </section>
      }
    >
      <Stack gap={12}>
        {notice}
        {tab === "results" ? (
          <DataTable<EvalResult>
            label={t("run.resultsLabel")}
            columns={columns}
            rows={results}
            rowKey={(r) => r.id}
            rowLabel={(r) => title(r)}
            state="ready"
            empty={{ title: t("run.resultsEmpty") }}
            {...(current && { activeKey: current.id })}
            onOpen={(r) => setSelected(r.id)}
          />
        ) : (
          <SummaryTab run={run} />
        )}
      </Stack>
    </DetailPage>
  );
}

function SummaryTab({ run }: { run: EvalRun }) {
  const t = useTranslations("evals");
  const s = run.summary;
  const c = run.candidate;
  const e = run.estimate;
  const keep = t("run.candidate.keep");
  const params = Object.entries(c.modelParams ?? {});
  return (
    <Stack gap={16}>
      <Card title={t("run.summary.title")}>
        {s === null ? (
          <Text tone="muted">{t("run.summary.pending")}</Text>
        ) : (
          <KeyValue
            keyWidth="18ch"
            rows={[
              { k: t("run.summary.done"), v: grouped.format(s.done) },
              { k: t("run.summary.errors"), v: grouped.format(s.errors) },
              { k: t("run.summary.skipped"), v: grouped.format(s.skipped) },
              { k: t("run.summary.toolMatch"), v: formatRate(s.toolCallsMatchRate) },
              { k: t("run.summary.similarity"), v: formatRate(s.meanTextSimilarity) },
              { k: t("run.summary.judgePass"), v: formatRate(s.judgePassRate) },
              { k: t("run.summary.judgeErrors"), v: grouped.format(s.judgeErrors) },
              { k: t("run.summary.humanPass"), v: formatRate(s.humanPassRate) },
              { k: t("run.summary.labeled"), v: grouped.format(s.labeled) },
              { k: t("run.summary.drifted"), v: grouped.format(s.drifted) },
            ]}
          />
        )}
      </Card>
      <Card title={t("run.candidate.title")}>
        <KeyValue
          keyWidth="18ch"
          rows={[
            { k: t("run.candidate.mode"), v: t(`mode.${run.mode}`) },
            {
              k: t("run.candidate.version"),
              v: c.agentVersion === undefined ? keep : `v${c.agentVersion}`,
            },
            {
              k: t("run.candidate.model"),
              v: c.model === undefined ? keep : `${c.model.provider}/${c.model.model}`,
            },
            {
              k: t("run.candidate.params"),
              v: params.length === 0 ? "—" : params.map(([k, v]) => `${k}=${v}`).join(", "),
            },
            {
              k: t("run.candidate.instructions"),
              v: c.instructions === undefined ? keep : t("run.candidate.overridden"),
            },
            {
              k: t("run.candidate.judge"),
              v: run.judge ? t("wizard.summary.on") : t("wizard.summary.off"),
            },
            {
              k: t("run.candidate.estimate"),
              v: t("run.candidate.estimateValue", {
                model: grouped.format(e.modelRequests),
                judge: grouped.format(e.judgeRequests),
                tokens: grouped.format(e.estimatedTokens),
                cost: formatCost(e.estimatedCost, e.currency),
              }),
            },
          ]}
        />
        {c.instructions !== undefined ? <CodeBlock text={c.instructions} /> : null}
      </Card>
    </Stack>
  );
}

const compact = (v: unknown) => {
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return String(v);
  }
};

/** 工具调用差异的一行：`= name {args}`、`~ name {基线} → {候选}` 等。 */
function toolLine(e: ToolCallDiffEntry, kind: string): string {
  const b = e.baseline;
  const c = e.candidate;
  switch (e.kind) {
    case "same":
      return `= ${b?.name} ${compact(b?.input)}  (${kind})`;
    case "args_changed":
      return `~ ${b?.name} ${compact(b?.input)} → ${compact(c?.input)}  (${kind})`;
    case "name_changed":
      return `~ ${b?.name} ${compact(b?.input)} → ${c?.name} ${compact(c?.input)}  (${kind})`;
    case "added":
      return `+ ${c?.name} ${compact(c?.input)}  (${kind})`;
    default:
      return `- ${b?.name} ${compact(b?.input)}  (${kind})`;
  }
}

function ResultInspector({
  orgId,
  mode,
  result: r,
  title,
  onLabeled,
}: {
  orgId: string;
  mode: EvalRun["mode"];
  result: EvalResult;
  title: string;
  onLabeled(r: EvalResult): void;
}) {
  const t = useTranslations("evals.run");
  const te = useTranslations("errors");
  const errorMessage = useErrorMessage();
  const [note, setNote] = useState(r.labelNote ?? "");
  const [pending, setPending] = useState<EvalLabel | "clear" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reason = (code: string) => (te.has(code) ? te(code) : code);

  const base = sideOf(mode, r.baseline);
  const cand = sideOf(mode, r.candidate);
  const textDiff = lineDiff(base.text, cand.text);
  const tools = r.diff?.toolCalls ?? [];

  const label = async (value: EvalLabel | null) => {
    setPending(value ?? "clear");
    setError(null);
    try {
      const res = await labelEvalResult(orgId, r.id, {
        label: value,
        ...(value !== null && note.trim() !== "" && { note }),
      });
      if (value === null) setNote("");
      onLabeled(res.result);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPending(null);
    }
  };

  const j = r.judge;
  const judgeBody: ReactNode =
    j !== null && "verdict" in j ? (
      <Stack gap={8}>
        <KeyValue
          keyWidth="8ch"
          rows={[
            {
              k: t("inspector.verdict"),
              v: (
                <Text tone={j.verdict === "pass" ? "ok" : "fail"}>{t(`verdict.${j.verdict}`)}</Text>
              ),
            },
            { k: t("inspector.score"), v: String(j.score) },
          ]}
        />
        <Text variant="small" tone="muted">
          {t("inspector.reason")}
        </Text>
        <Text pre>{j.reason}</Text>
      </Stack>
    ) : j !== null ? (
      <Text tone="fail">
        {t("inspector.judgeError", {
          reason: j.error === "unparseable" ? t("inspector.unparseable") : reason(j.error),
        })}
      </Text>
    ) : (
      <Text tone="muted">{t(`judgeStatus.${r.judgeStatus}`)}</Text>
    );

  return (
    <Stack gap={16}>
      <KeyValue
        keyWidth="8ch"
        rows={[
          { k: t("inspector.case"), v: title },
          {
            k: t("columns.step"),
            v: r.step === null ? t("wholeRun") : t("stepValue", { n: r.step }),
          },
          {
            k: t("inspector.status"),
            v: (
              <StatusMark status={evalResultMark(r.status)} label={t(`resultStatus.${r.status}`)} />
            ),
          },
          ...(r.drift.length > 0 ? [{ k: t("inspector.drift"), v: r.drift.join(", ") }] : []),
          ...(r.error !== null
            ? [{ k: t("inspector.error"), v: <Text tone="fail">{reason(r.error.code)}</Text> }]
            : []),
        ]}
      />
      {r.evalConversationId !== null ? (
        <Link href={`/trajectories/${encodeURIComponent(r.evalConversationId)}`}>
          {t("inspector.evalTrajectory")}
        </Link>
      ) : null}
      {r.status === "done" ? (
        <>
          <Stack gap={4}>
            <Text variant="small" tone="muted">
              {t("inspector.textDiff")}
            </Text>
            {textDiff === "" ? (
              <Text tone="muted">{t("inspector.noTextDiff")}</Text>
            ) : (
              <CodeBlock language="diff" text={textDiff} />
            )}
          </Stack>
          <Stack gap={4}>
            <Text variant="small" tone="muted">
              {t("inspector.toolDiff")}
            </Text>
            {tools.length === 0 ? (
              <Text tone="muted">{t("inspector.noToolCalls")}</Text>
            ) : (
              <CodeBlock
                language="tools"
                text={tools.map((e) => toolLine(e, t(`inspector.toolKinds.${e.kind}`))).join("\n")}
              />
            )}
          </Stack>
          <Stack gap={4}>
            <Text variant="small" tone="muted">
              {t("inspector.judge")}
            </Text>
            {judgeBody}
          </Stack>
        </>
      ) : null}
      <Stack gap={8}>
        <Text variant="small" tone="muted">
          {t("inspector.label")}
          {r.label !== null ? ` · ${t(`verdict.${r.label}`)}` : ""}
        </Text>
        <Field label={t("inspector.note")} optional>
          <Input value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <Stack direction="row" gap={8} wrap>
          <Button
            variant={r.label === "pass" ? "primary" : "default"}
            loading={pending === "pass"}
            disabled={pending !== null}
            onClick={() => void label("pass")}
          >
            {t("inspector.pass")}
          </Button>
          <Button
            variant={r.label === "fail" ? "danger" : "default"}
            loading={pending === "fail"}
            disabled={pending !== null}
            onClick={() => void label("fail")}
          >
            {t("inspector.fail")}
          </Button>
          {r.label !== null ? (
            <Button
              variant="ghost"
              loading={pending === "clear"}
              disabled={pending !== null}
              onClick={() => void label(null)}
            >
              {t("inspector.clear")}
            </Button>
          ) : null}
        </Stack>
        {error !== null ? <FormError message={error} /> : null}
      </Stack>
    </Stack>
  );
}
