import { NoAccess } from "../../../components/RoleGate";
import { read } from "../../../lib/server/page";
import { workspace } from "../../../lib/server/session";
import { listSkills } from "../../../lib/skills";
import SkillsView from "./view";

/** `/skills`: the org's skill library (members up), read on the server. */
export default async function SkillsPage() {
  const ws = await workspace({ min: "member" });
  if (ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  const { skills } = await read(listSkills(ws.orgId));
  return <SkillsView orgId={ws.orgId} initial={skills} />;
}
