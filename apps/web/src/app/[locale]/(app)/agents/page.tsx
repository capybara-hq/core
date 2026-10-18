"use client";

import { ListPage } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { AgentTable, useAgents } from "../../../../components/AgentList";
import { OrgGate } from "../../../../components/OrgGate";

/** `/[locale]/agents`：当前组织的 agent 列表（ListPage + DataTable）。 */
export default function AgentsPage() {
  return <OrgGate>{(orgId) => <Agents orgId={orgId} />}</OrgGate>;
}

function Agents({ orgId }: { orgId: string }) {
  const t = useTranslations("agents");
  const agents = useAgents(orgId);
  return (
    <ListPage
      header={{
        title: t("title"),
        count: agents.kind === "ready" ? String(agents.agents.length) : undefined,
        actions: [{ label: t("new"), variant: "primary", href: "/agents/new" }],
      }}
    >
      <AgentTable orgId={orgId} agents={agents} />
    </ListPage>
  );
}
