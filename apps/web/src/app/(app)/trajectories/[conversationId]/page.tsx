import { NoAccess } from "../../../../components/NoAccess";
import { read } from "../../../../lib/server/page";
import { workspace } from "../../../../lib/server/session";
import { firstTrajectoryPage } from "../../../../lib/server/trajectory";
import TrajectoryView from "./view";

/**
 * `/trajectories/[conversationId]` (members; the kernel decides who may see it and answers 404
 * otherwise): the latest runs, read once on the server (each read is audited).
 */
export default async function TrajectoryPage({
  params,
}: {
  params: Promise<{ conversationId: string }>;
}) {
  const ws = await workspace({ min: "member" });
  if (ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  const id = decodeURIComponent((await params).conversationId);
  const first = await read(firstTrajectoryPage(ws.orgId, id));
  return <TrajectoryView orgId={ws.orgId} first={first} />;
}
