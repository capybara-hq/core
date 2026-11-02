import { NoAccess } from "../../../../components/NoAccess";
import { listMembers } from "../../../../lib/members";
import { optional, read } from "../../../../lib/server/page";
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
  const [first, members] = await Promise.all([
    read(firstTrajectoryPage(ws.orgId, id)),
    // names are cosmetic: the id shows when the kernel refuses the member list
    optional(listMembers(ws.orgId)),
  ]);
  const people = Object.fromEntries(
    (members?.members ?? []).map((m) => [m.account.id, m.account.displayName]),
  );
  return <TrajectoryView orgId={ws.orgId} first={first} people={people} />;
}
