"use client";

import {
  Button,
  Dialog,
  Field,
  KeyValue,
  LinkButton,
  Select,
  Skeleton,
  SpanWaterfall,
  Stack,
  Text,
  TracePage,
  useToast,
} from "@capybara-hq/design";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { ErrorFrame } from "../../../../components/ErrorFrame";
import { FormError } from "../../../../components/form-error";
import { NoAccess } from "../../../../components/NoAccess";
import { usePagePath } from "../../../../components/shell/path";
import { useSession } from "../../../../components/shell/session";
import {
  ParentTrajectoryLink,
  SpanDetail,
  useSpanLabels,
  useTrajectoryMetrics,
} from "../../../../components/TrajectoryParts";
import { addEvalCase } from "../../../../lib/evals";
import { canUpdateOrg } from "../../../../lib/org-settings";
import { retryOnMountOf } from "../../../../lib/query/client";
import { useAppMutation } from "../../../../lib/query/define";
import { evalSetsQuery } from "../../../../lib/query/evals";
import { keys } from "../../../../lib/query/keys";
import { membersQuery } from "../../../../lib/query/members";
import { usePageQuery } from "../../../../lib/query/page-query";
import { trajectoryQuery } from "../../../../lib/query/trajectories";
import { useWorkspace } from "../../../../lib/query/workspace";
import {
  indexTrajectory,
  type TrajectoryDetail,
  type TrajectoryRun,
} from "../../../../lib/trajectories";
import { useErrorMessage } from "../../../../lib/use-error-message";
import NotFound from "../../not-found";

/**
 * `/trajectories/[conversationId]`: the trajectory viewer (TracePage, D6). The span waterfall above,
 * the selected span's detail below; the header sums the loaded runs (tokens, estimated cost, calls,
 * duration). By run: the latest runs come from the query cache (the layout prefetched them on a
 * first load; the kernel audits every read, the page says so), "Load earlier runs" pages back in
 * the browser. The members name the runs' starters (the id shows when the kernel refuses them:
 * 403 / 404; any other failure is the page's error state). "Add to eval set" shows only for org
 * admins, never for an eval conversation (kind = eval); its dialog reads the sets when opened.
 */
