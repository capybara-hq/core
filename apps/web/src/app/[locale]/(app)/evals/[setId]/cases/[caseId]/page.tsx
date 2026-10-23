"use client";

import { Skeleton, SpanWaterfall, Stack, Text, TracePage } from "@capybara-hq/design";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { FormError } from "../../../../../../../components/form-error";
import { OrgGate } from "../../../../../../../components/OrgGate";
import {
  SpanDetail,
  useSpanLabels,
  useTrajectoryMetrics,
} from "../../../../../../../components/TrajectoryParts";
import { ApiClientError } from "../../../../../../../lib/api";
import { type EvalCaseDetail, getEvalCase } from "../../../../../../../lib/evals";
import { indexTrajectory } from "../../../../../../../lib/trajectories";
import { useErrorMessage } from "../../../../../../../lib/use-error-message";
import { useLoad } from "../../../../../../../lib/use-load";

/**
 * `/[locale]/evals/[setId]/cases/[caseId]`：用例的快照轨迹（TracePage，复用轨迹查看器的部件）。轨迹由内核从用例快照
 * 还原（原对话删了也能看），每次查看记入审计。快照里的全部运行都在瀑布里，缺省选中用例那次运行。
 */
export default function EvalCasePage() {
  const { setId, caseId } = useParams<{ setId: string; caseId: string }>();
  return (
    <OrgGate>
      {(orgId) => (
        <CaseInOrg key={`${orgId}\n${setId}\n${caseId}`} orgId={orgId} setId={setId} id={caseId} />
      )}
    </OrgGate>
  );
}

function CaseInOrg({ orgId, setId, id }: { orgId: string; setId: string; id: string }) {
  const t = useTranslations("evals");
  const errorMessage = useErrorMessage();
  const { state } = useLoad(() => getEvalCase(orgId, setId, id), [orgId, setId, id]);
  const parent = { label: t("title"), href: `/evals/${encodeURIComponent(setId)}` };
  if (state.kind === "ready") return <CaseTrajectory parent={parent} detail={state.data} />;
  return (
    <TracePage
      header={{ parent, title: t("title") }}
      waterfall={state.kind === "loading" ? <Skeleton rows={6} /> : null}
      detail={
        state.kind === "error" ? (
          <FormError message={errorMessage(new ApiClientError(0, state.code, ""))} />
        ) : null
      }
    />
  );
}

function CaseTrajectory({
  parent,
  detail,
}: {
  parent: { label: string; href: string };
  detail: EvalCaseDetail;
}) {
  const t = useTranslations("evals");
  const tt = useTranslations("trajectories.detail");
  const runs = detail.trajectory;
  const { spans, sources } = indexTrajectory(runs, useSpanLabels());
  const metrics = useTrajectoryMetrics(runs, detail.currency);
  const [selected, setSelected] = useState<string | null>(null);
  const own = `run:${detail.case.sourceRunId}`;
  const selectedId =
    selected !== null && sources.has(selected)
      ? selected
      : sources.has(own)
        ? own
        : runs.length === 0
          ? null
          : `run:${runs.at(-1)?.runId}`;
  const source = selectedId === null ? undefined : sources.get(selectedId);
  return (
    <TracePage
      header={{ parent, title: t("case.title", { title: detail.case.title }), metrics }}
      waterfall={
        <SpanWaterfall
          label={tt("waterfall")}
          spans={spans}
          selectedId={selectedId}
          onSelect={setSelected}
          labels={{ empty: tt("empty") }}
        />
      }
      detail={
        <section aria-label={tt("region")}>
          <Stack gap={12}>
            <Text variant="small" tone="muted">
              {tt("audited")}
            </Text>
            {source === undefined ? (
              <Text tone="muted">{tt("selectHint")}</Text>
            ) : (
              <SpanDetail source={source} currency={detail.currency} />
            )}
          </Stack>
        </section>
      }
    />
  );
}
