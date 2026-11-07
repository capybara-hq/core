import PluginEnableView from "./view";

/**
 * `/plugins/[itemId]/enable` (org admins; a setup step, web-order spec §3.8): the input a plugin
 * asks for before it is switched on. It reads nothing: the layout prefetches the item and the org's
 * extensions on a first load (`lib/query/routes.ts`); a missing item is the not-found state in the
 * shell.
 */
export default async function PluginEnablePage({
  params,
}: {
  params: Promise<{ itemId: string }>;
}) {
  const { itemId } = await params;
  return <PluginEnableView itemId={itemId} />;
}
