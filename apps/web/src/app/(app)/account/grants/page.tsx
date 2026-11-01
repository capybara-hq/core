import { listToolGrants } from "../../../../lib/approvals";
import { read } from "../../../../lib/server/page";
import { workspace } from "../../../../lib/server/session";
import Grants from "./view";

/** `/account/grants` (a setup step): this person's standing tool grants (required). */
export default async function GrantsPage() {
  const ws = await workspace({ setup: "step" });
  if (ws.kind !== "ok") return null;
  const { grants } = await read(listToolGrants(ws.orgId));
  return <Grants orgId={ws.orgId} initial={grants} />;
}
