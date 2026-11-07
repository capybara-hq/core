"use client";

import {
  Button,
  type Column,
  DangerConfirm,
  DataTable,
  DateTime,
  DetailPage,
  Dialog,
  Disclosure,
  Field,
  formatDateTime,
  Input,
  KeyValue,
  Select,
  Stack,
  StatusMark,
  Text,
  useTimeZone,
  useToast,
} from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { ErrorFrame } from "../../../../components/ErrorFrame";
import { FormError } from "../../../../components/form-error";
import { NoAccess } from "../../../../components/NoAccess";
import { usePagePath } from "../../../../components/shell/path";
import { useRouter } from "../../../../i18n/navigation";
import type { Agent } from "../../../../lib/agents";
import {
  deleteEvalSet,
  type EvalCase,
  type EvalRun,
  type EvalSetDetail,
  evalRunMark,
  removeEvalCase,
  type SampleInput,
  sampleEvalCases,
} from "../../../../lib/evals";
import { agentQuery } from "../../../../lib/query/agents";
import { retryOnMountOf } from "../../../../lib/query/client";
import { evalRunsQuery, evalSetQuery } from "../../../../lib/query/evals";
import { keys } from "../../../../lib/query/keys";
import { useAppMutation } from "../../../../lib/query/mutation";
import { usePageQuery } from "../../../../lib/query/page-query";
import { useWorkspace } from "../../../../lib/query/workspace";
import { useErrorMessage } from "../../../../lib/use-error-message";
import NotFound from "../../not-found";

const TABS = ["cases", "runs"] as const;
type Tab = (typeof TABS)[number];

const grouped = new Intl.NumberFormat("en-US");

/**
 * `/evals/[setId]`: an eval set (DetailPage, one centred column): the set's facts first (the
 * description, agent, created, rubric), then the tabs "Cases" and "Runs". Header: "Sample from conversations" (dialog), "Run eval" (wizard), delete. A case
 * opens its snapshot trajectory, a run its results. From the query cache (the layout prefetched it
 * on a first load): the set (required), its runs (a section: the runs tab draws its own error)
 * and its agent (a section: the agent's id shows). A change invalidates the set (and the sets
 * list, whose case counts change).
 */
