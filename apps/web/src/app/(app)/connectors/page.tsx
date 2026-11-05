import ConnectorsView from "./view";

/**
 * `/connectors`: the org's connectors (guests read them too). It reads nothing: the layout
 * prefetches the list on a first load (`lib/query/routes.ts`), and the view reads it from the cache.
 */
export default function ConnectorsPage() {
  return <ConnectorsView />;
}
