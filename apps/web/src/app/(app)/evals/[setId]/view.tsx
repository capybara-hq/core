"use client";

import {
  Button,
  type Column,
  DangerConfirm,
  DataTable,
  DetailPage,
  Dialog,
  Field,
  Input,
  KeyValue,
  Select,
  Stack,
  StatusMark,
  Text,
  useToast,
} from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { formatTime } from "../../../../components/ApprovalCard";
import { FormError } from "../../../../components/form-error";
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
import { useErrorMessage } from "../../../../lib/use-error-message";

const TABS = ["cases", "runs"] as const;
type Tab = (typeof TABS)[number];

const grouped = new Intl.NumberFormat("en-US");

/**
 * `/evals/[setId]`: an eval set (DetailPage): the tabs "Cases" and "Runs", the inspector is the
 * set's info. Header: "Sample from conversations" (dialog), "Run eval" (wizard), delete. A case
 * opens its snapshot trajectory, a run its results. Everything comes from the server; `agent` and
 * `runs` are null when it could not read them (the agent's id shows; the runs tab draws its error).
 * After a change the page renders again on the server.
 */
export default function EvalSetView({
  orgId,
  setId,
  initial,
}: {
  orgId: string;
  setId: string;
  initial: { set: EvalSetDetail; agent: Agent | null; runs: EvalRun[] | null };
}) {
  const scope = usePagePath("org");
  const t = useTranslations("evals");
  const router = useRouter();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const [, startTransition] = useTransition();
  const refresh = () => startTransition(() => router.refresh());
  const { set } = initial;
  const [tab, setTab] = useState<Tab>("cases");
  const [sampling, setSampling] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const base = `/evals/${encodeURIComponent(setId)}`;

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
        inspectorTitle={t("set.inspectorTitle")}
        inspector={<SetInspector set={set} agent={initial.agent} />}
      >
        {tab === "cases" ? (
          <CasesTab orgId={orgId} set={set} onChanged={refresh} />
        ) : (
          <RunsTab runs={initial.runs} onRetry={refresh} />
        )}
      </DetailPage>
      {sampling ? (
        <SampleDialog
          orgId={orgId}
          setId={setId}
          onClose={() => setSampling(false)}
          onSampled={refresh}
        />
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
            await deleteEvalSet(orgId, setId);
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

function SetInspector({ set, agent }: { set: EvalSetDetail; agent: Agent | null }) {
  const t = useTranslations("evals.set");
  const locale = useLocale();
  // Display only: the agent's id when it could not be read.
  const agentName = agent?.definition.name || set.agentId;
  return (
    <Stack gap={12}>
      <KeyValue
        keyWidth="10ch"
        rows={[
          { k: t("agent"), v: agentName },
          { k: t("created"), v: formatTime(set.createdAt, locale) },
        ]}
      />
      {set.description !== "" ? (
        <Stack gap={4}>
          <Text variant="small" tone="muted">
            {t("description")}
          </Text>
          <Text pre>{set.description}</Text>
        </Stack>
      ) : null}
      <Stack gap={4}>
        <Text variant="small" tone="muted">
          {t("rubric")}
        </Text>
        {set.rubric === null ? (
          <Text tone="muted">{t("defaultRubric")}</Text>
        ) : (
          <Text pre>{set.rubric}</Text>
        )}
      </Stack>
    </Stack>
  );
}

function CasesTab({
  orgId,
  set,
  onChanged,
}: {
  orgId: string;
  set: EvalSetDetail;
  onChanged(): void;
}) {
  const t = useTranslations("evals.set");
  const locale = useLocale();
  const router = useRouter();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const caseHref = (c: EvalCase) =>
    `/evals/${encodeURIComponent(set.id)}/cases/${encodeURIComponent(c.id)}`;
  const remove = async (c: EvalCase) => {
    try {
      await removeEvalCase(orgId, set.id, c.id);
      toast.success(t("caseRemoved"));
      onChanged();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const columns: Column<EvalCase>[] = [
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
      cell: (c) => formatTime(c.createdAt, locale),
    },
  ];
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

function RunsTab({ runs, onRetry }: { runs: EvalRun[] | null; onRetry(): void }) {
  const t = useTranslations("evals");
  const locale = useLocale();
  const router = useRouter();
  const columns: Column<EvalRun>[] = [
    {
      key: "created",
      header: t("set.runColumns.created"),
      width: 170,
      cell: (r) => formatTime(r.createdAt, locale),
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
      rowLabel={(r) => formatTime(r.createdAt, locale)}
      state={runs === null ? "error" : "ready"}
      error={{ code: "unknown", onRetry }}
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
  onSampled,
}: {
  orgId: string;
  setId: string;
  onClose(): void;
  onSampled(): void;
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
  const n = Number(count);
  const min = Number(minToolCalls);
  const valid =
    Number.isInteger(n) && n >= 1 && n <= 50 && Number.isInteger(min) && min >= 0 && min <= 1000;

  const submit = async () => {
    if (!valid) return;
    setPending(true);
    setError(null);
    try {
      const r = await sampleEvalCases(orgId, setId, {
        count: n,
        status,
        minToolCalls: min,
        ...(from !== "" && { from: dayStart(from) }),
        ...(to !== "" && { to: dayStart(to) }),
      });
      toast.success(t("done", { added: r.added, skipped: r.skipped }));
      onSampled();
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
        <Text tone="muted">{t("hint")}</Text>
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
