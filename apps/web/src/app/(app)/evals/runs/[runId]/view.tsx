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
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { formatTime } from "../../../../../components/ApprovalCard";
import { FormError } from "../../../../../components/form-error";
import { usePagePath } from "../../../../../components/shell/path";
import { grouped, useFormatCost } from "../../../../../components/TrajectoryParts";
import { Link } from "../../../../../i18n/navigation";
import { ApiClientError } from "../../../../../lib/api";
import { lineDiff } from "../../../../../lib/diff";
import {
  cancelEvalRun,
  type EvalLabel,
  type EvalResult,
  type EvalResultRow,
  type EvalRun,
  evalResultMark,
  evalRunMark,
  formatRate,
  getEvalResult,
  getEvalRun,
  labelEvalResult,
  listEvalResultRows,
  listEvalResultRowsPage,
  mergeResultRows,
  rowOf,
  runActive,
  sideOf,
  type ToolCallDiffEntry,
} from "../../../../../lib/evals";
import { useErrorMessage } from "../../../../../lib/use-error-message";
import { useLoad } from "../../../../../lib/use-load";
import { useServerState } from "../../../../../lib/use-server-state";

/** 执行中的运行每隔多久重读一次（浏览器内轮询）。 */
const POLL_MS = 5000;
/** 没有变化时轮询逐次加倍放慢，最慢这么久一次。 */
const MAX_POLL_MS = 30_000;

const TABS = ["results", "summary"] as const;
type Tab = (typeof TABS)[number];

/**
 * `/evals/runs/[runId]`: an eval run (DetailPage). The header is the status, progress, token use /
 * cap and the summary rates. The run, the first page of results and the set (for the case titles
 * and the path) come from the server; further pages load in the browser ("Load more"). While queued
 * or running the page polls the run and the results after first paint (the next read is scheduled
 * once the last one finished; 5 s, doubling up to 30 s while nothing changes), and it can be
 * cancelled. The table reads the light view (no content blocks); the polling reads only rows changed
 * since the last read (`updatedSince`) and merges them by id. The "Results" tab lists every result;
 * opening one loads its full row in the inspector: the text diff (lineDiff + CodeBlock), the tool
 * call diff, drift reasons, the judge's reason and the human label; a whole-run replay's result
 * links to the eval conversation's trajectory. The "Summary" tab is the summary and the candidate.
 */
export type EvalRunData = {
  run: EvalRun;
  /** The light rows loaded so far (id order). */
  rows: EvalResultRow[];
  /** The cursor of the next page of results (`null`: every page is loaded). */
  next: string | null;
  /** The next poll's `updatedSince` (null when the kernel gave none: every read is complete). */
  asOf: string | null;
  /** Case titles by case id (empty when the set could not be read: the case id shows). */
  titles: Record<string, string>;
  /** The set's name for the path line (null when it could not be read). */
  setName: string | null;
};

