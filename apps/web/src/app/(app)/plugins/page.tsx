import PluginsView from "./view";

/**
 * `/plugins` (members up; a setup step, web-order spec §3.8): the org's 插件 page. It reads
 * nothing: the layout prefetches the catalog (and for org admins the extensions and the
 * marketplace entries) on a first load (`lib/query/routes.ts`), and the view reads them from the
 * cache.
 */
export default function PluginsPage() {
  return <PluginsView />;
}
