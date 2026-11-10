import { connectorStatusOf } from "../../../../lib/admin-items";
import AdminConnectorsView from "./view";

const one = (v: string | string[] | undefined): string => (typeof v === "string" ? v : "");

/**
 * `/admin/connectors` (super admins): every org's connectors under the address's
 * `?orgId=&status=&q=`. It reads nothing: the layout prefetches the first page and the orgs on a
 * first load (`lib/query/routes.ts`); each filter is its own cache entry.
 */
export default async function AdminConnectorsPage({
  searchParams,
}: {
  searchParams: Promise<{
    orgId?: string | string[];
    status?: string | string[];
    q?: string | string[];
  }>;
}) {
  const q = await searchParams;
  return (
    <AdminConnectorsView
      filter={{
        orgId: one(q.orgId),
        status: connectorStatusOf(one(q.status)),
        q: one(q.q).trim(),
      }}
    />
  );
}
