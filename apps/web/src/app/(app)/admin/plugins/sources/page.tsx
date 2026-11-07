import Sources from "./view";

/**
 * `/admin/plugins/sources` (super admins): the marketplaces and the offline flag. It reads
 * nothing: the layout prefetches them on a first load (`lib/query/routes.ts`).
 */
export default function MarketplaceSourcesPage() {
  return <Sources />;
}
