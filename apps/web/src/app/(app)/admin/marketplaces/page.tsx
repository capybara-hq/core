import { NoAccess } from "../../../../components/RoleGate";
import { listMarketplaces } from "../../../../lib/catalog";
import { read } from "../../../../lib/server/page";
import { admin } from "../../../../lib/server/session";
import Sources from "./view";

/** `/admin/marketplaces` (enterprise admins): the marketplaces and the offline flag, read on the server. */
export default async function MarketplacesPage() {
  const gate = await admin();
  if (gate.kind === "noAccess") return <NoAccess need={gate.need} />;
  return <Sources initial={await read(listMarketplaces())} />;
}
