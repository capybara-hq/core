import ChannelView from "./view";

/**
 * `/channels/[id]` (org admins). It reads nothing: the layout prefetches the connection and the
 * agents, then its plugin's connection schema, on a first load (`lib/query/routes.ts`); a missing
 * connection is the not-found state in the shell.
 */
export default async function ChannelPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ChannelView channelId={id} />;
}
