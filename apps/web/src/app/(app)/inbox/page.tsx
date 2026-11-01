import { NoAccess } from "../../../components/RoleGate";
import { listInbox } from "../../../lib/inbox";
import { optional, read } from "../../../lib/server/page";
import { workspace } from "../../../lib/server/session";
import { getSkillChange } from "../../../lib/skills";
import InboxView from "./view";

/**
 * `/inbox`: the current org's pending items, read on the server, with the detail of the first one
 * (it is selected at once) when it is a skill change. Other items' details load when picked.
 */
export default async function InboxPage() {
  const ws = await workspace();
  if (ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  const { orgId } = ws;
  const inbox = await read(listInbox(orgId));
  const first = inbox.items[0];
  const firstChange =
    first?.type === "skill_change"
      ? {
          id: first.skillChange.id,
          detail:
            (await optional(getSkillChange(orgId, first.skillChange.id)))?.skillChange ?? null,
        }
      : null;
  return <InboxView orgId={orgId} initial={{ inbox, firstChange }} />;
}
