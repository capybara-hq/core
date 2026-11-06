import PluginConnectorsView from "./view";

/**
 * `/plugins/[itemId]/connectors` (org admins; a setup step): 补充配置, the connectors an installed
 * plugin misses. It reads nothing: the layout prefetches the item on a first load
 * (`lib/query/routes.ts`); a missing item is the not-found state in the shell.
 */
export default async function PluginConnectorsPage({
  params,
}: {
  params: Promise<{ itemId: string }>;
}) {
  const { itemId } = await params;
  return <PluginConnectorsView itemId={itemId} />;
}
