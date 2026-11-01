import { NoAccess } from "../../../../components/NoAccess";
import { getAdminModels, listAdminPurposes } from "../../../../lib/models";
import { read } from "../../../../lib/server/page";
import { admin } from "../../../../lib/server/session";
import AdminModelsView from "./view";

/**
 * `/admin/models` (enterprise admins): the providers with their models and prices, and the
 * purposes' default mapping, read on the server.
 */
export default async function AdminModelsPage() {
  const gate = await admin();
  if (gate.kind === "noAccess") return <NoAccess need={gate.need} />;
  const [models, { purposes }] = await Promise.all([
    read(getAdminModels()),
    read(listAdminPurposes()),
  ]);
  return <AdminModelsView initial={{ ...models, purposes }} />;
}
