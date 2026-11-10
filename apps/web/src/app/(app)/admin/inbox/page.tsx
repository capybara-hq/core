import { isPlatformInboxType } from "../../../../lib/admin-inbox";
import AdminInboxView from "./view";

/**
 * `/admin/inbox` (super admins): what waits on the platform; `?type=<item type>` lists only that
 * type (an unknown type is ignored). It reads nothing: the layout prefetches the inbox on a first
 * load (`lib/query/routes.ts`).
 */
export default async function AdminInboxPage({
  searchParams,
}: {
  searchParams?: Promise<{ type?: string | string[] }>;
} = {}) {
  const raw = (await searchParams)?.type;
  const type = Array.isArray(raw) ? raw[0] : raw;
  return <AdminInboxView type={isPlatformInboxType(type) ? type : null} />;
}
