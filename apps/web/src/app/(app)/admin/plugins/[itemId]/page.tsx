import PluginDetailView from "./view";

/**
 * `/admin/plugins/[itemId]` (super admins): the plugin, the marketplaces that name its
 * sources, the catalog its dependencies are looked up in and the orgs of its scope. It reads nothing: the layout prefetches
 * them on a first load (`lib/query/routes.ts`).
 */
export default async function AdminPluginPage({ params }: { params: Promise<{ itemId: string }> }) {
  const itemId = decodeURIComponent((await params).itemId);
  return <PluginDetailView itemId={itemId} />;
}