export default function EvalSetView({ setId }: { setId: string }) {
  const ws = useWorkspace({ min: "admin" });
  if (ws.kind === "pending" || ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  return <EvalSet orgId={ws.orgId} setId={setId} />;
}

function EvalSet({ orgId, setId }: { orgId: string; setId: string }) {
  const scope = usePagePath("org");
  const t = useTranslations("evals");
  const tSet = useTranslations("evals.set");
  const router = useRouter();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const read = usePageQuery(evalSetQuery(orgId, setId));
  const set = read.kind === "ready" ? read.data : undefined;
  const runsQ = evalRunsQuery(orgId, setId);
  const runs = useQuery({ ...runsQ, retryOnMount: retryOnMountOf(runsQ.queryKey) });
  const agentQ = agentQuery(orgId, set?.agentId ?? "");
  const agent = useQuery({
    ...agentQ,
    enabled: set !== undefined,
    retryOnMount: retryOnMountOf(agentQ.queryKey),
  }).data;
  // A delete invalidates the sets list (where this page goes) and forgets the set and its runs
  // once this page is left.
  const remove = useAppMutation({
    fn: () => deleteEvalSet(orgId, setId),
    invalidates: () => [keys.org(orgId).evalSets()],
    forgetsOnLeave: () => [keys.org(orgId).evalSet(setId), keys.org(orgId).evalRuns(setId)],
  });
  const [tab, setTab] = useState<Tab>("cases");
  const [sampling, setSampling] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const base = `/evals/${encodeURIComponent(setId)}`;
  if (read.kind === "notFound") return <NotFound />;
  if (read.kind === "error") return <ErrorFrame reset={read.retry} />;
  if (set === undefined) {
    return (
      <DetailPage
        header={{
          path: [...scope, { label: "evals", href: "/evals" }],
          title: "",
          // the loaded head's three actions: sample, run, more
          loading: { title: true, actions: 3 },
        }}
        tabs={{
          label: t("set.tabsLabel"),
          items: TABS.map((x) => ({ id: x, label: t(`set.tabs.${x}`) })),
          value: tab,
          onChange: (x) => setTab(x as Tab),
        }}
        // The facts (the description's line, then agent, created, the rubric), then the cases
        // tab (its table)
        loading={{
          facts: { rows: 3, keyWidth: "10ch", lead: true },
          content: [
            {
              kind: "table",
              label: t("set.casesLabel"),
              columns: caseColumns(tSet) as Column<never>[],
            },
          ],
        }}
      />
    );
  }

  return (
    <>
      <DetailPage
        header={{
          path: [...scope, { label: "evals", href: "/evals" }, { label: set.name }],
          title: set.name,
          count: t("set.count", { n: set.caseCount }),
          actions: [
            { label: t("set.sample"), variant: "default", onSelect: () => setSampling(true) },
            { label: t("set.run"), variant: "primary", href: `${base}/run` },
            {
              label: t("set.more"),
              menu: [{ label: t("set.delete"), danger: true, onSelect: () => setDeleting(true) }],
            },
          ],
        }}
        tabs={{
          label: t("set.tabsLabel"),
          items: TABS.map((x) => ({
            id: x,
            label: t(`set.tabs.${x}`),
            ...(x === "cases" && { count: set.caseCount }),
          })),
          value: tab,
          onChange: (x) => setTab(x as Tab),
        }}
        facts={<SetFacts set={set} agent={agent ?? null} />}
      >
        {tab === "cases" ? (
          <CasesTab orgId={orgId} set={set} />
        ) : (
          <RunsTab
            runs={runs.data?.runs ?? null}
            state={runs.data !== undefined ? "ready" : runs.error ? "error" : "loading"}
            code={runs.error?.code ?? "unknown"}
            onRetry={() => void runs.refetch()}
          />
        )}
      </DetailPage>
      {sampling ? (
        <SampleDialog orgId={orgId} setId={setId} onClose={() => setSampling(false)} />
      ) : null}
      <DangerConfirm
        open={deleting}
        onOpenChange={setDeleting}
        title={t("set.deleteTitle", { name: set.name })}
        description={t("set.deleteHint")}
        confirmName={set.name}
        confirmLabel={t("set.delete")}
        onConfirm={async () => {
          try {
            await remove.mutateAsync(undefined);
          } catch (e) {
            throw new Error(errorMessage(e));
          }
          setDeleting(false);
          toast.success(t("set.deleted", { name: set.name }));
          router.push("/evals");
        }}
      />
    </>
  );
}

/**
 * The set's facts at the top of the column (spec §5.2): the full description first (line breaks
 * kept), then the agent, the creation time and the rubric. The default rubric is a row; a custom
 * one, often several lines, is a folded section under the rows (the row would cut it to one line).
 */
function SetFacts({ set, agent }: { set: EvalSetDetail; agent: Agent | null }) {
  const t = useTranslations("evals.set");
  // Display only: the agent's id when it could not be read.
  const agentName = agent?.definition.name || set.agentId;
  return (
    <Stack gap={12}>
      {set.description !== "" ? (
        <Text variant="prose" tone="muted" pre>
          {set.description}
        </Text>
      ) : null}
      <KeyValue
        keyWidth="10ch"
        rows={[
          { k: t("agent"), v: agentName },
          { k: t("created"), v: <DateTime value={set.createdAt} /> },
          ...(set.rubric === null
            ? [{ k: t("rubric"), v: <Text tone="muted">{t("defaultRubric")}</Text> }]
            : []),
        ]}
      />
      {set.rubric !== null ? (
        <Disclosure summary={t("rubric")}>
          <Text pre>{set.rubric}</Text>
        </Disclosure>
      ) : null}
    </Stack>
  );
}

/** What a change to a set's cases changes: the set and the sets list (its case counts). */
const caseChangeKeys = (orgId: string, setId: string) => [
  keys.org(orgId).evalSet(setId),
  keys.org(orgId).evalSets(),
];

/** The cases table's columns (the loading table draws the same header). */
const caseColumns = (t: ReturnType<typeof useTranslations<"evals.set">>): Column<EvalCase>[] => [
  {
    key: "title",
    header: t("caseColumns.title"),
    cell: (c) => <Text truncate>{c.title}</Text>,
  },
  {
    key: "version",
    header: t("caseColumns.version"),
    width: 110,
    tone: "muted",
    cell: (c) => `v${c.agentVersion}`,
  },
  {
    key: "steps",
    header: t("caseColumns.steps"),
    width: 120,
    align: "right",
    cell: (c) => String(c.replayableSteps),
  },
  {
    key: "created",
    header: t("caseColumns.created"),
    width: 170,
    tone: "muted",
    cell: (c) => <DateTime value={c.createdAt} />,
  },
];

function CasesTab({ orgId, set }: { orgId: string; set: EvalSetDetail }) {
  const t = useTranslations("evals.set");
  const router = useRouter();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const caseHref = (c: EvalCase) =>
    `/evals/${encodeURIComponent(set.id)}/cases/${encodeURIComponent(c.id)}`;
  const removeCase = useAppMutation({
    fn: (caseId: string) => removeEvalCase(orgId, set.id, caseId),
    invalidates: () => caseChangeKeys(orgId, set.id),
  });
  const remove = async (c: EvalCase) => {
    try {
      await removeCase.mutateAsync(c.id);
      toast.success(t("caseRemoved"));
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const columns = caseColumns(t);
  return (
    <DataTable<EvalCase>
      label={t("casesLabel")}
      columns={columns}
      rows={set.cases}
      rowKey={(c) => c.id}
      rowLabel={(c) => c.title}
      state="ready"
      empty={{ title: t("casesEmpty"), hint: t("casesEmptyHint") }}
      onOpen={(c) => router.push(caseHref(c))}
      rowMenu={(c) => [
        { label: t("viewTrajectory"), href: caseHref(c) },
        { label: t("removeCase"), danger: true, onSelect: () => void remove(c) },
      ]}
    />
  );
}

function RunsTab({
  runs,
  state,
  code,
  onRetry,
}: {
  runs: EvalRun[] | null;
  state: "ready" | "loading" | "error";
  code: string;
  onRetry(): void;
}) {
  const timeZone = useTimeZone();
  const t = useTranslations("evals");
  const router = useRouter();
  const columns: Column<EvalRun>[] = [
    {
      key: "created",
      header: t("set.runColumns.created"),
      width: 170,
      cell: (r) => <DateTime value={r.createdAt} />,
    },
    { key: "mode", header: t("set.runColumns.mode"), cell: (r) => t(`mode.${r.mode}`) },
    {
      key: "status",
      header: t("set.runColumns.status"),
      cell: (r) => <StatusMark status={evalRunMark(r.status)} label={t(`runStatus.${r.status}`)} />,
    },
    {
      key: "progress",
      header: t("set.runColumns.progress"),
      align: "right",
      width: 90,
      cell: (r) => `${r.casesDone}/${r.casesTotal}`,
    },
    {
      key: "tokens",
      header: t("set.runColumns.tokens"),
      align: "right",
      tone: "muted",
      cell: (r) => `${grouped.format(r.tokensUsed)} / ${grouped.format(r.tokenCap)}`,
    },
  ];
  return (
    <DataTable<EvalRun>
      label={t("set.runsLabel")}
      columns={columns}
      rows={runs ?? []}
      rowKey={(r) => r.id}
      rowLabel={(r) => formatDateTime(r.createdAt, "full", timeZone)}
      state={state}
      error={{ code, onRetry }}
      empty={{ title: t("set.runsEmpty") }}
      onOpen={(r) => router.push(`/evals/runs/${encodeURIComponent(r.id)}`)}
    />
  );
}

/** 本地日期（`YYYY-MM-DD`）的零点，ISO 时间（内核要求带时区）。 */
const dayStart = (d: string) => new Date(`${d}T00:00:00`).toISOString();

/** 「从对话抽样」弹窗（`POST /eval-sets/:setId/cases/sample`）。 */
function SampleDialog({
  orgId,
  setId,
  onClose,
}: {
  orgId: string;
  setId: string;
  onClose(): void;
}) {
  const t = useTranslations("evals.sample");
  const tc = useTranslations("common");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const [count, setCount] = useState("10");
  const [status, setStatus] = useState<NonNullable<SampleInput["status"]>>("completed");
  const [minToolCalls, setMinToolCalls] = useState("0");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sample = useAppMutation({
    fn: (body: SampleInput) => sampleEvalCases(orgId, setId, body),
    invalidates: () => caseChangeKeys(orgId, setId),
  });
  const n = Number(count);
  const min = Number(minToolCalls);
  const valid =
    Number.isInteger(n) && n >= 1 && n <= 50 && Number.isInteger(min) && min >= 0 && min <= 1000;

  const submit = async () => {
    if (!valid) return;
    setPending(true);
    setError(null);
    try {
      const r = await sample.mutateAsync({
        count: n,
        status,
        minToolCalls: min,
        ...(from !== "" && { from: dayStart(from) }),
        ...(to !== "" && { to: dayStart(to) }),
      });
      toast.success(t("done", { added: r.added, skipped: r.skipped }));
      onClose();
    } catch (e) {
      setError(errorMessage(e));
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
            disabled={!valid || pending}
          >
            {t("submit")}
          </Button>
        </>
      }
    >
      <Stack gap={12}>
        <Text variant="prose" tone="muted">
          {t("hint")}
        </Text>
        <Field label={t("count")}>
          <Input
            type="number"
            min={1}
            max={50}
            value={count}
            onChange={(e) => setCount(e.target.value)}
          />
        </Field>
        <Field label={t("status")}>
          <Select
            value={status}
            onChange={(e) => setStatus(e.target.value as typeof status)}
            options={(["completed", "failed", "any"] as const).map((s) => ({
              value: s,
              label: t(`statuses.${s}`),
            }))}
          />
        </Field>
        <Field label={t("minToolCalls")}>
          <Input
            type="number"
            min={0}
            max={1000}
            value={minToolCalls}
            onChange={(e) => setMinToolCalls(e.target.value)}
          />
        </Field>
        <Field label={t("from")} optional>
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label={t("to")} optional>
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
        {error !== null ? <FormError message={error} /> : null}
      </Stack>
    </Dialog>
  );
}
