"use client";

import { type Column, DataTable, ListPage } from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { formatTime } from "../../../../components/ApprovalCard";
import { OrgGate } from "../../../../components/OrgGate";
import { useRouter } from "../../../../i18n/navigation";
import { listAgents } from "../../../../lib/agents";
import { type EvalSet, listEvalSets } from "../../../../lib/evals";
import { useLoad } from "../../../../lib/use-load";

/**
 * `/[locale]/evals`：评测集列表（ListPage，组织管理员）。页头有「新建评测集」与「运行记录」（轨迹查看器）入口；
 * 打开一行进评测集详情。
 */
export default function EvalsPage() {
  return <OrgGate>{(orgId) => <EvalSets key={orgId} orgId={orgId} />}</OrgGate>;
}

function EvalSets({ orgId }: { orgId: string }) {
  const t = useTranslations("evals");
  const locale = useLocale();
  const router = useRouter();
  const { state, reload } = useLoad(() => listEvalSets(orgId).then((r) => r.sets), [orgId]);
  // agent 名称只用于显示：读不到时显示 id
  const agents = useLoad(() => listAgents(orgId).then((r) => r.agents), [orgId]);
  const agentName = (id: string) =>
    (agents.state.kind === "ready" ? agents.state.data : []).find((a) => a.id === id)?.definition
      .name || id;
  const sets = state.kind === "ready" ? state.data : [];
  const columns: Column<EvalSet>[] = [
    { key: "name", header: t("columns.name"), cell: (s) => s.name },
    { key: "agent", header: t("columns.agent"), cell: (s) => agentName(s.agentId) },
    {
      key: "cases",
      header: t("columns.cases"),
      align: "right",
      width: 100,
      cell: (s) => String(s.caseCount),
    },
    {
      key: "created",
      header: t("columns.created"),
      tone: "muted",
      width: 180,
      cell: (s) => formatTime(s.createdAt, locale),
    },
  ];
  return (
    <ListPage
      header={{
        title: t("title"),
        ...(state.kind === "ready" && { count: String(sets.length) }),
        actions: [
          { label: t("runHistory"), variant: "default", href: "/trajectories" },
          { label: t("new"), variant: "primary", href: "/evals/new" },
        ],
      }}
    >
      <DataTable<EvalSet>
        label={t("title")}
        columns={columns}
        rows={sets}
        rowKey={(s) => s.id}
        rowLabel={(s) => s.name}
        state={state.kind === "loading" ? "loading" : state.kind === "error" ? "error" : "ready"}
        {...(state.kind === "error" && { error: { code: state.code, onRetry: reload } })}
        empty={{ title: t("empty"), hint: t("emptyHint") }}
        onOpen={(s) => router.push(`/evals/${encodeURIComponent(s.id)}`)}
      />
    </ListPage>
  );
}