export default function EvalRunInOrg({
  orgId,
  runId,
  initial,
}: {
  orgId: string;
  runId: string;
  initial: EvalRunData;
}) {
  const [data, set] = useServerState(initial);
  /** The latest data (the polling and refreshes replace the run and results on top of it). */
  const latest = useRef(data);
  latest.current = data;
  const active = runActive(data.run.status);

  /** Reads the run and the changed result rows again (not the set); whether the progress changed. */
  const refresh = useCallback(async (): Promise<boolean> => {
    const since = latest.current.asOf ?? undefined;
    const [{ run }, page] = await Promise.all([
      getEvalRun(orgId, runId),
      listEvalResultRows(orgId, runId, since),
    ]);
    const prev = latest.current;
    // A complete read (every page): without `since` the read was one; when the run just ended,
    // read every light row once more (an incremental read can miss the last rows written at the
    // same instant as the previous asOf), then the polling stops
    const complete =
      since === undefined
        ? page
        : runActive(prev.run.status) && !runActive(run.status)
          ? await listEvalResultRows(orgId, runId)
          : null;
    set({
      ...prev,
      run,
      rows: complete !== null ? complete.rows : mergeResultRows(prev.rows, page.rows),
      next: complete !== null ? null : prev.next,
      asOf: (complete ?? page).asOf ?? prev.asOf,
    });
    return (
      prev.run.status !== run.status ||
      prev.run.casesDone !== run.casesDone ||
      prev.run.tokensUsed !== run.tokensUsed
    );
  }, [orgId, runId, set]);

  /** The next page of results after the loaded ones (merged by id: polled rows may be in it). */
  const [loadingMore, setLoadingMore] = useState(false);
  const loadMore = useCallback(async () => {
    const after = latest.current.next;
    if (after === null) return;
    setLoadingMore(true);
    try {
      const page = await listEvalResultRowsPage(orgId, runId, { after });
      const prev = latest.current;
      set({ ...prev, rows: mergeResultRows(prev.rows, page.rows), next: page.next });
    } catch {
      // Kept as it was: the button stays to try again.
    } finally {
      setLoadingMore(false);
    }
  }, [orgId, runId, set]);

  // While active, poll: the next read is scheduled after the last one finished (a slow read is
  // never interrupted or doubled), 5 s after a change, doubling up to 30 s while nothing changes;
  // stops when the run ends (active turns false) or on unmount.
  // ssr-exempt: live updates after first paint (the run is still in progress)
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delay = POLL_MS;
    const tick = async () => {
      let changed = false;
      try {
        changed = await refresh();
      } catch {
        // A failed read keeps the last data and tries again later.
      }
      if (stopped) return;
      delay = changed ? POLL_MS : Math.min(delay * 2, MAX_POLL_MS);
      timer = setTimeout(() => void tick(), delay);
    };
    timer = setTimeout(() => void tick(), delay);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [active, refresh]);

  return (
    <EvalRunView
      orgId={orgId}
      data={data}
      onChange={set}
      onRefresh={() => void refresh().catch(() => {})}
      loadingMore={loadingMore}
      onLoadMore={() => void loadMore()}
    />
  );
}

