import AdminThemesView from "./view";

/**
 * `/admin/themes` (super admins): the deployment's themes. It reads nothing: the layout prefetches
 * them on a first load (`lib/query/routes.ts`).
 */
export default function AdminThemesPage() {
  return <AdminThemesView />;
}
