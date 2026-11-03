import Members from "./view";

/**
 * `/settings/members` (members and up; a setup step): the members and, for admins, the
 * invitations. It reads nothing: the layout prefetches them on a first load (`lib/query/routes.ts`).
 */
export default function MembersPage() {
  return <Members />;
}
