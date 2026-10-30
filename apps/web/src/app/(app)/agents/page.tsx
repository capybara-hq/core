"use client";

import { ListPage } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { AgentTable, useAgents } from "../../../components/AgentList";
import { OrgGate } from "../../../components/OrgGate";
import { usePagePath } from "../../../components/shell/path";

/** `/agents`：当前组织的 agent 列表（ListPage + DataTable）。 */
export default function AgentsPage() {
  return <OrgGate>{(orgId) => <Agents orgId={orgId} />}</OrgGate>;
}

function Agents({ orgId }: { orgId: string }) {
  const scope = usePagePath("org");
  const t = useTranslations("agents");
  const agents = useAgents(orgId);
  return (
    <ListPage
      header={{
        path: [...scope, { label: "agents" }],
        title: t("title"),
        count: agents.kind === "ready" ? String(agents.agents.length) : undefined,
        actions: [{ label: t("new"), variant: "primary", href: "/agents/new" }],
      }}
    >
      <AgentTable orgId={orgId} agents={agents} />
    </ListPage>
  );
}
