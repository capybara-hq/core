/**
 * Pure route rules of the setup frame, shared by the `(app)` layout on the server (the redirect)
 * and the frame in the browser (which frame to draw).
 */

/** `pathname` is `prefix` or below it. */
export const under = (pathname: string, prefix: string) =>
  pathname === prefix || pathname.startsWith(`${prefix}/`);

/**
 * Where a route stands while the org is not ready (web-order spec §3.8): `outside` keeps its own
 * frame (the admin console); `home` is the setup home (`/`, the workspace's home; the old
 * `/chat` redirects there); `step` renders inside the setup frame (the pages a step needs, personal
 * settings); anything else `redirect`s home.
 */
export function setupRouteOf(pathname: string): "outside" | "home" | "step" | "redirect" {
  if (under(pathname, "/admin")) return "outside";
  if (pathname === "/") return "home";
  if (
    pathname === "/settings/models" ||
    pathname === "/settings/members" ||
    pathname === "/channels/new" ||
    under(pathname, "/agents") ||
    under(pathname, "/plugins") ||
    under(pathname, "/account")
  ) {
    // `/agents` itself is the list (not a step); `/agents/new` and `/agents/<id>` are.
    return pathname === "/agents" ? "redirect" : "step";
  }
  return "redirect";
}
