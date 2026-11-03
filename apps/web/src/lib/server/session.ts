import "server-only";
// Registers the server transport (idempotent), whatever module a page loads first.
import "./register";
import type { FetchQueryOptions, QueryClient, UseQueryOptions } from "@tanstack/react-query";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { getReadiness, type OrgReadiness, setupReady } from "../agents";
import type { ApiClientError } from "../api";
import { loginPathFor } from "../auth-sources";
import type { ConversationGroupsPage } from "../conversations";
import { myRole, type OrgRole, roleAtLeast } from "../members";
import {
  conversationGroupsQuery,
  extensionPagesQuery,
  inboxCountQuery,
  meQuery,
  readinessQuery,
} from "../query/shell";
import { getMe, type Me, type Membership } from "../session";
import type { UiContributionItem } from "../ui";
import { SESSION_STATE_HEADER } from "./kernel";
import { currentPath, isKernelUnavailable, isSignedOut, read } from "./page";
import { serverQueryClient } from "./query";

/** The signed-in account and its current org (`null` when none is chosen). Once per request. */
export const getSession = cache(async (): Promise<{ me: Me; org: Membership | null }> => {
  const me = await read(getMe());
  const org = me.memberships.find((m) => m.orgId === me.currentOrgId) ?? null;
  return { me, org };
});

/** The current org's readiness (one kernel call per request: the shell and the page share it). */
export const orgReadiness = (orgId: string) => read(getReadiness(orgId));

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

/**
 * A shell section's read: a failure resolves to `null` (the section draws its own error state; the
 * failed query stays in the cache and is dehydrated with its code), except a 401 `auth.*` (sign in
 * again) and an unavailable kernel (rethrown: the whole shell is `unavailable`).
 */
async function section<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (e) {
    if (isSignedOut(e)) redirect(loginPathFor(await currentPath()));
    if (isKernelUnavailable(e)) throw e;
    return null;
  }
}

/** A shell read through the request's query client (not retried: the first paint waits on it). */
const fetchShell = <T>(qc: QueryClient, o: UseQueryOptions<T, ApiClientError>): Promise<T> =>
  qc.fetchQuery({ ...(o as FetchQueryOptions<T, ApiClientError>), retry: false });

/**
 * The shell data, read in parallel through `qc` (so it is dehydrated for the browser's cache). A
 * kernel that can't answer (any of the reads) gives `unavailable`; readiness failing otherwise
 * throws; the conversation groups, the pending count and the extension pages resolve to `null` on
 * other failures (each section draws its own error state).
 *
 * `alongside` (the route's prefetch) starts with the shell reads once `/me` has answered, in the
 * same parallel wave; its failure fails the shell.
 */
export async function getShell(
  qc: QueryClient = serverQueryClient(),
  alongside?: (session: { me: Me; orgId: string | null }) => Promise<void>,
): Promise<Shell> {
  if ((await headers()).get(SESSION_STATE_HEADER) === "unavailable") return { kind: "unavailable" };
  let me: Me;
  try {
    me = await read(fetchShell(qc, meQuery()));
  } catch (e) {
    if (isKernelUnavailable(e)) return { kind: "unavailable" };
    throw e;
  }
  const org = me.memberships.find((m) => m.orgId === me.currentOrgId) ?? null;
  const orgId = org?.orgId ?? null;
  const route = alongside?.({ me, orgId });
  if (orgId === null) {
    await route;
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
  try {
    const [readiness, groups, pending, extensions] = await Promise.all([
      read(fetchShell(qc, readinessQuery(orgId))),
      section(fetchShell(qc, conversationGroupsQuery(orgId))),
      section(fetchShell(qc, inboxCountQuery(orgId))),
      section(fetchShell(qc, extensionPagesQuery(orgId))),
      route,
    ]);
    return { kind: "ready", me, org, readiness, groups, pending, extensions };
  } catch (e) {
    if (isKernelUnavailable(e)) return { kind: "unavailable" };
    throw e;
  }
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
