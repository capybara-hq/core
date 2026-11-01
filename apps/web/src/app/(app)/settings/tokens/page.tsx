import { NoAccess } from "../../../../components/RoleGate";
import { listServiceTokens } from "../../../../lib/orgs";
import { read } from "../../../../lib/server/page";
import { workspace } from "../../../../lib/server/session";
import Tokens from "./view";

/** `/settings/tokens` (org admins): the org's service tokens (required), read on the server. */
export default async function TokensPage() {
  const ws = await workspace({ min: "admin" });
  if (ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  const { tokens } = await read(listServiceTokens(ws.orgId));
  return <Tokens orgId={ws.orgId} actor={ws.role} initial={tokens} />;
}
