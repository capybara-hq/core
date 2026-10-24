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
  Skeleton,
  Stack,
  StatusMark,
  Text,
  useToast,
} from "@capybara-hq/design";
import { useParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { formatTime } from "../../../../../components/ApprovalCard";
import { FormError } from "../../../../../components/form-error";
import { OrgGate } from "../../../../../components/OrgGate";
import { useRouter } from "../../../../../i18n/navigation";
import { getAgent } from "../../../../../lib/agents";
import { ApiClientError } from "../../../../../lib/api";
import {
  deleteEvalSet,
  type EvalCase,
  type EvalRun,
  type EvalSetDetail,
  evalRunMark,
  getEvalSet,
  listEvalRuns,
  removeEvalCase,
  type SampleInput,
  sampleEvalCases,
} from "../../../../../lib/evals";
import { useErrorMessage } from "../../../../../lib/use-error-message";
import { useLoad } from "../../../../../lib/use-load";

const TABS = ["cases", "runs"] as const;
type Tab = (typeof TABS)[number];

const grouped = new Intl.NumberFormat("en-US");

/**
 * `/[locale]/evals/[setId]`：评测集详情（DetailPage）：标签页「用例」与「运行」，Inspector 是评测集信息。
 * 页头：「从对话抽样」（弹窗）、「运行评测」（向导）、删除。点用例看它的快照轨迹，点运行看结果。
 */
export default function EvalSetPage() {
  const { setId } = useParams<{ setId: string }>();
  return (
    <OrgGate>
      {(orgId) => <EvalSetView key={`${orgId}\n${setId}`} orgId={orgId} setId={setId} />}
    </OrgGate>
  );
}

function EvalSetView({ orgId, setId }: { orgId: string; setId: string }) {
  const t = useTranslations("evals");
  const router = useRouter();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const { state, reload } = useLoad(
    () => getEvalSet(orgId, setId).then((r) => r.set),
    [orgId, setId],
  );
  const [tab, setTab] = useState<Tab>("cases");
  const [sampling, setSampling] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const set = state.kind === "ready" ? state.data : undefined;
  const base = `/evals/${encodeURIComponent(setId)}`;

  return (
    <>
      <DetailPage
        header={{
          parent: { label: t("title"), href: "/evals" },
          title: set?.name ?? t("title"),
          ...(set && {
            count: t("set.count", { n: set.caseCount }),
            actions: [
              { label: t("set.sample"), variant: "default", onSelect: () => setSampling(true) },
              { label: t("set.run"), variant: "primary", href: `${base}/run` },
              {
                label: t("set.more"),
                menu: [{ label: t("set.delete"), danger: true, onSelect: () => setDeleting(true) }],
              },
            ],
          }),
        }}
        tabs={{
          label: t("set.tabsLabel"),
          items: TABS.map((x) => ({
            id: x,
            label: t(`set.tabs.${x}`),
            ...(x === "cases" && set && { count: set.caseCount }),
          })),
          value: tab,
          onChange: (x) => setTab(x as Tab),
        }}
        inspectorTitle={t("set.inspectorTitle")}
        inspector={set ? <SetInspector orgId={orgId} set={set} /> : undefined}
      >
        {state.kind === "loading" ? (
          <Skeleton rows={6} />
        ) : state.kind === "error" ? (
          <FormError message={errorMessage(new ApiClientError(0, state.code, ""))} />
        ) : tab === "cases" ? (
          <CasesTab orgId={orgId} set={state.data} onChanged={reload} />
        ) : (
          <RunsTab orgId={orgId} setId={setId} />
        )}
      </DetailPage>
      {sampling && set ? (
        <SampleDialog
          orgId={orgId}
          setId={setId}
          onClose={() => setSampling(false)}
          onSampled={reload}
        />
      ) : null}
      {set ? (
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
      ) : null}
    </>
  );
}

function SetInspector({ orgId, set }: { orgId: string; set: EvalSetDetail }) {
  const t = useTranslations("evals.set");
  const locale = useLocale();
  const agent = useLoad(
    () => getAgent(orgId, set.agentId).then((r) => r.agent),
    [orgId, set.agentId],
  );
  const agentName =
    agent.state.kind === "ready" ? agent.state.data.definition.name || set.agentId : set.agentId;
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

function RunsTab({ orgId, setId }: { orgId: string; setId: string }) {
  const t = useTranslations("evals");
  const locale = useLocale();
  const router = useRouter();
  const { state, reload } = useLoad(
    () => listEvalRuns(orgId, setId).then((r) => r.runs),
    [orgId, setId],
  );
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
      rows={state.kind === "ready" ? state.data : []}
      rowKey={(r) => r.id}
      rowLabel={(r) => formatTime(r.createdAt, locale)}
      state={state.kind === "loading" ? "loading" : state.kind === "error" ? "error" : "ready"}
      {...(state.kind === "error" && { error: { code: state.code, onRetry: reload } })}
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
