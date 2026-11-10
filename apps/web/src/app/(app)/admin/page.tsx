import AdminOverview from "./view";

/**
 * `/admin` (super admins): the overview (numbers, 待处理, 最近的平台操作). It reads nothing: the
 * layout prefetches the numbers, the inbox and the audit events on a first load
 * (`lib/query/routes.ts`); the attention lists load in their section.
 */
export default function AdminOverviewPage() {
  return <AdminOverview />;
}
