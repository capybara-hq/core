import { NoAccess } from "../../../../../components/NoAccess";
import { getExtensionConfig, listAdminExtensions } from "../../../../../lib/admin-extensions";
import { read, section } from "../../../../../lib/server/page";
import { admin } from "../../../../../lib/server/session";
import ExtensionDetail from "./view";

/**
 * `/admin/extensions/[name]` (enterprise admins): the extension list (required; the extension is
 * found in it) and the deployment config for the Config tab (a section: the tab draws its own
 * error), read on the server. The convergence polling continues in the browser.
 */
export default async function ExtensionDetailPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const gate = await admin();
  if (gate.kind === "noAccess") return <NoAccess need={gate.need} />;
  const name = decodeURIComponent((await params).name);
  const [list, config] = await Promise.all([
    read(listAdminExtensions()),
    section(getExtensionConfig(name)),
  ]);
  return <ExtensionDetail name={name} initial={{ list, config }} />;
}
