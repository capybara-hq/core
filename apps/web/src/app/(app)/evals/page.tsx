import { NoAccess } from "../../../components/RoleGate";
import { listAgents } from "../../../lib/agents";
import { listEvalSets } from "../../../lib/evals";
import { read, section } from "../../../lib/server/page";
import { workspace } from "../../../lib/server/session";
import EvalSets from "./view";

/**
 * `/evals` (org admins): the eval sets (required) and the agents for their names (a section: an
 * agent's id shows when they can't be read), read on the server.
 */
export default async function EvalsPage() {
  const ws = await workspace({ min: "admin" });
  if (ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  const [{ sets }, agents] = await Promise.all([
    read(listEvalSets(ws.orgId)),
    section(listAgents(ws.orgId)),
  ]);
  return <EvalSets initial={{ sets, agents: agents?.agents ?? null }} />;
}
