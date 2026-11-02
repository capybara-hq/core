"use client";

import { formatDateTime, ListPage, ObjectRow } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { usePagePath } from "../../../components/shell/path";
import type { Agent } from "../../../lib/agents";
import type { EvalSet } from "../../../lib/evals";
import { evalsTabs } from "../../../lib/evals-tabs";

/**
 * `/evals`: the eval sets (ListPage, org admins). The header tabs "Eval sets · Runs" link the two
 * routes; a row opens the set. `agents` is null when the server could not read them (names fall
 * back to ids).
 */
export default function EvalSets({
  initial,
}: {
  initial: { sets: EvalSet[]; agents: Agent[] | null };
}) {
  const scope = usePagePath("org");
  const t = useTranslations("evals");
  const { sets, agents } = initial;
  // Agent names are display only: show the id when they cannot be read.
  const agentName = (id: string) => (agents ?? []).find((a) => a.id === id)?.definition.name || id;
  return (
    <ListPage
      header={{
        path: [...scope, { label: "evals" }],
        title: t("title"),
        actions: [{ label: t("new"), variant: "primary", href: "/evals/new" }],
        tabs: evalsTabs(t, { sets: sets.length }),
        activeTab: "sets",
      }}
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
          trailing={formatDateTime(s.createdAt)}
        />
      ))}
    </ListPage>
  );
}
