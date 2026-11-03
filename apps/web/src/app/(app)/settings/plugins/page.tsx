import Apps from "./view";

/**
 * `/settings/plugins` (org admins): the org's plugin installs. It reads nothing: the layout
 * prefetches them on a first load (`lib/query/routes.ts`).
 */
export default function PluginsPage() {
  return <Apps />;
}
