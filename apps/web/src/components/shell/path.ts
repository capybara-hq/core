"use client";

import { useContext } from "react";
import { usePathname } from "../../i18n/navigation";
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

/** A UUID segment: shown by its first 8 characters. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The page path of the current route (spec §2.4), for pages that have no head of their own (the
 * error and not-found pages): `<slug> / trajectories / <id>` in the workspace, `/admin / accounts`
 * in the admin console. Every segment but the last links to its route; UUIDs read as
 * their first 8 characters, as the conversation's status bar shows them.
 */
export function useRoutePath(): PathSegment[] {
  const pathname = usePathname();
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
    const href = `${admin ? "/admin" : ""}/${all.slice(0, i + 1).join("/")}`;
    return i < all.length - 1 ? { label, href } : { label };
  });
  return usePagePath(admin ? "admin" : "org", ...rest);
}
