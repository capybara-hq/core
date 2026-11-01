import { NoAccess } from "../../../components/NoAccess";
import { listAgents, listModels, setupReady } from "../../../lib/agents";
import { getAttachmentLimits } from "../../../lib/attachments";
import { listConversationGroups } from "../../../lib/conversations";
import { optional, read, section } from "../../../lib/server/page";
import { orgReadiness, workspace } from "../../../lib/server/session";
import NewChatView from "./view";

/**
 * `/chat` (`?agent=<id>`): a new conversation, read on the server: the agents, the agent most
 * recently talked to and the models. Until a model and an agent exist the app frame draws the setup
 * home here instead (web-order spec §3.8), so the page renders nothing then.
 */
export default async function NewChatPage({
  searchParams,
}: {
  searchParams: Promise<{ agent?: string | string[] }>;
}) {
  const ws = await workspace({ setup: "home" });
  if (ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  const { orgId } = ws;
  if (!setupReady(await orgReadiness(orgId))) return null;
  const { agent } = await searchParams;
  const [agents, models, groups, limits] = await Promise.all([
    read(listAgents(orgId)),
    read(listModels(orgId)),
    optional(listConversationGroups(orgId, { perGroup: 1, limit: 1 })),
    section(getAttachmentLimits(orgId)),
  ]);
  return (
    <NewChatView
      orgId={orgId}
      preferredAgent={(Array.isArray(agent) ? agent[0] : agent) ?? null}
      initial={{
        agents: agents.agents,
        providers: models.providers,
        recent: groups?.groups[0]?.agent.id ?? null,
        limits,
      }}
    />
  );
}
