import { parseExtensionTab } from "../../../../lib/extension-capabilities";
import AdminExtensions from "./view";

/**
 * `/admin/extensions` (super admins): every extension on the deployment, by capability
 * (`?tab=<id>`, default 全部). It reads nothing: the layout prefetches the list on a first load
 * (`lib/query/routes.ts`).
 */
export default async function AdminExtensionsPage({
  searchParams,
}: {
  searchParams?: Promise<{ tab?: string | string[] }>;
} = {}) {
  const raw = (await searchParams)?.tab;
  return <AdminExtensions tab={parseExtensionTab(Array.isArray(raw) ? raw[0] : raw)} />;
}
