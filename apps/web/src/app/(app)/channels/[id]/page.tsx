import { NoAccess } from "../../../../components/RoleGate";
import { listAgents } from "../../../../lib/agents";
import { getChannel, getChannelSchema } from "../../../../lib/channels";
import { read, section } from "../../../../lib/server/page";
import { workspace } from "../../../../lib/server/session";
import ChannelView from "./view";

/**
 * `/channels/[id]` (org admins): the connection (required: a missing one is not found), its
 * plugin's connection schema and the agents (sections), read on the server.
 */
export default async function ChannelPage({ params }: { params: Promise<{ id: string }> }) {
  const ws = await workspace({ min: "admin" });
  if (ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  const { orgId } = ws;
  const { id } = await params;
  const { channel } = await read(getChannel(orgId, id));
  const [schema, agents] = await Promise.all([
    section(getChannelSchema(orgId, channel.plugin)),
    section(listAgents(orgId)),
  ]);
  return (
    <ChannelView
      orgId={orgId}
      initial={{ channel, schema: schema?.schema ?? null, agents: agents?.agents ?? [] }}
    />
  );
}
