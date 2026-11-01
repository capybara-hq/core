import { NoAccess } from "../../components/RoleGate";
import { listAgents, listModels, setupReady } from "../../lib/agents";
import { listConnectors } from "../../lib/connectors";
import { listConversationGroups } from "../../lib/conversations";
import { listInbox } from "../../lib/inbox";
import { listMembers } from "../../lib/members";
import { optional, read } from "../../lib/server/page";
import { orgReadiness, workspace } from "../../lib/server/session";
import { listSkills } from "../../lib/skills";
import HomeView, { type OverviewData } from "./view";

/**
 * `/`: the overview of the current org, read on the server. Until a model and an agent exist the
 * app frame draws the setup home here instead (web-order spec §3.8), and without a current org the
 * org chooser: the page then renders nothing. Counts this role may not read are left out.
 */
export default async function HomePage() {
  const ws = await workspace({ setup: "home" });
  if (ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  const { orgId } = ws;
  if (!setupReady(await orgReadiness(orgId))) return null;
  return <HomeView orgId={orgId} initial={await loadOverview(orgId)} />;
}

async function loadOverview(orgId: string): Promise<OverviewData> {
  const [agents, models, inbox, groups, skills, connectors, members] = await Promise.all([
    read(listAgents(orgId)),
    read(listModels(orgId)),
    read(listInbox(orgId)),
    read(listConversationGroups(orgId, { perGroup: 5, limit: 10 })),
    optional(listSkills(orgId)),
    optional(listConnectors(orgId)),
    optional(listMembers(orgId)),
  ]);
  const recent = groups.groups
    .flatMap((g) => g.conversations.map((c) => ({ ...c, agentName: g.agent.name })))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, 5);
  return {
    agents: agents.agents,
    providers: models.providers,
    inbox: inbox.items,
    recent,
    recentAgents: groups.groups.map((g) => g.agent.id),
    counts: {
      ...(skills ? { skills: skills.skills.length } : {}),
      ...(connectors ? { connectors: connectors.connectors.length } : {}),
      ...(members ? { members: members.members.length } : {}),
    },
  };
}
