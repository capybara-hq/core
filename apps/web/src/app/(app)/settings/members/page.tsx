import { NoAccess } from "../../../../components/NoAccess";
import { listInvitations, listMembers, roleAtLeast } from "../../../../lib/members";
import { read, section } from "../../../../lib/server/page";
import { workspace } from "../../../../lib/server/session";
import Members from "./view";

/**
 * `/settings/members` (members and up; a setup step): the members (required) and, for admins, the
 * invitations (a section), read on the server.
 */
export default async function MembersPage() {
  const ws = await workspace({ min: "member", setup: "step" });
  if (ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  const manage = roleAtLeast(ws.role, "admin");
  const [{ members }, invitations] = await Promise.all([
    read(listMembers(ws.orgId)),
    manage ? section(listInvitations(ws.orgId)) : Promise.resolve(null),
  ]);
  return (
    <Members
      orgId={ws.orgId}
      initial={{ members, invitations: invitations?.invitations ?? null }}
    />
  );
}
