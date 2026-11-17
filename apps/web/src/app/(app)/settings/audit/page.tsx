import OrgAudit from "./view";

/**
 * `/settings/audit` (org admins): the org's audit log. It reads nothing: the layout prefetches the
 * newest page on a first load (`lib/query/routes.ts`).
 */
export default function OrgAuditPage() {
  return <OrgAudit />;
}
