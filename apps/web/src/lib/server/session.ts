import "server-only";
// Registers the server transport (idempotent), whatever module a page loads first.
import "./register";
import type { FetchQueryOptions, QueryClient, UseQueryOptions } from "@tanstack/react-query";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import type { OrgReadiness } from "../agents";
import { ApiClientError } from "../api";
import { loginPathFor } from "../auth-sources";
import type { ConversationGroupsPage } from "../conversations";
import type { OrgRole } from "../members";
import {
  conversationGroupsQuery,
  extensionPagesQuery,
  inboxCountQuery,
  meQuery,
  readinessQuery,
} from "../query/shell";
import { orgThemesQuery, platformThemeQuery } from "../query/themes";
import { CHANGE_PASSWORD_PATH, type Me, type Membership } from "../session";
import type { ThemeRef } from "../themes";
import type { UiContributionItem } from "../ui";
import { SESSION_STATE_HEADER } from "./kernel";
import { currentPath, isKernelUnavailable, isSignedOut } from "./page";
import { serverQueryClient } from "./query";

/** A shell read: a 401 `auth.*` redirects to sign-in (back to this page), a 404 is not-found. */
async function read<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (isSignedOut(e)) redirect(loginPathFor(await currentPath()));
    if (e instanceof ApiClientError && e.status === 404) notFound();
    throw e;
  }
}

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
  /** The extension pages (slot `org.page`); `null` when the read failed or no org. */
  extensions: UiContributionItem[] | null;
  /**
   * The viewer's resolved theme (themes spec §8): the org's themes read, or the platform default
   * without a current org; `null` for the built-in theme or when the read failed.
   */
  theme: ThemeRef | null;
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
 * throws; the conversation groups, the pending count, the extension pages and the theme resolve to
 * `null` on other failures (each section draws its own error state; the theme falls back to the
 * built-in one).
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
  // signed in with a generated initial password: the kernel answers nothing else until it changes
  if (me.account.mustChangePassword === true) redirect(CHANGE_PASSWORD_PATH);
  const org = me.memberships.find((m) => m.orgId === me.currentOrgId) ?? null;
  const orgId = org?.orgId ?? null;
  const route = alongside?.({ me, orgId });
  if (orgId === null) {
    try {
      const [theme] = await Promise.all([section(fetchShell(qc, platformThemeQuery())), route]);
      return {
        kind: "ready",
        me,
        org,
        readiness: null,
        groups: null,
        pending: null,
        extensions: null,
        theme,
      };
    } catch (e) {
      if (isKernelUnavailable(e)) return { kind: "unavailable" };
      throw e;
    }
  }
  try {
    const [readiness, groups, pending, extensions, themes] = await Promise.all([
      read(fetchShell(qc, readinessQuery(orgId))),
      section(fetchShell(qc, conversationGroupsQuery(orgId))),
      section(fetchShell(qc, inboxCountQuery(orgId))),
      section(fetchShell(qc, extensionPagesQuery(orgId))),
      section(fetchShell(qc, orgThemesQuery(orgId))),
      route,
    ]);
    const theme = themes?.resolved ?? null;
    return { kind: "ready", me, org, readiness, groups, pending, extensions, theme };
  } catch (e) {
    if (isKernelUnavailable(e)) return { kind: "unavailable" };
    throw e;
  }
}

export type Workspace =
  | { kind: "ok"; me: Me; orgId: string; role: OrgRole }
  | { kind: "noAccess"; need: "member" | "admin" }
  | { kind: "noOrg" };
