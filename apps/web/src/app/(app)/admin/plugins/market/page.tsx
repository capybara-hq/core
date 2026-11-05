import Catalog from "./view";

const first = (v: string | string[] | undefined): string => (typeof v === "string" ? v : "");

/**
 * `/admin/plugins/market` (enterprise admins): the entries for the initial `?sourceId=&q=` and
 * the marketplaces that become the source tabs. It reads nothing: the layout prefetches both on a
 * first load (`lib/query/routes.ts`). Typing in the search and switching the source read in the
 * browser, each source and search its own cache entry.
 */
export default async function MarketplaceEntriesPage({
  searchParams,
}: {
  searchParams: Promise<{ sourceId?: string | string[]; q?: string | string[] }>;
}) {
  const params = await searchParams;
  return <Catalog sourceId={first(params.sourceId)} q={first(params.q).trim()} />;
}
