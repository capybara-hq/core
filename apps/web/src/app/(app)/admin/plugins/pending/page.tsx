import PendingView from "./view";

/**
 * `/admin/plugins/pending` (enterprise admins): the plugins waiting for a permission confirmation
 * and the pending requests. It reads nothing: the layout prefetches both on a first load
 * (`lib/query/routes.ts`).
 */
export default function AdminPluginsPendingPage() {
  return <PendingView />;
}
