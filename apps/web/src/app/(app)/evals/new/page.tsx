import { NoAccess } from "../../../../components/NoAccess";
import { listAgents } from "../../../../lib/agents";
import { read } from "../../../../lib/server/page";
import { workspace } from "../../../../lib/server/session";
import NewEvalSet from "./view";

/**
 * `/evals/new` (org admins): the agents to choose from, read on the server; `?agentId=` (from a
 * trajectory's 加入评测集 with no eval set yet) presets the agent when it is one of them.
 */
export default async function NewEvalSetPage({
  searchParams,
}: {
  searchParams?: Promise<{ agentId?: string | string[] }>;
} = {}) {
  const ws = await workspace({ min: "admin" });
  if (ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  const [{ agents }, query] = await Promise.all([read(listAgents(ws.orgId)), searchParams]);
  const raw = query?.agentId;
  const wanted = Array.isArray(raw) ? raw[0] : raw;
  const preset = agents.some((a) => a.id === wanted) ? (wanted ?? "") : "";
  return <NewEvalSet orgId={ws.orgId} agents={agents} preset={preset} />;
}
