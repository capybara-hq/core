import CatalogInstallView from "./view";

/**
 * `/catalog/[itemId]/install` (org admins; a setup step, web-order spec §3.8). It reads nothing: the
 * layout prefetches the item and the org's extensions on a first load (`lib/query/routes.ts`); a
 * missing item is the not-found state in the shell.
 */
export default async function CatalogInstallPage({
  params,
}: {
  params: Promise<{ itemId: string }>;
}) {
  const { itemId } = await params;
  return <CatalogInstallView itemId={itemId} />;
}
