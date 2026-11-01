import { NoAccess } from "../../../../components/NoAccess";
import { listModels } from "../../../../lib/agents";
import { listOrgPurposes } from "../../../../lib/models";
import { read } from "../../../../lib/server/page";
import { workspace } from "../../../../lib/server/session";
import OrgModels from "./view";

/**
 * `/settings/models` (org admins; a setup step): the org's model purposes and the models they can
 * map to (both required), read on the server.
 */
export default async function OrgModelsPage() {
  const ws = await workspace({ min: "admin", setup: "step" });
  if (ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  const [{ purposes }, { providers }] = await Promise.all([
    read(listOrgPurposes(ws.orgId)),
    read(listModels(ws.orgId)),
  ]);
  return <OrgModels orgId={ws.orgId} initial={{ purposes, providers }} />;
}
