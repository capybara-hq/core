import AdminOrgs from "./view";

/**
 * `/admin/orgs` (enterprise admins): the orgs and the deployment settings. It reads nothing: the
 * layout prefetches them on a first load (`lib/query/routes.ts`).
 */
export default function AdminOrgsPage() {
  return <AdminOrgs />;
}
