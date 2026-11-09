import PluginConnectorsView from "./view";

/**
 * `/plugins/[itemId]/connectors` (org admins; a setup step): 补充配置, the connectors an installed
 * plugin misses. `?from=connectors`: opened from a `/connectors` card, so its path and its way
 * back lead there. It reads nothing: the layout prefetches the item on a first load
 * (`lib/query/routes.ts`); a missing item is the not-found state in the shell.
 */
export default async function PluginConnectorsPage({
  params,
  searchParams,
}: {
  params: Promise<{ itemId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { itemId } = await params;
  const from = (await searchParams).from;
  return (
    <PluginConnectorsView
      itemId={itemId}
      fromConnectors={(Array.isArray(from) ? from[0] : from) === "connectors"}
    />
  );
}
