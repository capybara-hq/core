import { NoAccess } from "../../../../components/NoAccess";
import { listAgents } from "../../../../lib/agents";
import { read } from "../../../../lib/server/page";
import { workspace } from "../../../../lib/server/session";
import NewEvalSet from "./view";

/** `/evals/new` (org admins): the agents to choose from, read on the server. */
export default async function NewEvalSetPage() {
  const ws = await workspace({ min: "admin" });
  if (ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  const { agents } = await read(listAgents(ws.orgId));
  return <NewEvalSet orgId={ws.orgId} agents={agents} />;
}
