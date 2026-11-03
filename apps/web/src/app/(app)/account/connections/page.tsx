import Connections from "./view";

/**
 * `/account/connections` (a setup step): the connectors that need each person's own credential. It
 * reads nothing: the layout prefetches the list, then each personal connector's detail (with this
 * person's credential status), on a first load (`lib/query/routes.ts`).
 */
export default function ConnectionsPage() {
  return <Connections />;
}
