import PluginItemView from "./view";

/**
 * `/plugins/[itemId]` (members up; a setup step, web-order spec §3.8): a plugin from the org's
 * view. It reads nothing: the layout prefetches the item (and for org admins the installs and the
 * extensions) on a first load (`lib/query/routes.ts`); a missing one is the not-found state in the
 * shell.
 */
export default async function PluginItemPage({ params }: { params: Promise<{ itemId: string }> }) {
  const { itemId } = await params;
  return <PluginItemView itemId={itemId} />;
}
