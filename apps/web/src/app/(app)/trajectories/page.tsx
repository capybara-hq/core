import { NoAccess } from "../../../components/NoAccess";
import { listAgents } from "../../../lib/agents";
import { roleAtLeast } from "../../../lib/members";
import { read, section } from "../../../lib/server/page";
import { workspace } from "../../../lib/server/session";
import { listTrajectories, RUN_STATUSES, type RunStatus } from "../../../lib/trajectories";
import Trajectories, { TRAJECTORY_PAGE } from "./view";

const one = (v: string | string[] | undefined): string => (typeof v === "string" ? v : "");

/**
 * `/trajectories` (members; the kernel shows an agent owner only their agents' conversations): the
 * first page under the query's filters (`?agentId=`, `?status=`; required) and the agents for the
 * filter (a section: the filter then offers only what the query names), read on the server.
 */
export default async function TrajectoriesPage({
  searchParams,
}: {
  searchParams: Promise<{ agentId?: string | string[]; status?: string | string[] }>;
}) {
  const ws = await workspace({ min: "member" });
  if (ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  const q = await searchParams;
  const agentId = one(q.agentId);
  const raw = one(q.status);
  const status: RunStatus | "" = (RUN_STATUSES as readonly string[]).includes(raw)
    ? (raw as RunStatus)
    : "";
  const [agents, page] = await Promise.all([
    section(listAgents(ws.orgId)),
    read(
      listTrajectories(ws.orgId, {
        limit: TRAJECTORY_PAGE,
        ...(agentId !== "" && { agentId }),
        ...(status !== "" && { status }),
      }),
    ),
  ]);
  return (
    <Trajectories
      orgId={ws.orgId}
      admin={roleAtLeast(ws.role, "admin")}
      filters={{ agentId, status }}
      initial={{ agents: agents?.agents ?? null, page }}
    />
  );
}
