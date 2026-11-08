import AppearanceSettings from "./view";

/**
 * `/settings/appearance` (members and up; admins change it): the org's themes and default theme.
 * It reads nothing: the layout prefetches them on a first load (`lib/query/routes.ts`).
 */
export default function AppearanceSettingsPage() {
  return <AppearanceSettings />;
}
