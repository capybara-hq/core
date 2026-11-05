import Grants from "./view";

/**
 * `/account/grants` (a setup step): this person's standing tool grants. It reads nothing: the layout
 * prefetches them on a first load (`lib/query/routes.ts`), and the view reads them from the cache.
 */
export default function GrantsPage() {
  return <Grants />;
}
