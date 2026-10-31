"use client";

import { ListPage } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useState } from "react";
import {
  AgentRow,
  type AgentScope,
  inScope,
  matchesAgent,
  useAgents,
} from "../../../components/AgentList";
import { OrgGate } from "../../../components/OrgGate";
import { usePagePath } from "../../../components/shell/path";
import { useSession } from "../../../components/shell/session";

/** `/agents`: the agents of the current org as object rows, with scope tabs and a local search. */
export default function AgentsPage() {
  return <OrgGate>{(orgId) => <Agents orgId={orgId} />}</OrgGate>;
}

function Agents({ orgId }: { orgId: string }) {
  const scope = usePagePath("org");
  const t = useTranslations("agents");
  const { me } = useSession();
  const agents = useAgents(orgId);
  const [tab, setTab] = useState<AgentScope>("all");
  const [query, setQuery] = useState("");
  const all = agents.kind === "ready" ? agents.agents : [];
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
    actions: [{ label: t("new"), variant: "primary" as const, href: "/agents/new" }],
    ...(agents.kind === "ready"
      ? { tabs, activeTab: tab, search: { label: t("search"), value: query, onChange: setQuery } }
      : {}),
  };
  if (agents.kind === "loading") return <ListPage header={header} variant="objects" loading />;
  if (agents.kind === "error") {
    return (
      <ListPage
        header={header}
        variant="objects"
        empty={{
          icon: "circle-alert",
          text: t("loadFailed"),
          action: { label: t("retry"), variant: "default", onSelect: agents.reload },
        }}
      />
    );
  }
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
                    action: { label: t("new"), variant: "primary" as const, href: "/agents/new" },
                  }
                : { icon: "search" as const, text: t("noMatch") },
          }
        : {})}
    >
      {rows.map((a) => (
        <AgentRow key={a.id} agent={a} />
      ))}
    </ListPage>
  );
}
