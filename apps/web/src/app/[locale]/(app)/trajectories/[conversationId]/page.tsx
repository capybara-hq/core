"use client";

import {
  Button,
  Dialog,
  Field,
  KeyValue,
  Select,
  Skeleton,
  SpanWaterfall,
  Stack,
  Text,
  TracePage,
  useToast,
} from "@capybara-hq/design";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { FormError } from "../../../../../components/form-error";
import { OrgGate } from "../../../../../components/OrgGate";
import { useSession } from "../../../../../components/shell/session";
import {
  SpanDetail,
  useSpanLabels,
  useTrajectoryMetrics,
} from "../../../../../components/TrajectoryParts";
import { ApiClientError } from "../../../../../lib/api";
import { addEvalCase, listEvalSets } from "../../../../../lib/evals";
import { canUpdateOrg } from "../../../../../lib/org-settings";
import {
  getTrajectory,
  indexTrajectory,
  type TrajectoryDetail,
  type TrajectoryRun,
} from "../../../../../lib/trajectories";
import { useErrorMessage } from "../../../../../lib/use-error-message";
import { useLoad } from "../../../../../lib/use-load";

/** 每次读多少次运行（按运行分页，不一次读全对话）。 */
const RUN_PAGE = 10;

/**
 * `/[locale]/trajectories/[conversationId]`：轨迹查看器（TracePage，D6）。上方 Span 瀑布，下方选中 span 的详情；
 * 页头是已加载运行的合计（总 token、估算成本、调用数、耗时）。按运行分页：先读最新的 {@link RUN_PAGE} 次，
 * 「加载更早的运行」再往前翻。每次读取都会由内核记入审计（页面上有提示）。「加入评测集」只对组织管理员显示，评测对话（kind = eval）不显示。
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
  const conv = first.conversation;
  // 评测回放的隐藏对话（kind = eval）不能加入评测集（内核只收 chat 对话）
  const canAdd = canUpdateOrg(me) && conv.kind === "chat";
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
      const page = await getTrajectory(orgId, conv.id, { limit: RUN_PAGE, before: next });
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
          parent: { label: t("title"), href: "/trajectories" },
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
                <Text tone="muted">{t("detail.selectHint")}</Text>
              ) : (
                <SpanDetail source={source} currency={first.currency} />
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
