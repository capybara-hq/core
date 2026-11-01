import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { getReadiness, type OrgReadiness, setupReady } from "../agents";
import { ApiClientError } from "../api";
import { type ConversationGroupsPage, listConversationGroups } from "../conversations";
import { listInbox } from "../inbox";
import { myRole, type OrgRole, roleAtLeast } from "../members";
import { getMe, type Me, type Membership } from "../session";
import { listUiContributions, type UiContributionItem } from "../ui";
import { SESSION_STATE_HEADER } from "./kernel";
import { read } from "./page";

/** The signed-in account and its current org (`null` when none is chosen). Once per request. */
export const getSession = cache(async (): Promise<{ me: Me; org: Membership | null }> => {
  const me = await read(getMe());
  const org = me.memberships.find((m) => m.orgId === me.currentOrgId) ?? null;
  return { me, org };
});

/** The current org's readiness (one kernel call per request: the shell and the page share it). */
const orgReadiness = (orgId: string) => read(getReadiness(orgId));

/** What the `(app)` layout reads for the frame (spec web-ssr §3.1). */
export interface ShellData {
  me: Me;
  org: Membership | null;
  /** `null` only without a current org. */
  readiness: OrgReadiness | null;
  /** The sidebar's conversation groups (default view); `null` when the read failed or no org. */
  groups: ConversationGroupsPage | null;
  /** The inbox count; `null` when the read failed or no org. */
  pending: { count: number; more: boolean } | null;
  /** The extension pages (`place: "page"`); `null` when the read failed or no org. */
  extensions: UiContributionItem[] | null;
}

export type Shell = { kind: "unavailable" } | ({ kind: "ready" } & ShellData);

/** The kernel could not be reached (the proxy saw it down, or the read failed in transit). */
const unavailable = (e: unknown) =>
  e instanceof ApiClientError && (e.code === "upstream_unavailable" || e.code === "network");

/**
 * The shell data, read in parallel. A kernel that can't answer `me` gives `unavailable`; readiness
 * failing otherwise throws; the conversation groups, the pending count and the extension pages
 * resolve to `null` on failure (each section draws its own error state).
 */
export async function getShell(): Promise<Shell> {
  if ((await headers()).get(SESSION_STATE_HEADER) === "unavailable") return { kind: "unavailable" };
  let session: { me: Me; org: Membership | null };
  try {
    session = await getSession();
  } catch (e) {
    if (unavailable(e)) return { kind: "unavailable" };
    throw e;
  }
  const { me, org } = session;
  if (org === null) {
    return {
      kind: "ready",
      me,
      org,
      readiness: null,
      groups: null,
      pending: null,
      extensions: null,
    };
  }
  const orgId = org.orgId;
  const [readiness, groups, pending, extensions] = await Promise.all([
    orgReadiness(orgId),
    listConversationGroups(orgId).catch(() => null),
    listInbox(orgId).then(
      (r) => ({ count: r.items.length, more: r.truncated === true }),
      () => null,
    ),
    listUiContributions(orgId).then(
      ({ items }) => items.filter((c) => c.place === "page"),
      () => null,
    ),
  ]);
  return { kind: "ready", me, org, readiness, groups, pending, extensions };
}

export type Workspace =
  | { kind: "ok"; me: Me; orgId: string; role: OrgRole }
  | { kind: "noAccess"; need: "member" | "admin" }
  | { kind: "noOrg" };

/**
 * The gate every workspace page calls first (spec web-ssr §2.3). Without a current org it returns
 * `noOrg` (the frame draws the org chooser; the page renders nothing). While the org is not ready,
 * a page that is no setup route (no `setup`) redirects to `/`. Below `min` (default `guest`) it
 * returns `noAccess`, and the page renders `<NoAccess need={…} />` without reading anything else.
 */
export async function workspace(
  opts: { min?: "guest" | "member" | "admin"; setup?: "home" | "step" } = {},
): Promise<Workspace> {
  const { me, org } = await getSession();
  if (org === null) return { kind: "noOrg" };
  const readiness = await orgReadiness(org.orgId);
  if (!setupReady(readiness) && opts.setup === undefined) redirect("/");
  const role = myRole(me);
  const min = opts.min ?? "guest";
  if (role === undefined || !roleAtLeast(role, min)) {
    return { kind: "noAccess", need: min === "admin" ? "admin" : "member" };
  }
  return { kind: "ok", me, orgId: org.orgId, role };
}

/** The admin console's gate: enterprise admins only. */
export async function admin(): Promise<
  { kind: "ok"; me: Me } | { kind: "noAccess"; need: "enterprise" }
> {
  const { me } = await getSession();
  return me.account.isEnterpriseAdmin
    ? { kind: "ok", me }
    : { kind: "noAccess", need: "enterprise" };
}
