// web-SSR spec §2.3/§4: while the current org is not ready, a route that is no setup route is
// redirected to `/` by the `(app)` layout on the server, before anything is streamed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { json } from "./support/api";
import { ME } from "./support/render";
import { serverRoutes } from "./support/server";
import { NOT_READY, READY } from "./support/shell";

const req = vi.hoisted(() => ({ headers: new Headers() }));
vi.mock("next/headers", () => ({ headers: async () => req.headers }));
vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ refresh: () => {}, replace: () => {}, push: () => {} }),
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

const { default: AppLayout } = await import("../src/app/(app)/layout");

const O = "/api/v1/orgs/o1";
function shellRoutes(readiness: typeof READY) {
  return serverRoutes({
    "GET /api/v1/me": () => json(200, ME),
    [`GET ${O}/readiness`]: () => json(200, readiness),
    [`GET ${O}/conversations/groups`]: () =>
      json(200, { groups: [], next: null, archivedCount: 0 }),
    [`GET ${O}/inbox`]: () => json(200, { items: [], truncated: false }),
    [`GET ${O}/ui/contributions`]: () => json(200, { items: [] }),
  });
}
const layoutAt = (path: string) => {
  req.headers = new Headers({ "x-cap-path": path });
  return AppLayout({ children: <p>page body</p> });
};

beforeEach(() => {
  req.headers = new Headers();
});
afterEach(() => vi.unstubAllGlobals());

describe("the (app) layout's setup redirect", () => {
  it("a route that is no setup route goes to / while the org is not ready", async () => {
    shellRoutes(NOT_READY);
    await expect(layoutAt("/connectors?tab=mine")).rejects.toThrow("REDIRECT /");
  });

  it("setup routes (home, steps) and the admin console render; a ready org renders anything", async () => {
    for (const path of ["/", "/chat", "/settings/models", "/agents/new", "/admin/extensions"]) {
      shellRoutes(NOT_READY);
      await expect(layoutAt(path), path).resolves.toBeTruthy();
    }
    shellRoutes(READY);
    await expect(layoutAt("/connectors")).resolves.toBeTruthy();
  });
});
