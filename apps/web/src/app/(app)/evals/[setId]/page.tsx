import { NoAccess } from "../../../../components/RoleGate";
import { getAgent } from "../../../../lib/agents";
import { getEvalSet, listEvalRuns } from "../../../../lib/evals";
import { read, section } from "../../../../lib/server/page";
import { workspace } from "../../../../lib/server/session";
import EvalSetView from "./view";

/**
 * `/evals/[setId]` (org admins): the set with its cases (required; unknown → not found), its runs
 * (a section: the runs tab draws its own error) and its agent for the inspector (a section: the id
 * shows), read on the server.
 */
export default async function EvalSetPage({ params }: { params: Promise<{ setId: string }> }) {
  const ws = await workspace({ min: "admin" });
  if (ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  const setId = decodeURIComponent((await params).setId);
  const [{ set }, runs] = await Promise.all([
    read(getEvalSet(ws.orgId, setId)),
    section(listEvalRuns(ws.orgId, setId)),
  ]);
  const agent = await section(getAgent(ws.orgId, set.agentId));
  return (
    <EvalSetView
      orgId={ws.orgId}
      setId={setId}
      initial={{ set, agent: agent?.agent ?? null, runs: runs?.runs ?? null }}
    />
  );
}
