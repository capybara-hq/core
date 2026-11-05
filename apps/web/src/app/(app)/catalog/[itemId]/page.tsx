import CatalogItemView from "./view";

/**
 * `/catalog/[itemId]` (members up; a setup step, web-order spec §3.8): a catalog item from the
 * org's view. It reads nothing: the layout prefetches the item on a first load
 * (`lib/query/routes.ts`); a missing one is the not-found state in the shell.
 */
export default async function CatalogItemPage({ params }: { params: Promise<{ itemId: string }> }) {
  const { itemId } = await params;
  return <CatalogItemView itemId={itemId} />;
}
