import Sources from "./view";

/**
 * `/admin/marketplaces` (enterprise admins): the marketplaces and the offline flag. It reads
 * nothing: the layout prefetches them on a first load (`lib/query/routes.ts`).
 */
export default function MarketplacesPage() {
  return <Sources />;
}
