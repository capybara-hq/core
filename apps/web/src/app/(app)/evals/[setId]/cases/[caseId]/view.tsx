"use client";

import { SpanWaterfall, Stack, Text, TracePage } from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { ErrorFrame } from "../../../../../../components/ErrorFrame";
import { NoAccess } from "../../../../../../components/NoAccess";
import { usePagePath } from "../../../../../../components/shell/path";
import {
  ParentTrajectoryLink,
  SpanDetail,
  useSpanLabels,
  useTrajectoryMetrics,
} from "../../../../../../components/TrajectoryParts";
import type { EvalCaseDetail } from "../../../../../../lib/evals";
import { retryOnMountOf } from "../../../../../../lib/query/client";
import { evalCaseQuery, evalSetQuery } from "../../../../../../lib/query/evals";
import { useMemberNames } from "../../../../../../lib/query/member-names";
import { usePageQuery } from "../../../../../../lib/query/page-query";
import { useWorkspace } from "../../../../../../lib/query/workspace";
import { indexTrajectory } from "../../../../../../lib/trajectories";
import NotFound from "../../../../not-found";

/**
 * `/evals/[setId]/cases/[caseId]`: a case's snapshot trajectory (TracePage, reusing the trajectory
 * viewer's parts). The kernel rebuilds it from the case's snapshot (viewable after the source
 * conversation is deleted) and audits every view. Every run of the snapshot is in the waterfall;
 * the case's own run is selected by default. From the query cache (the layout prefetched it on a
 * first load): the case (required), the set's name for the path (a section: its id shows) and the
 * members for the starter's name (the id shows when the kernel refuses them: 403 / 404; any other
 * failure is the page's error state).
 */
export default function EvalCaseView({ setId, caseId }: { setId: string; caseId: string }) {
  const ws = useWorkspace({ min: "admin" });
  if (ws.kind === "pending" || ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  return <EvalCase orgId={ws.orgId} setId={setId} caseId={caseId} />;
}

function EvalCase({ orgId, setId, caseId }: { orgId: string; setId: string; caseId: string }) {
  const scope = usePagePath("org");
  const detail = usePageQuery(evalCaseQuery(orgId, setId, caseId));
  const setQ = evalSetQuery(orgId, setId);
  const set = useQuery({ ...setQ, retryOnMount: retryOnMountOf(setQ.queryKey) }).data;
  const names = useMemberNames(orgId);
  const parent = { label: set?.name ?? setId, href: `/evals/${encodeURIComponent(setId)}` };
  if (detail.kind === "notFound") return <NotFound />;
  if (detail.kind === "error") return <ErrorFrame reset={detail.retry} />;
  if (names.kind === "error") return <ErrorFrame reset={names.retry} />;
  if (detail.kind === "loading" || names.kind === "loading") {
    return (
      <TracePage
        header={{ path: [...scope, { label: "evals", href: "/evals" }, parent], title: "" }}
        waterfall={null}
        detail={null}
        loading={{}}
      />
    );
  }
  return <CaseTrajectory parent={parent} detail={detail.data} people={names.people} />;
}

function CaseTrajectory({
  parent,
  detail,
  people,
}: {
  parent: { label: string; href: string };
  detail: EvalCaseDetail;
  people: Record<string, string>;
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
              <SpanDetail source={source} currency={detail.currency} people={people} />
            )}
          </Stack>
        </section>
      }
    />
  );
}
