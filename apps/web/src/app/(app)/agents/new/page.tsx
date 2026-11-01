import { NoAccess } from "../../../../components/RoleGate";
import { loadAgentForm } from "../../../../lib/server/agent-form";
import { workspace } from "../../../../lib/server/session";
import NewAgentView from "./view";

/**
 * `/agents/new`: a setup step (web-order spec §3.8) for members up; the form's models, connectors,
 * skills and sub-agent options are read on the server.
 */
export default async function NewAgentPage() {
  const ws = await workspace({ min: "member", setup: "step" });
  if (ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  return <NewAgentView orgId={ws.orgId} initial={await loadAgentForm(ws.orgId)} />;
}
