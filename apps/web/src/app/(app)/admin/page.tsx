import { NoAccess } from "../../../components/RoleGate";
import { getAdminOverview } from "../../../lib/admin";
import { read } from "../../../lib/server/page";
import { admin } from "../../../lib/server/session";
import AdminOverview from "./view";

/** `/admin` (enterprise admins): the four overview numbers, read on the server. */
export default async function AdminOverviewPage() {
  const gate = await admin();
  if (gate.kind === "noAccess") return <NoAccess need={gate.need} />;
  return <AdminOverview initial={await read(getAdminOverview())} />;
}
