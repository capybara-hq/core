import { defineExtension, orgAccess } from "@capybara-hq/plugin-sdk";
import { z } from "zod";

/** Every handler call, in order (single-replica tests in the same process). */
export const routeAccessCalls = (): string[] => {
  const g = globalThis as { __routeAccessCalls?: string[] };
  g.__routeAccessCalls ??= [];
  return g.__routeAccessCalls;
};

/**
 * Test plugin for extension route access: one route per access level. Every handler records
 * `METHOD path` in `routeAccessCalls()` and answers
 * `{ caller, auth, cookie }` (the caller the kernel resolved, and the `authorization` / `cookie`
 * headers the handler received). `baseUrl` is a required overridable field the platform leaves
 * empty, so an org needs its own copy before the extension is called for it.
 * - `GET /ping`, `POST /hook`: public;
 * - `GET /ui/page`: public, the embed contribution `page` (org page);
 * - `GET /ui/data`, `POST /ui/data`: embed;
 * - `GET /items`, `POST /items`: member (mounted at `/plugins/route-access/orgs/:orgId/items`);
 * - `GET /settings`: admin.
 */
export default defineExtension({
  name: "route-access",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  ui: [
    {
      id: "page",
      title: { zh: "页面", en: "Page" },
      slot: "org.page",
      kind: "embed",
      path: "/ui/page",
    },
  ],
  permissions: {
    http: [
      { method: "GET", path: "/ping", access: "public" },
      { method: "POST", path: "/hook", access: "public" },
      { method: "GET", path: "/ui/page", access: "public" },
      { method: "GET", path: "/ui/data", access: "embed" },
      { method: "POST", path: "/ui/data", access: "embed" },
      { method: "GET", path: "/items", access: "member" },
      { method: "POST", path: "/items", access: "member" },
      { method: "GET", path: "/settings", access: "admin" },
    ],
    ui: { embeds: ["page"] },
  },
  config: {
    deployment: z.object({ baseUrl: orgAccess(z.string(), "override") }),
  },
  setup(ctx) {
    const routes = [
      ["GET", "/ping"],
      ["POST", "/hook"],
      ["GET", "/ui/page"],
      ["GET", "/ui/data"],
      ["POST", "/ui/data"],
      ["GET", "/items"],
      ["POST", "/items"],
      ["GET", "/settings"],
    ] as const;
    for (const [method, path] of routes) {
      ctx.http.route(method, path, async (req, caller) => {
        routeAccessCalls().push(`${method} ${path}`);
        return Response.json({
          caller,
          auth: req.headers.get("authorization"),
          cookie: req.headers.get("cookie"),
        });
      });
    }
  },
});