function EvalRunView({
  orgId,
  data,
  onChange,
  onRefresh,
  loadingMore,
  onLoadMore,
}: {
  orgId: string;
  data: EvalRunData;
  onChange(data: EvalRunData): void;
  onRefresh(): void;
  loadingMore: boolean;
  onLoadMore(): void;
}) {
  const scope = usePagePath("org");
  const t = useTranslations("evals");
  const te = useTranslations("errors");
  const locale = useLocale();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const { run, rows, titles } = data;
  const [tab, setTab] = useState<Tab>("results");
  const [selected, setSelected] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const active = runActive(run.status);
  const title = (r: { caseId: string }) => titles[r.caseId] ?? r.caseId;
  const current = rows.find((r) => r.id === selected);
  const s = run.summary;

  const cancel = async () => {
    // 页头按钮没有加载态：请求进行中再点不重复发
    if (cancelling) return;
    setCancelling(true);
    try {
      const r = await cancelEvalRun(orgId, run.id);
      onChange({ ...data, run: r.run });
      toast.success(t("run.cancelled"));
      onRefresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setCancelling(false);
    }
  };

  /** 标注写入后：就地更新表里这一行（沿用原 `updatedAt`，下一次轮询再带回新的），再重读运行（汇总随之更新）。 */
  const labeled = useCallback(
    (r: EvalResult) => {
      onChange({
        ...data,
        rows: data.rows.map((x) => (x.id === r.id ? rowOf(r, x.updatedAt) : x)),
      });
      onRefresh();
    },
    [data, onChange, onRefresh],
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

  const judgeCell = (r: EvalResultRow): ReactNode => {
    if (r.verdict !== null) {
      return (
        <Text tone={r.verdict === "pass" ? "ok" : "fail"}>{t(`run.verdict.${r.verdict}`)}</Text>
      );
    }
    if (r.judgeStatus === "done") return "—";
    return <Text tone="muted">{t(`run.judgeStatus.${r.judgeStatus}`)}</Text>;
  };

  const columns: Column<EvalResultRow>[] = [
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
        r.toolCallsMatch === null ? (
          "—"
        ) : (
          <Text tone={r.toolCallsMatch ? "ok" : "fail"}>
            {r.toolCallsMatch ? t("run.match") : t("run.mismatch")}
          </Text>
        ),
    },
    {
      key: "similarity",
      header: t("run.columns.similarity"),
      width: 110,
      align: "right",
      cell: (r) => formatRate(r.textSimilarity),
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
        path: [
          ...scope,
          { label: "evals", href: "/evals" },
          { label: data.setName ?? run.setId, href: `/evals/${encodeURIComponent(run.setId)}` },
          { label: formatTime(run.createdAt, locale) },
        ],
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
          ...(x === "results" && { count: rows.length }),
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
            <ResultPanel
              key={current.id}
              orgId={orgId}
              runId={run.id}
              mode={run.mode}
              row={current}
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
          <DataTable<EvalResultRow>
            label={t("run.resultsLabel")}
            columns={columns}
            rows={rows}
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
        {tab === "results" && data.next !== null ? (
          <Stack direction="row">
            <Button loading={loadingMore} onClick={onLoadMore}>
              {t("run.loadMore")}
            </Button>
          </Stack>
        ) : null}
      </Stack>
    </DetailPage>
  );
}

function SummaryTab({ run }: { run: EvalRun }) {
  const t = useTranslations("evals");
  const formatCost = useFormatCost();
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
            ...(e.judgeTokens !== undefined && e.judgeTokens > 0
              ? [
                  {
                    k: t("run.candidate.judgeShare"),
                    v: t("run.candidate.judgeShareValue", {
                      tokens: grouped.format(e.judgeTokens),
                      cost: formatCost(e.judgeCost ?? null, e.currency),
                    }),
                  },
                ]
              : []),
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

/**
 * 选中结果的查看器：按需读这一条的完整行（结果表只有轻量行）；轮询带回这一行的 `updatedAt` 变化时重读
 * （重读期间保留上一次的内容）。
 */
function ResultPanel({
  orgId,
  runId,
  mode,
  row,
  title,
  onLabeled,
}: {
  orgId: string;
  runId: string;
  mode: EvalRun["mode"];
  row: EvalResultRow;
  title: string;
  onLabeled(r: EvalResult): void;
}) {
  const errorMessage = useErrorMessage();
  // ssr-exempt: the full row loads when the person opens a result (none is open at first paint)
  const { state, reload, set } = useLoad(
    () => getEvalResult(orgId, runId, row.id).then((r) => r.result),
    [orgId, runId, row.id],
  );
  const seen = useRef(row.updatedAt);
  useEffect(() => {
    if (seen.current === row.updatedAt) return;
    seen.current = row.updatedAt;
    reload();
  }, [row.updatedAt, reload]);
  if (state.kind === "loading") return <Skeleton rows={4} />;
  if (state.kind === "error") {
    return <FormError message={errorMessage(new ApiClientError(0, state.code, ""))} />;
  }
  return (
    <ResultInspector
      orgId={orgId}
      mode={mode}
      result={state.data}
      title={title}
      onLabeled={(r) => {
        set(r);
        onLabeled(r);
      }}
    />
  );
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
  const td = useTranslations("evals.drift");
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
          ...(r.drift.length > 0
            ? [
                {
                  k: t("inspector.drift"),
                  // 漂移原因走 i18n，不认识的原因显示原始码
                  v: r.drift
                    .map((d) => (td.has(d) ? td(d) : d))
                    .join(t("inspector.driftSeparator")),
                },
              ]
            : []),
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
              <CodeBlock language={t("inspector.diffCaption")} text={textDiff} />
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
