"use client";

import { formatDateTime, ListPage, ObjectRow, useTimeZone } from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { ErrorFrame } from "../../../components/ErrorFrame";
import { NoAccess } from "../../../components/NoAccess";
import { usePagePath } from "../../../components/shell/path";
import { evalsTabs } from "../../../lib/evals-tabs";
import { agentsQuery } from "../../../lib/query/agents";
import { retryOnMountOf } from "../../../lib/query/client";
import { evalSetsQuery } from "../../../lib/query/evals";
import { usePageQuery } from "../../../lib/query/page-query";
import { useWorkspace } from "../../../lib/query/workspace";
import NotFound from "../not-found";

/**
 * `/evals`: the eval sets (ListPage, org admins). The header tabs "Eval sets · Runs" link the two
 * routes; a row opens the set. From the query cache (the layout prefetched it on a first load):
 * the sets, and the agents for their names (a section, display only: an agent's id shows when they
 * can't be read).
 */
export default function EvalSetsView() {
  const ws = useWorkspace({ min: "admin" });
  if (ws.kind === "pending" || ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  return <EvalSets orgId={ws.orgId} />;
}

function EvalSets({ orgId }: { orgId: string }) {
  const timeZone = useTimeZone();
  const scope = usePagePath("org");
  const t = useTranslations("evals");
  const list = usePageQuery(evalSetsQuery(orgId));
  const agentsQ = agentsQuery(orgId);
  const agents = useQuery({ ...agentsQ, retryOnMount: retryOnMountOf(agentsQ.queryKey) }).data;
  if (list.kind === "notFound") return <NotFound />;
  if (list.kind === "error") return <ErrorFrame reset={list.retry} />;
  const sets = list.kind === "ready" ? list.data.sets : [];
  // Agent names are display only: show the id when they cannot be read.
  const agentName = (id: string) =>
    (agents?.agents ?? []).find((a) => a.id === id)?.definition.name || id;
  const header = {
    path: [...scope, { label: "evals" }],
    title: t("title"),
    actions: [{ label: t("new"), variant: "primary" as const, href: "/evals/new" }],
    tabs: evalsTabs(t, list.kind === "ready" ? { sets: sets.length } : {}),
    activeTab: "sets",
  };
  if (list.kind === "loading") {
    return <ListPage header={header} variant="objects" listLabel={t("tabs.sets")} loading />;
  }
  return (
    <ListPage
      header={header}
      variant="objects"
      listLabel={t("tabs.sets")}
      {...(sets.length === 0 && {
        empty: {
          text: t("empty"),
          action: { label: t("new"), variant: "primary" as const, href: "/evals/new" },
        },
      })}
    >
      {sets.map((s) => (
        <ObjectRow
          key={s.id}
          mark={{ text: s.name }}
          name={s.name}
          href={`/evals/${encodeURIComponent(s.id)}`}
          meta={t("setMeta", { agent: agentName(s.agentId), n: s.caseCount })}
          trailing={formatDateTime(s.createdAt, "full", timeZone)}
        />
      ))}
    </ListPage>
  );
}
