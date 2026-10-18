"use client";

import { AgentList } from "../../../../components/AgentList";
import { OrgGate } from "../../../../components/OrgGate";

/** `/[locale]/agents`：当前组织的 agent 列表（`GET /orgs/:orgId/agents`）。 */
export default function AgentsPage() {
  return <OrgGate>{(orgId) => <AgentList orgId={orgId} />}</OrgGate>;
}
