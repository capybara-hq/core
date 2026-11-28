import NavigationSettingsView from "./view";

/**
 * `/settings/navigation` (org admins): where each plugin page sits in the sidebar. It reads
 * nothing: the layout prefetches the settings and the pages on a first load
 * (`lib/query/routes.ts`).
 */
export default function NavigationSettingsPage() {
  return <NavigationSettingsView />;
}
