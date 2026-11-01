"use client";

import { ListPage } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { AgentRow, type AgentScope, inScope, matchesAgent } from "../../../components/AgentList";
import { navLevelOf } from "../../../components/shell/nav";
import { usePagePath } from "../../../components/shell/path";
import { useSession } from "../../../components/shell/session";
import { useRouter } from "../../../i18n/navigation";
import type { Agent } from "../../../lib/agents";

/**
 * `/agents`: the agents of the current org as object rows, with scope tabs and a local search. The
 * list is read on the server (`page.tsx`); a change (a new owner) re-renders it there.
 */
export default function AgentsView({ initial }: { initial: Agent[] }) {
  const scope = usePagePath("org");
  const t = useTranslations("agents");
  const { me } = useSession();
  const router = useRouter();
  const [, startTransition] = useTransition();
  const refresh = () => startTransition(() => router.refresh());
  // agents.create is for members up: guests never see 新建 (R1)
  const canCreate = navLevelOf(me) !== "guest";
  const [tab, setTab] = useState<AgentScope>("all");
  const [query, setQuery] = useState("");
  const all = initial;
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
                : { icon: "search" as const, text: t("noMatch") },
          }
        : {})}
    >
      {rows.map((a) => (
        <AgentRow key={a.id} agent={a} onChanged={refresh} />
      ))}
    </ListPage>
  );
}
