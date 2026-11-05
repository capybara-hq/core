import CatalogView from "./view";

/**
 * `/catalog` (members up; a setup step, web-order spec §3.8): the org's catalog. It reads nothing:
 * the layout prefetches the catalog on a first load (`lib/query/routes.ts`), and the view reads it
 * from the cache.
 */
export default function CatalogPage() {
  return <CatalogView />;
}
