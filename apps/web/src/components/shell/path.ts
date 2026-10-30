"use client";

import { useContext } from "react";
import { SessionContext } from "./session";

/** One segment of the page head's path line (design `PageHeaderProps.path`). */
export type PathSegment = { label: string; href?: string };

/** Where a page lives: a workspace page (the org slug), the home page (`~`), or the admin console. */
export type PathScope = "org" | "home" | "admin";

/**
 * The path of a page head (spec §2.4): the scope first, then the page and the object. `rest` are the
 * segments after the scope, route words (`agents`) or object names; segments with an `href` link.
 * The scope links to its root (`/` for an org, `/admin` for the admin console); `~` does not.
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
        : { label: orgSlug ?? "~", href: "/" };
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
