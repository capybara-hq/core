// web-SSR spec §2.3/§4: while the current org is not ready, a route that is no setup route is
// redirected to `/` by the `(app)` layout on the server, before anything is streamed.

import type { DehydratedState } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RouteEntry } from "../src/lib/query/routes";
import { type Call, json } from "./support/api";
import { renderRouteEmptyCache, renderRouteWithCache } from "./support/query";
import { ME } from "./support/render";
import { expectNoFirstPaintFetch, serverRoutes } from "./support/server";
import { NOT_READY, READY } from "./support/shell";

const req = vi.hoisted(() => ({ headers: new Headers() }));
vi.mock("next-intl/server", () => ({ getLocale: async () => "en" }));
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

// `/agents` is not migrated yet: here it prefetches the agents list, as its entry will.
vi.mock("../src/lib/query/routes", async (original) => {
  const routes = await original<typeof import("../src/lib/query/routes")>();
  const { defineQuery } = await import("../src/lib/query/define");
  const { keys } = await import("../src/lib/query/keys");
  const { listAgents } = await import("../src/lib/agents");
  const agents: RouteEntry = {
    pattern: "/agents",
    queries: ({ orgId }) =>
      orgId === null
        ? []
        : [
            defineQuery<unknown>({
              key: [...keys.org(orgId).all, "agents"],
              fn: () => listAgents(orgId),
              freshness: "orgConfig",
            }),
          ],
  };
  const table = routes.ROUTES.map((r) => (r.pattern === "/agents" ? agents : r));
  return {
    ...routes,
    ROUTES: table,
    matchRoute: (path: string) => routes.matchRoute(path, table),
  };
});

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
    // what the setup step /agents/new prefetches (the agent form's reads)
    [`GET ${O}/models`]: () => json(200, { providers: [] }),
    [`GET ${O}/connectors`]: () => json(200, { connectors: [] }),
    [`GET ${O}/skills`]: () => json(200, { skills: [] }),
    [`GET ${O}/agent-templates`]: () => json(200, { templates: [] }),
    [`GET ${O}/agents`]: () => json(200, { agents: [] }),
    [`GET ${O}/members`]: () => json(200, { members: [] }),
    // and the setup step /settings/models (the purposes)
    [`GET ${O}/model-purposes`]: () => json(200, { purposes: [] }),
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

/** A response held until `open()`: the test sees which reads started before any answered. */
function gate() {
  let open = () => {};
  const opened = new Promise<void>((r) => {
    open = r;
  });
  const later = (status: number, body: unknown) => async () => {
    await opened;
    return json(status, body);
  };
  return { open, later };
}

/** The dehydrated cache the layout hands to the browser (its outermost element's `state`). */
const stateOf = (element: unknown) =>
  (element as ReactElement<{ state: DehydratedState }>).props.state;
const pathOf = (c: Call) => c.url.split("?")[0];

