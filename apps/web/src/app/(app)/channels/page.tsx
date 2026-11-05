import ChannelsView from "./view";

/**
 * `/channels` (org admins). It reads nothing: the layout prefetches the connections and the agents
 * (their names) on a first load (`lib/query/routes.ts`), and the view reads them from the cache.
 */
export default function ChannelsPage() {
  return <ChannelsView />;
}
