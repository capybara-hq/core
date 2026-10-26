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
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { formatTime } from "../../../../../../components/ApprovalCard";
import { FormError } from "../../../../../../components/form-error";
import { OrgGate } from "../../../../../../components/OrgGate";
import { grouped, useFormatCost } from "../../../../../../components/TrajectoryParts";
import { Link } from "../../../../../../i18n/navigation";
import { ApiClientError } from "../../../../../../lib/api";
import { lineDiff } from "../../../../../../lib/diff";
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
  getEvalSet,
  labelEvalResult,
  listEvalResultRows,
  mergeResultRows,
  rowOf,
  runActive,
  sideOf,
  type ToolCallDiffEntry,
} from "../../../../../../lib/evals";
import { useErrorMessage } from "../../../../../../lib/use-error-message";
import { useLoad } from "../../../../../../lib/use-load";

/** 执行中的运行每隔多久重读一次（浏览器内轮询）。 */
const POLL_MS = 5000;
/** 没有变化时轮询逐次加倍放慢，最慢这么久一次。 */
const MAX_POLL_MS = 30_000;

const TABS = ["results", "summary"] as const;
type Tab = (typeof TABS)[number];

/**
 * `/[locale]/evals/runs/[runId]`：评测运行（DetailPage）。页头是状态、进度、token 用量 / 上限与汇总比率；
 * 排队或执行中轮询运行与结果（上一次读完才排下一次；5 秒起，没有变化时加倍放慢到 30 秒），可以取消。结果表只读轻量视图
 * （不含内容块），轮询只取上次之后有变化的行（`updatedSince`）并按 id 合并。「结果」标签页列出每条结果，选中后
 * Inspector 按需读这一条的完整内容，显示文本差异（lineDiff + CodeBlock）、工具调用差异、漂移原因、评委理由与人工标注；
 * 整轮回放的结果可以跳到评测对话的轨迹。
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

type Loaded = {
  run: EvalRun;
  /** 结果的轻量行（按 id 升序）。 */
  rows: EvalResultRow[];
  /** 下一次轮询的 `updatedSince`（内核没给时为 null：每次读全部）。 */
  asOf: string | null;
  titles: Map<string, string>;
};

function EvalRunInOrg({ orgId, runId }: { orgId: string; runId: string }) {
  const t = useTranslations("evals");
  const errorMessage = useErrorMessage();
  const { state, set } = useLoad(async (): Promise<Loaded> => {
    const { run } = await getEvalRun(orgId, runId);
    const [page, setDetail] = await Promise.all([
      listEvalResultRows(orgId, runId),
      // 用例标题只用于显示：读不到时显示用例 id
      getEvalSet(orgId, run.setId).then(
        (r) => r.set,
        () => null,
      ),
    ]);
    return {
      run,
      rows: page.rows,
      asOf: page.asOf,
      titles: new Map((setDetail?.cases ?? []).map((c) => [c.id, c.title])),
    };
  }, [orgId, runId]);
  const data = state.kind === "ready" ? state.data : null;
  /** 最新的数据（轮询与刷新在它之上替换运行与结果，用例标题沿用）。 */
  const latest = useRef(data);
  latest.current = data;
  const active = data !== null && runActive(data.run.status);

  /** 重读运行与有变化的结果行（不重读评测集）；返回运行进度是否有变化。 */
  const refresh = useCallback(async (): Promise<boolean> => {
    const since = latest.current?.asOf ?? undefined;
    const [{ run }, page] = await Promise.all([
      getEvalRun(orgId, runId),
      listEvalResultRows(orgId, runId, since),
    ]);
    const prev = latest.current;
    if (prev === null) return true;
    // 运行刚结束：再整读一次轻量结果（增量读取可能漏掉与上次 asOf 同一时刻写入的最后几行），之后不再轮询
    const full =
      since !== undefined && runActive(prev.run.status) && !runActive(run.status)
        ? await listEvalResultRows(orgId, runId)
        : null;
    set({
      ...prev,
      run,
      rows:
        full !== null
          ? full.rows
          : since === undefined
            ? page.rows
            : mergeResultRows(prev.rows, page.rows),
      asOf: (full ?? page).asOf ?? prev.asOf,
    });
    return (
      prev.run.status !== run.status ||
      prev.run.casesDone !== run.casesDone ||
      prev.run.tokensUsed !== run.tokensUsed
    );
  }, [orgId, runId, set]);

  // 执行中轮询：上一次读完才排下一次（慢的读取不会被下一拍打断或并发），有变化 5 秒、没有变化逐次加倍到
  // 30 秒；运行结束（active 变 false）或卸载时停止
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
        // 读取失败：保留上一次的数据，放慢后再试
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

  if (data !== null) {
    return (
      <EvalRunView
        orgId={orgId}
        data={data}
        onChange={set}
        onRefresh={() => void refresh().catch(() => {})}
      />
    );
  }
  return (
    <DetailPage
      header={{ breadcrumb: [{ label: t("title"), href: "/evals" }], title: t("title") }}
      tabs={{
        label: t("run.tabsLabel"),
        items: TABS.map((x) => ({ id: x, label: t(`run.tabs.${x}`) })),
        value: "results",
      }}
    >
      {state.kind === "loading" ? (
        <Skeleton rows={6} />
      ) : state.kind === "error" ? (
        <FormError message={errorMessage(new ApiClientError(0, state.code, ""))} />
      ) : null}
    </DetailPage>
  );
}

function EvalRunView({
  orgId,
  data,
  onChange,
  onRefresh,
}: {
  orgId: string;
  data: Loaded;
  onChange(data: Loaded): void;
  onRefresh(): void;
}) {
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
  const title = (r: { caseId: string }) => titles.get(r.caseId) ?? r.caseId;
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
        breadcrumb: [{ label: t("title"), href: `/evals/${encodeURIComponent(run.setId)}` }],
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
