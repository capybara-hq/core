import TrajectoryView from "./view";

/**
 * `/trajectories/[conversationId]` (members; the kernel decides who may see it and answers 404
 * otherwise): the latest runs and the members. It reads nothing: the layout prefetches them on a
 * first load (`lib/query/routes.ts`); each trajectory read is audited by the kernel.
 */
export default async function TrajectoryPage({
  params,
}: {
  params: Promise<{ conversationId: string }>;
}) {
  return <TrajectoryView conversationId={decodeURIComponent((await params).conversationId)} />;
}
