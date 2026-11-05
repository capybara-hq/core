import DirectoryItemView from "./view";

/**
 * `/admin/catalog/[itemId]` (enterprise admins): the item, the marketplaces that name its sources
 * and the catalog items its dependencies are looked up in. It reads nothing: the layout prefetches
 * them on a first load (`lib/query/routes.ts`).
 */
export default async function AdminCatalogItemPage({
  params,
}: {
  params: Promise<{ itemId: string }>;
}) {
  const itemId = decodeURIComponent((await params).itemId);
  return <DirectoryItemView itemId={itemId} />;
}
