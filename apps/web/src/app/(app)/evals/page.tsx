"use client";

import { ListPage, ObjectRow } from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { formatTime } from "../../../components/ApprovalCard";
import { OrgGate } from "../../../components/OrgGate";
import { usePagePath } from "../../../components/shell/path";
import { listAgents } from "../../../lib/agents";
import { listEvalSets } from "../../../lib/evals";
import { evalsTabs } from "../../../lib/evals-tabs";
import { useLoad } from "../../../lib/use-load";

/**
 * `/evals`：评测集列表（ListPage，组织管理员）。页头标签「评测集 · 运行记录」链到两个路由；
 * 打开一行进评测集详情。
 */
export default function EvalsPage() {
  return <OrgGate>{(orgId) => <EvalSets key={orgId} orgId={orgId} />}</OrgGate>;
}

function EvalSets({ orgId }: { orgId: string }) {
  const scope = usePagePath("org");
  const t = useTranslations("evals");
  const locale = useLocale();
  const { state, reload } = useLoad(() => listEvalSets(orgId).then((r) => r.sets), [orgId]);
  // Agent names are display only: show the id when they cannot be read.
  const agents = useLoad(() => listAgents(orgId).then((r) => r.agents), [orgId]);
  const agentName = (id: string) =>
    (agents.state.kind === "ready" ? agents.state.data : []).find((a) => a.id === id)?.definition
      .name || id;
  const sets = state.kind === "ready" ? state.data : [];
  const empty =
    state.kind === "error"
      ? {
          icon: "circle-alert" as const,
          text: t("loadFailed"),
          action: { label: t("retry"), variant: "default" as const, onSelect: reload },
        }
      : state.kind === "ready" && sets.length === 0
        ? {
            text: t("empty"),
            action: { label: t("new"), variant: "primary" as const, href: "/evals/new" },
          }
        : undefined;
  return (
    <ListPage
      header={{
        path: [...scope, { label: "evals" }],
        title: t("title"),
        actions: [{ label: t("new"), variant: "primary", href: "/evals/new" }],
        tabs: evalsTabs(t, state.kind === "ready" ? { sets: sets.length } : {}),
        activeTab: "sets",
      }}
      variant="objects"
      listLabel={t("tabs.sets")}
      loading={state.kind === "loading"}
      {...(empty ? { empty } : {})}
    >
      {sets.map((s) => (
        <ObjectRow
          key={s.id}
          mark={{ icon: "evals" }}
          name={s.name}
          href={`/evals/${encodeURIComponent(s.id)}`}
          meta={t("setMeta", { agent: agentName(s.agentId), n: s.caseCount })}
          trailing={formatTime(s.createdAt, locale)}
        />
      ))}
    </ListPage>
  );
}
