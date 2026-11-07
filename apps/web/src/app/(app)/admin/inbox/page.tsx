import AdminInboxView from "./view";

/**
 * `/admin/inbox` (super admins): what waits on the platform. It reads nothing: the layout
 * prefetches the inbox on a first load (`lib/query/routes.ts`).
 */
export default function AdminInboxPage() {
  return <AdminInboxView />;
}
