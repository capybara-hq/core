import { NoAccess } from "../../../../components/RoleGate";
import { listAdminAccounts } from "../../../../lib/admin";
import { read } from "../../../../lib/server/page";
import { admin } from "../../../../lib/server/session";
import AdminAccounts from "./view";

/** `/admin/accounts` (enterprise admins): the first page of accounts, read on the server. */
export default async function AdminAccountsPage() {
  const gate = await admin();
  if (gate.kind === "noAccess") return <NoAccess need={gate.need} />;
  return <AdminAccounts initial={await read(listAdminAccounts())} />;
}
