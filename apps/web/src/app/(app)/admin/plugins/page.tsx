import AdminPluginsView from "./view";

/**
 * `/admin/plugins` (super admins, tab 已安装): the plugins, the head's counts, and the
 * marketplaces and orgs that name their sources and scopes. It reads nothing: the layout
 * prefetches them on a first load (`lib/query/routes.ts`).
 */
export default function AdminPluginsPage() {
  return <AdminPluginsView />;
}
