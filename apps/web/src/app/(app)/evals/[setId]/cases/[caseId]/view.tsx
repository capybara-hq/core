"use client";

import { SpanWaterfall, Stack, Text, TracePage } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { usePagePath } from "../../../../../../components/shell/path";
import {
  ParentTrajectoryLink,
  SpanDetail,
  useSpanLabels,
  useTrajectoryMetrics,
} from "../../../../../../components/TrajectoryParts";
import type { EvalCaseDetail } from "../../../../../../lib/evals";
import { indexTrajectory } from "../../../../../../lib/trajectories";

/**
 * `/evals/[setId]/cases/[caseId]`: a case's snapshot trajectory (TracePage, reusing the trajectory
 * viewer's parts). The kernel rebuilds it from the case's snapshot (viewable after the source
 * conversation is deleted) and audits every view. Every run of the snapshot is in the waterfall;
 * the case's own run is selected by default. `setName` is null when the server could not read the
 * set (its id shows in the path).
 */
export default function EvalCaseView({
  setId,
  detail,
  setName,
}: {
  setId: string;
  detail: EvalCaseDetail;
  setName: string | null;
}) {
  return (
    <CaseTrajectory
      parent={{ label: setName ?? setId, href: `/evals/${encodeURIComponent(setId)}` }}
      detail={detail}
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
  const scope = usePagePath("org");
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
      header={{
        path: [...scope, { label: "evals", href: "/evals" }, parent, { label: detail.case.title }],
        title: t("case.title", { title: detail.case.title }),
        metrics,
      }}
      waterfall={
        <Stack gap={0}>
          {detail.parent !== undefined ? (
            <ParentTrajectoryLink conversationId={detail.parent.conversationId} />
          ) : null}
          <SpanWaterfall
            label={tt("waterfall")}
            spans={spans}
            selectedId={selectedId}
            onSelect={setSelected}
            labels={{ empty: tt("empty") }}
          />
        </Stack>
      }
      detail={
        <section aria-label={tt("region")}>
          <Stack gap={12}>
            <Text variant="small" tone="muted">
              {tt("audited")}
            </Text>
            {source === undefined ? (
              <Text variant="prose" tone="muted">
                {tt("selectHint")}
              </Text>
            ) : (
              <SpanDetail source={source} currency={detail.currency} />
            )}
          </Stack>
        </section>
      }
    />
  );
}
