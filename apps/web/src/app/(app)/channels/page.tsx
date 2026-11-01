import { NoAccess } from "../../../components/RoleGate";
import { listAgents } from "../../../lib/agents";
import { listChannels } from "../../../lib/channels";
import { read, section } from "../../../lib/server/page";
import { workspace } from "../../../lib/server/session";
import ChannelsView from "./view";

/**
 * `/channels` (org admins): the connections (required) and the agents' names (a section: display
 * only), read on the server.
 */
export default async function ChannelsPage() {
  const ws = await workspace({ min: "admin" });
  if (ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  const [{ channels }, agents] = await Promise.all([
    read(listChannels(ws.orgId)),
    section(listAgents(ws.orgId)),
  ]);
  const agentNames = Object.fromEntries(
    (agents?.agents ?? []).map((a) => [a.id, a.definition.name]),
  );
  return <ChannelsView initial={{ channels, agentNames }} />;
}
