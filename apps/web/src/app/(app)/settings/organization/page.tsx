import OrganizationSettings from "./view";

/**
 * `/settings/organization` (members and up): the org's settings. It reads nothing: the layout
 * prefetches them on a first load (`lib/query/routes.ts`).
 */
export default function OrganizationSettingsPage() {
  return <OrganizationSettings />;
}
