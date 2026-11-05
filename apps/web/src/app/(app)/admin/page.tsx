import AdminOverview from "./view";

/**
 * `/admin` (enterprise admins): the four overview numbers. It reads nothing: the layout prefetches
 * them on a first load (`lib/query/routes.ts`).
 */
export default function AdminOverviewPage() {
  return <AdminOverview />;
}