export default function TrajectoryPageView({ conversationId }: { conversationId: string }) {
  const ws = useWorkspace({ min: "member" });
  if (ws.kind === "pending" || ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  return <TrajectoryData orgId={ws.orgId} conversationId={conversationId} />;
}

function TrajectoryData({ orgId, conversationId }: { orgId: string; conversationId: string }) {
  const scope = usePagePath("org");
  const read = usePageQuery(trajectoryQuery(orgId, conversationId));
  const membersQ = membersQuery(orgId);
  const members = useQuery({ ...membersQ, retryOnMount: retryOnMountOf(membersQ.queryKey) });
  if (read.kind === "notFound") return <NotFound />;
  if (read.kind === "error") return <ErrorFrame reset={read.retry} />;
  const refused = members.error?.status === 403 || members.error?.status === 404;
  if (members.error && members.data === undefined && !refused) {
    return <ErrorFrame reset={() => void members.refetch()} />;
  }
  if (read.kind === "loading" || (members.data === undefined && !refused)) {
    return (
      <TracePage
        header={{ path: [...scope, { label: "trajectories", href: "/trajectories" }], title: "" }}
        waterfall={null}
        detail={null}
        loading={{}}
      />
    );
  }
  const people = Object.fromEntries(
    (members.data?.members ?? []).map((m) => [m.account.id, m.account.displayName]),
  );
  return <TrajectoryView orgId={orgId} first={read.data} people={people} />;
}

function TrajectoryView({
  orgId,
  first,
  people,
}: {
  orgId: string;
  first: TrajectoryDetail;
  /** Account id -> display name (empty when the members are not readable). */
  people: Record<string, string>;
}) {
  const scope = usePagePath("org");
  const t = useTranslations("trajectories");
  const { me } = useSession();
  const errorMessage = useErrorMessage();
  const conv = first.conversation;
  // 评测回放的隐藏对话（kind = eval）不能加入评测集（内核只收 chat 对话）
  // a sub-agent's run can be a case too (under the agent of its conversation)
  const canAdd = canUpdateOrg(me) && (conv.kind === "chat" || conv.kind === "subagent");
  /** 「加载更早的运行」读到的运行（按时间正序，拼在第一页前面）。 */
  const [earlier, setEarlier] = useState<{ runs: TrajectoryRun[]; next: string | null } | null>(
    null,
  );
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [earlierError, setEarlierError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const qc = useQueryClient();

  const runs = [...(earlier?.runs ?? []), ...first.runs];
  const next = earlier !== null ? earlier.next : (first.next ?? null);
  const { spans, sources } = indexTrajectory(runs, useSpanLabels());
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
      const page = await qc.fetchQuery(trajectoryQuery(orgId, conv.id, next));
      setEarlier((e) => ({ runs: [...page.runs, ...(e?.runs ?? [])], next: page.next ?? null }));
    } catch (e) {
      setEarlierError(errorMessage(e));
    } finally {
      setLoadingEarlier(false);
    }
  };

  const metrics = useTrajectoryMetrics(runs, first.currency);
  // 加入评测集：选中 span 所在的运行（没有选中时为最近一次）
  const targetRun = source?.run ?? lastRun;

  return (
    <>
      <TracePage
        header={{
          path: [
            ...scope,
            { label: "trajectories", href: "/trajectories" },
            { label: conv.title ?? t("untitled") },
          ],
          title: conv.title ?? t("untitled"),
          metrics,
          ...(canAdd && {
            actions: [
              { label: t("addToSet.action"), variant: "default", onSelect: () => setAdding(true) },
            ],
          }),
        }}
        waterfall={
          <Stack gap={0}>
            {conv.parent !== undefined ? (
              <ParentTrajectoryLink conversationId={conv.parent.conversationId} />
            ) : null}
            {next !== null ? (
              <Stack direction="row" gap={8} align="center">
                <Button
                  variant="ghost"
                  density="dense"
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
                <Text variant="prose" tone="muted">
                  {t("detail.selectHint")}
                </Text>
              ) : (
                <SpanDetail source={source} currency={first.currency} people={people} />
              )}
            </Stack>
          </section>
        }
      />
      {canAdd && adding && targetRun !== undefined ? (
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

/**
 * 把一次运行加入该 agent 的评测集（组织管理员；`POST /eval-sets/:setId/cases`）。With no eval set
 * for the agent the dialog is not a dead end: its primary is 新建评测集 for that agent.
 */
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
  // The dialog's sets are read when the person opens it (none at first paint).
  const read = useQuery(evalSetsQuery(orgId));
  const sets = (read.data?.sets ?? []).filter((s) => s.agentId === agentId);
  const addCase = useAppMutation({
    fn: (v: { setId: string; conversationId: string; runId: string }) =>
      addEvalCase(orgId, v.setId, { conversationId: v.conversationId, runId: v.runId }),
    invalidates: (v) => [keys.org(orgId).evalSet(v.setId), keys.org(orgId).evalSets()],
  });
  const [setId, setSetId] = useState<string | null>(null);
  const chosen = sets.find((s) => s.id === setId) ?? sets[0];
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const finished = run.end !== null;
  const noSets = read.data !== undefined && sets.length === 0;

  const submit = async () => {
    if (chosen === undefined) return;
    setPending(true);
    setError(null);
    try {
      await addCase.mutateAsync({ setId: chosen.id, conversationId, runId: run.runId });
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
          {noSets ? (
            <LinkButton
              href={`/evals/new?agentId=${encodeURIComponent(agentId)}`}
              variant="primary"
            >
              {t("createSet")}
            </LinkButton>
          ) : (
            <Button
              variant="primary"
              onClick={() => void submit()}
              loading={pending}
              disabled={chosen === undefined || !finished || pending}
            >
              {t("submit")}
            </Button>
          )}
        </>
      }
    >
      <Stack gap={12}>
        <KeyValue rows={[{ k: t("run"), v: run.runId }]} />
        {read.data === undefined && read.error === null ? (
          <Skeleton rows={2} />
        ) : read.data === undefined && read.error !== null ? (
          <FormError message={errorMessage(read.error)} />
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
