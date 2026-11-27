import AutomationSettingsView from "./view";

/**
 * `/settings/automations` (org admins): the automation settings and every task of the org. It
 * reads nothing: the layout prefetches them on a first load (`lib/query/routes.ts`).
 */
export default function AutomationSettingsPage() {
  return <AutomationSettingsView />;
}
