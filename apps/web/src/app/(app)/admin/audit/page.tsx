import AdminAudit from "./view";

/**
 * `/admin/audit` (super admins): the platform-level audit log. It reads nothing: the layout
 * prefetches the newest page on a first load (`lib/query/routes.ts`).
 */
export default function AdminAuditPage() {
  return <AdminAudit />;
}
