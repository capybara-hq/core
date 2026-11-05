"use client";

import { ListPage } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { AgentRow, type AgentScope, inScope, matchesAgent } from "../../../components/AgentList";
import { ErrorFrame } from "../../../components/ErrorFrame";
import { NoAccess } from "../../../components/NoAccess";
import { navLevelOf } from "../../../components/shell/nav";
import { usePagePath } from "../../../components/shell/path";
import { useSession } from "../../../components/shell/session";
import { agentsQuery } from "../../../lib/query/agents";
import { usePageQuery } from "../../../lib/query/page-query";
import { useWorkspace } from "../../../lib/query/workspace";
import NotFound from "../not-found";

/**
 * `/agents`: the agents of the current org as object rows, with scope tabs and a local search,
 * from the query cache (the layout prefetched it on a first load). A change (a new owner)
 * invalidates the list.
 */
export default function AgentsView() {
  const ws = useWorkspace();
  if (ws.kind === "pending" || ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  return <Agents orgId={ws.orgId} />;
}

function Agents({ orgId }: { orgId: string }) {
  const scope = usePagePath("org");
  const t = useTranslations("agents");
  const { me } = useSession();
  const list = usePageQuery(agentsQuery(orgId));
  // agents.create is for members up: guests never see 新建 (R1)
  const canCreate = navLevelOf(me) !== "guest";
  const [tab, setTab] = useState<AgentScope>("all");
  const [query, setQuery] = useState("");
  if (list.kind === "notFound") return <NotFound />;
  if (list.kind === "error") return <ErrorFrame reset={list.retry} />;
  const all = list.kind === "ready" ? list.data.agents : [];
  const count = (s: AgentScope) => all.filter((a) => inScope(a, s, me.account.id)).length;
  const rows = all.filter((a) => inScope(a, tab, me.account.id) && matchesAgent(a, query));
  const tabs = (["all", "mine", "shared"] as const).map((id) => ({
    id,
    label: t(`tabs.${id}`),
    count: count(id),
    onSelect: () => setTab(id),
  }));
  const header = {
    path: [...scope, { label: "agents" }],
    title: t("title"),
    ...(canCreate
      ? { actions: [{ label: t("new"), variant: "primary" as const, href: "/agents/new" }] }
      : {}),
    tabs,
    activeTab: tab,
    search: { label: t("search"), value: query, onChange: setQuery },
  };
  if (list.kind === "loading") return <ListPage header={header} variant="objects" loading />;
  return (
    <ListPage
      header={header}
      variant="objects"
      {...(rows.length === 0
        ? {
            empty:
              all.length === 0
                ? {
                    text: t("empty"),
                    ...(canCreate
                      ? {
                          action: {
                            label: t("new"),
                            variant: "primary" as const,
                            href: "/agents/new",
                          },
                        }
                      : {}),
                  }
                : { text: t("noMatch") },
          }
        : {})}
    >
      {rows.map((a) => (
        <AgentRow key={a.id} agent={a} />
      ))}
    </ListPage>
  );
}
