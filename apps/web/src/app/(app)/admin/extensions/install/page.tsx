import { NoAccess } from "../../../../../components/RoleGate";
import { listAdminExtensions } from "../../../../../lib/admin-extensions";
import { read } from "../../../../../lib/server/page";
import { admin } from "../../../../../lib/server/session";
import ExtensionInstall from "./view";

/**
 * `/admin/extensions/install` (enterprise admins): the installed extensions (to detect a name
 * clash or an upgrade) and the `?upgrade=<name>` target, from the query, read on the server.
 */
export default async function ExtensionInstallPage({
  searchParams,
}: {
  searchParams: Promise<{ upgrade?: string | string[] }>;
}) {
  const gate = await admin();
  if (gate.kind === "noAccess") return <NoAccess need={gate.need} />;
  const { upgrade } = await searchParams;
  const target = typeof upgrade === "string" && upgrade !== "" ? upgrade : null;
  return <ExtensionInstall target={target} initial={await read(listAdminExtensions())} />;
}
