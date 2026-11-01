import { NoAccess } from "../../../../components/RoleGate";
import { read } from "../../../../lib/server/page";
import { workspace } from "../../../../lib/server/session";
import { getSkill } from "../../../../lib/skills";
import SkillView from "./view";

/** `/skills/[id]`: an org skill (members up), read on the server; a missing one is not found. */
export default async function SkillPage({ params }: { params: Promise<{ id: string }> }) {
  const ws = await workspace({ min: "member" });
  if (ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  const { id } = await params;
  return <SkillView orgId={ws.orgId} initial={await read(getSkill(ws.orgId, id))} />;
}
