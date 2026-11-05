import AdminSettings from "./view";

/**
 * `/admin/settings` (enterprise admins): the deployment settings. It reads nothing: the layout
 * prefetches them on a first load (`lib/query/routes.ts`).
 */
export default function AdminSettingsPage() {
  return <AdminSettings />;
}
