"use client";

import { useContext } from "react";
import { usePathname } from "../../i18n/navigation";
import { HOME_PATH } from "../../lib/routes";
import { SessionContext } from "./session";

/** One segment of the page head's path line (design `PageHeaderProps.path`). */
export type PathSegment = { label: string; href?: string };

/**
 * Where a page lives: a workspace page (the org slug), a personal page (`~`), or the admin
 * console.
 */
export type PathScope = "org" | "home" | "admin";

/**
 * The path of a page head (spec §2.4): the scope first, then the page and the object. `rest` are the
 * segments after the scope, route words (`agents`) or object names; segments with an `href` link.
 * The scope links to its root (home, the new conversation, for an org; `/admin` for the admin
 * console); `~` does not.
 */
export function buildPagePath(
  scope: PathScope,
  orgSlug: string | undefined,
  rest: PathSegment[],
): PathSegment[] {
  const first: PathSegment =
    scope === "home"
      ? { label: "~" }
      : scope === "admin"
        ? { label: "/admin", href: "/admin" }
        : { label: orgSlug ?? "~", href: HOME_PATH };
  return [first, ...rest];
}

/**
 * {@link buildPagePath} for the signed-in account: the current org's slug from the session. Safe
 * outside a session (gates, error pages): the org scope then reads `~`.
 */
export function usePagePath(scope: PathScope, ...rest: PathSegment[]): PathSegment[] {
  const me = useContext(SessionContext)?.me;
  const slug = me?.memberships.find((m) => m.orgId === me.currentOrgId)?.slug;
  return buildPagePath(scope, slug, rest);
}

/** A UUID segment: shown by its first 8 characters. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Every page of the signed-in app (`src/app/(app)/**\/page.tsx`, the catch-all aside; a test keeps
 * the list in step with the files): `[name]` matches one segment. A path segment links only when
 * the path up to it is one of these, so `/settings`, `/account`, `/evals/runs` or `/p/<plugin>`,
 * which have no page, read as plain text.
 */
export const APP_PAGES: readonly string[] = [
  "/",
  "/account/connections",
  "/account/grants",
  "/account/identities",
  "/account/preferences",
  "/admin",
  "/admin/accounts",
  "/admin/agents",
  "/admin/agents/[id]",
  "/admin/agents/templates",
  "/admin/agents/templates/[id]",
  "/admin/audit",
  "/admin/connectors",
  "/admin/connectors/[id]",
  "/admin/connectors/templates",
  "/admin/connectors/templates/[id]",
  "/admin/extensions",
  "/admin/extensions/[name]",
  "/admin/inbox",
  "/admin/models",
  "/admin/orgs",
  "/admin/p/[plugin]/[id]",
  "/admin/plugins",
  "/admin/plugins/[itemId]",
  "/admin/plugins/import",
  "/admin/plugins/market",
  "/admin/plugins/pending",
  "/admin/plugins/sources",
  "/admin/settings",
  "/admin/skills",
  "/admin/skills/[id]",
  "/admin/themes",
  "/admin/themes/[id]",
  "/agents",
  "/agents/[id]",
  "/agents/new",
  "/agents/templates/[id]",
  "/channels",
  "/channels/[id]",
  "/channels/new",
  "/chat/[conversationId]",
  "/connectors",
  "/connectors/[connectorId]",
  "/connectors/install",
  "/devices",
  "/devices/[id]",
  "/evals",
  "/evals/[setId]",
  "/evals/[setId]/cases/[caseId]",
  "/evals/[setId]/run",
  "/evals/new",
  "/evals/runs/[runId]",
  "/extensions",
  "/inbox",
  "/p/[plugin]",
  "/p/[plugin]/[id]",
  "/plugins",
  "/plugins/[itemId]",
  "/plugins/[itemId]/connectors",
  "/plugins/[itemId]/enable",
  "/schedules",
  "/schedules/[id]",
  "/schedules/new",
  "/settings/appearance",
  "/settings/members",
  "/settings/models",
  "/settings/organization",
  "/settings/sandbox",
  "/settings/schedules",
  "/settings/tokens",
  "/skills",
  "/skills/[id]",
  "/trajectories",
  "/trajectories/[conversationId]",
];

/** {@link APP_PAGES} as a tree of segments, the way the router walks it. */
type PageNode = { page: boolean; named: Map<string, PageNode>; param?: PageNode };
const newNode = (): PageNode => ({ page: false, named: new Map() });
const PAGE_TREE: PageNode = newNode();
for (const p of APP_PAGES) {
  let node = PAGE_TREE;
  for (const seg of p.split("/").filter((s) => s !== "")) {
    if (seg.startsWith("[")) {
      node.param ??= newNode();
      node = node.param;
    } else {
      let next = node.named.get(seg);
      if (next === undefined) {
        next = newNode();
        node.named.set(seg, next);
      }
      node = next;
    }
  }
  node.page = true;
}

/**
 * Whether `parts` (a path's segments) name a page of {@link APP_PAGES}. As in the router, a named
 * folder wins over a `[param]` one: `/evals/runs` is the folder `runs` (no page), not a set.
 */
export function isAppPage(parts: readonly string[]): boolean {
  let node: PageNode | undefined = PAGE_TREE;
  for (const part of parts) {
    node = node.named.get(part) ?? node.param;
    if (node === undefined) return false;
  }
  return node.page;
}

/**
 * The segments after the scope of a page path (see {@link useRoutePath}): decoded, UUIDs as their
 * first 8 characters, and every segment but the last linked when the path up to it is a page.
 */
export function routeSegments(pathname: string): { admin: boolean; rest: PathSegment[] } {
  const parts = pathname.split("/").filter((p) => p !== "");
  const admin = parts[0] === "admin";
  const rest = (admin ? parts.slice(1) : parts).map((raw, i, all): PathSegment => {
    let label = raw;
    try {
      label = decodeURIComponent(raw);
    } catch {
      // a malformed escape stays as it came
    }
    if (UUID.test(label)) label = label.slice(0, 8);
    const upTo = [...(admin ? ["admin"] : []), ...all.slice(0, i + 1)];
    return i < all.length - 1 && isAppPage(upTo)
      ? { label, href: `/${upTo.join("/")}` }
      : { label };
  });
  return { admin, rest };
}

/**
 * The page path of the current route (spec §2.4), for pages that have no head of their own (the
 * error and not-found pages): `<slug> / trajectories / <id>` in the workspace, `/admin / accounts`
 * in the admin console. Every segment but the last links to its route when that route is a page;
 * UUIDs read as their first 8 characters, as the conversation's status bar shows them.
 */
export function useRoutePath(): PathSegment[] {
  const { admin, rest } = routeSegments(usePathname());
  return usePagePath(admin ? "admin" : "org", ...rest);
}
