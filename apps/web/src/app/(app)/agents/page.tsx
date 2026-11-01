import { NoAccess } from "../../../components/NoAccess";
import { listAgents } from "../../../lib/agents";
import { read } from "../../../lib/server/page";
import { workspace } from "../../../lib/server/session";
import AgentsView from "./view";

/** `/agents`: the current org's agents, read on the server (guests read them too). */
export default async function AgentsPage() {
  const ws = await workspace();
  if (ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  const { agents } = await read(listAgents(ws.orgId));
  return <AgentsView initial={agents} />;
}
