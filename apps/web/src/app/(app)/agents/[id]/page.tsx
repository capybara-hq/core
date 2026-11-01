import { NoAccess } from "../../../../components/RoleGate";
import { getAgent } from "../../../../lib/agents";
import { listChannels } from "../../../../lib/channels";
import { canUpdateOrg } from "../../../../lib/org-settings";
import { loadAgentForm } from "../../../../lib/server/agent-form";
import { read, section } from "../../../../lib/server/page";
import { workspace } from "../../../../lib/server/session";
import AgentView from "./view";

/**
 * `/agents/[id]`: a setup step (web-order spec §3.8). The agent is read on the server; the owner
 * (members up) and org admins also get the form's lists and the agent's channel connections, others
 * the read-only view (R3). The kernel stays the authority on every save.
 */
export default async function AgentPage({ params }: { params: Promise<{ id: string }> }) {
  const ws = await workspace({ setup: "step" });
  if (ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  const { orgId, me, role } = ws;
  const { id } = await params;
  const { agent } = await read(getAgent(orgId, id));
  const canEdit = role !== "guest" && (agent.ownerAccountId === me.account.id || canUpdateOrg(me));
  if (!canEdit) return <AgentView orgId={orgId} initial={{ agent, edit: null }} />;
  const [form, channels] = await Promise.all([
    loadAgentForm(orgId, agent),
    section(listChannels(orgId)),
  ]);
  return (
    <AgentView
      orgId={orgId}
      initial={{
        agent,
        edit: {
          form,
          channels: channels?.channels.filter((c) => c.agentId === agent.id) ?? null,
        },
      }}
    />
  );
}
