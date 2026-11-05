import AdminPlugins from "./view";

/**
 * `/admin/extensions` (super admins): every extension on the deployment. It reads nothing:
 * the layout prefetches the list on a first load (`lib/query/routes.ts`).
 */
export default function AdminExtensionsPage() {
  return <AdminPlugins />;
}
