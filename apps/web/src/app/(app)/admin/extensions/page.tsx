import { NoAccess } from "../../../../components/NoAccess";
import { listAdminExtensions } from "../../../../lib/admin-extensions";
import { read } from "../../../../lib/server/page";
import { admin } from "../../../../lib/server/session";
import AdminPlugins from "./view";

/** `/admin/extensions` (enterprise admins): every extension on the deployment, read on the server. */
export default async function AdminExtensionsPage() {
  const gate = await admin();
  if (gate.kind === "noAccess") return <NoAccess need={gate.need} />;
  return <AdminPlugins initial={await read(listAdminExtensions())} />;
}