describe("the (app) layout's first-load prefetch", () => {
  it("the layout prefetches the shell and the route in one parallel wave", async () => {
    const g = gate();
    const calls = serverRoutes({
      "GET /api/v1/me": () => json(200, ME),
      [`GET ${O}/readiness`]: g.later(200, READY),
      [`GET ${O}/conversations/groups`]: g.later(200, { groups: [], next: null, archivedCount: 0 }),
      [`GET ${O}/inbox`]: g.later(200, { items: [{}], truncated: false }),
      [`GET ${O}/ui/contributions`]: g.later(200, { items: [] }),
      [`GET ${O}/agents`]: g.later(200, { agents: [] }),
    });
    const done = layoutAt("/agents");
    // everything after `/me` starts before any of it answers
    await vi.waitFor(() => expect(calls).toHaveLength(6));
    expect(pathOf(calls[0] as Call)).toBe("/api/v1/me");
    expect(calls.slice(1).map(pathOf).sort()).toEqual(
      [
        `${O}/readiness`,
        `${O}/conversations/groups`,
        `${O}/inbox`,
        `${O}/ui/contributions`,
        `${O}/agents`,
      ].sort(),
    );
    g.open();
    const state = stateOf(await done);
    expect(state.queries.map((q) => q.queryKey)).toEqual(
      expect.arrayContaining([
        ["account", "self", "me"],
        ["org", "o1", "readiness"],
        ["org", "o1", "conversationGroups", "default"],
        ["org", "o1", "inboxCount"],
        ["org", "o1", "extensionPages"],
        ["org", "o1", "agents"],
      ]),
    );
    expect(calls).toHaveLength(6);
  });

  it("a signed-out read during prefetch redirects to login with the path", async () => {
    serverRoutes({
      "GET /api/v1/me": () => json(200, ME),
      [`GET ${O}/readiness`]: () => json(200, READY),
      [`GET ${O}/conversations/groups`]: () =>
        json(200, { groups: [], next: null, archivedCount: 0 }),
      [`GET ${O}/inbox`]: () => json(200, { items: [], truncated: false }),
      [`GET ${O}/ui/contributions`]: () => json(200, { items: [] }),
      [`GET ${O}/agents`]: () =>
        json(401, { error: { code: "auth.expired", message: "signed out" } }),
    });
    await expect(layoutAt("/agents")).rejects.toThrow("REDIRECT /login?returnTo=%2Fagents");
  });

  it("a failed shell section is dehydrated with its code; the page still renders", async () => {
    serverRoutes({
      "GET /api/v1/me": () => json(200, ME),
      [`GET ${O}/readiness`]: () => json(200, READY),
      [`GET ${O}/conversations/groups`]: () =>
        json(500, { error: { code: "internal", message: "boom" } }),
      [`GET ${O}/inbox`]: () => json(200, { items: [], truncated: false }),
      [`GET ${O}/ui/contributions`]: () => json(200, { items: [] }),
      [`GET ${O}/agents`]: () => json(404, { error: { code: "x.not_found", message: "gone" } }),
    });
    const state = stateOf(await layoutAt("/agents"));
    const byKey = (k: string) => state.queries.find((q) => q.queryKey.includes(k))?.state;
    expect(byKey("conversationGroups")).toMatchObject({
      status: "error",
      error: { status: 500, code: "internal" },
    });
    // a missing object is the page's own state (HTTP 200), not the layout's 404
    expect(byKey("agents")).toMatchObject({
      status: "error",
      error: { status: 404, code: "x.not_found" },
    });
  });

  it("an unknown path renders through the layout: its catch-all page answers 404 in the shell", async () => {
    shellRoutes(READY);
    await expect(layoutAt("/nope")).resolves.toBeTruthy();
  });

  it("the kernel unavailable on a first load gives the starting frame", async () => {
    req.headers = new Headers({ "x-cap-path": "/agents", "x-cap-session": "unavailable" });
    const element = (await AppLayout({ children: <p>page body</p> })) as ReactElement;
    expect((element.type as { name?: string }).name).toBe("KernelStarting");
  });
});

describe("the route test helpers", () => {
  const agent = {
    id: "ag1",
    definition: { name: "Helper agent", model: { provider: "model-fake", model: "fake-1" } },
  };
  const agentsRoute = { [`GET ${O}/agents`]: () => json(200, { agents: [agent] }) };

  it("renderRouteWithCache prefetches the route on the server and hydrates the page's cache", async () => {
    req.headers = new Headers({ "x-cap-path": "/agents" });
    expectNoFirstPaintFetch();
    const { calls, client, findAllByText } = await renderRouteWithCache("/agents", agentsRoute);
    expect(calls.map(pathOf)).toContain(`${O}/agents`);
    expect(await findAllByText("Helper agent")).not.toHaveLength(0);
    expect(client.getQueryData(["org", "o1", "agents"])).toEqual({ agents: [agent] });
  });

  it("renderRouteEmptyCache starts from an empty browser cache: the view reads in the browser", async () => {
    req.headers = new Headers({ "x-cap-path": "/agents" });
    const { calls, client, findAllByText } = await renderRouteEmptyCache("/agents", agentsRoute);
    expect(await findAllByText("Helper agent")).not.toHaveLength(0);
    expect(calls.map(pathOf)).toContain(`${O}/agents`);
    expect(client.getQueryData(["org", "o1", "agents"])).toEqual({ agents: [agent] });
  });
});
