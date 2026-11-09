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
const THEMES = { themes: [], resolved: null, org: { id: null, personal: "allowed" } };
const NO_CLIENT = { enabled: true, apiVersion: 1, items: [] };
function shellRoutes(readiness: typeof READY, extra: Parameters<typeof serverRoutes>[0] = {}) {
  return serverRoutes({
    "GET /api/v1/me": () => json(200, ME),
    [`GET ${O}/readiness`]: () => json(200, readiness),
    [`GET ${O}/themes`]: () => json(200, THEMES),
    [`GET ${O}/conversations/groups`]: () =>
      json(200, { groups: [], next: null, archivedCount: 0 }),
    [`GET ${O}/inbox`]: () => json(200, { items: [], truncated: false }),
    [`GET ${O}/ui/contributions`]: () => json(200, { items: [] }),
    [`GET ${O}/ui/client`]: () => json(200, NO_CLIENT),
    // what the setup step /agents/new prefetches (the agent form's reads)
    [`GET ${O}/models`]: () => json(200, { providers: [] }),
    [`GET ${O}/models/catalog`]: () => json(200, { providers: [] }),
    [`GET ${O}/extensions`]: () => json(200, { extensions: [] }),
    [`GET ${O}/connectors`]: () => json(200, { connectors: [] }),
    [`GET ${O}/skills`]: () => json(200, { skills: [] }),
    [`GET ${O}/agent-templates`]: () => json(200, { templates: [] }),
    [`GET ${O}/agents`]: () => json(200, { agents: [] }),
    [`GET ${O}/members`]: () => json(200, { members: [] }),
    [`GET ${O}/components`]: () => json(200, { components: [] }),
    [`GET ${O}/attachments/limits`]: () => json(200, { available: false }),
    // and the setup step /settings/models (the purposes)
    [`GET ${O}/model-purposes`]: () => json(200, { purposes: [] }),
    // and the admin console's /admin/extensions (the deployment's extensions)
    "GET /api/v1/admin/extensions": () => json(200, { extensions: [], drainSeconds: 30 }),
    ...extra,
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
    // `/` is the setup home; the old `/chat` is redirected to it by next.config before the layout
    for (const path of ["/", "/settings/models", "/agents/new", "/admin/extensions"]) {
      shellRoutes(NOT_READY);
      await expect(layoutAt(path), path).resolves.toBeTruthy();
    }
    shellRoutes(READY);
    await expect(layoutAt("/connectors")).resolves.toBeTruthy();
  });
});

describe("the (app) layout's initial password gate", () => {
  it("an account that must change its generated password goes to /change-password, reading nothing else", async () => {
    const calls = serverRoutes({
      "GET /api/v1/me": () =>
        json(200, { ...ME, account: { ...ME.account, mustChangePassword: true } }),
    });
    await expect(layoutAt("/agents")).rejects.toThrow("REDIRECT /change-password");
    expect(calls.map((c) => c.url)).toEqual(["/api/v1/me"]);
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
      [`GET ${O}/themes`]: g.later(200, THEMES),
      [`GET ${O}/conversations/groups`]: g.later(200, { groups: [], next: null, archivedCount: 0 }),
      [`GET ${O}/inbox`]: g.later(200, { items: [{}], truncated: false }),
      [`GET ${O}/ui/contributions`]: g.later(200, { items: [] }),
      [`GET ${O}/ui/client`]: g.later(200, NO_CLIENT),
      [`GET ${O}/agents`]: g.later(200, { agents: [] }),
    });
    const done = layoutAt("/agents");
    // everything after `/me` starts before any of it answers
    await vi.waitFor(() => expect(calls).toHaveLength(8));
    expect(pathOf(calls[0] as Call)).toBe("/api/v1/me");
    expect(calls.slice(1).map(pathOf).sort()).toEqual(
      [
        `${O}/readiness`,
        `${O}/themes`,
        `${O}/conversations/groups`,
        `${O}/inbox`,
        `${O}/ui/contributions`,
        `${O}/ui/client`,
        `${O}/agents`,
      ].sort(),
    );
    g.open();
    const state = stateOf(await done);
    expect(state.queries.map((q) => q.queryKey)).toEqual(
      expect.arrayContaining([
        ["account", "self", "me"],
        ["org", "o1", "readiness"],
        ["org", "o1", "themes"],
        ["org", "o1", "conversationGroups", "default"],
        ["org", "o1", "inboxCount"],
        ["org", "o1", "extensionPages"],
        ["org", "o1", "clientExtensions"],
        ["org", "o1", "agents"],
      ]),
    );
    expect(calls).toHaveLength(8);
  });

  it("a signed-out read during prefetch redirects to login with the path", async () => {
    serverRoutes({
      "GET /api/v1/me": () => json(200, ME),
      [`GET ${O}/readiness`]: () => json(200, READY),
      [`GET ${O}/themes`]: () => json(200, THEMES),
      [`GET ${O}/conversations/groups`]: () =>
        json(200, { groups: [], next: null, archivedCount: 0 }),
      [`GET ${O}/inbox`]: () => json(200, { items: [], truncated: false }),
      [`GET ${O}/ui/contributions`]: () => json(200, { items: [] }),
      [`GET ${O}/ui/client`]: () => json(200, NO_CLIENT),
      [`GET ${O}/agents`]: () =>
        json(401, { error: { code: "auth.expired", message: "signed out" } }),
    });
    await expect(layoutAt("/agents")).rejects.toThrow("REDIRECT /login?returnTo=%2Fagents");
  });

  it("a failed shell section is dehydrated with its code; the page still renders", async () => {
    serverRoutes({
      "GET /api/v1/me": () => json(200, ME),
      [`GET ${O}/readiness`]: () => json(200, READY),
      [`GET ${O}/themes`]: () => json(200, THEMES),
      [`GET ${O}/conversations/groups`]: () =>
        json(500, { error: { code: "internal", message: "boom" } }),
      [`GET ${O}/inbox`]: () => json(200, { items: [], truncated: false }),
      [`GET ${O}/ui/contributions`]: () => json(200, { items: [] }),
      [`GET ${O}/ui/client`]: () => json(200, NO_CLIENT),
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
    profile: { avatar: null, description: "", quickActions: [], updatedAt: "2026-10-26T06:00:00Z" },
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

describe("the (app) layout's client code (client extensions spec §9.6, §10.1, §11)", () => {
  const BUILD = "d".repeat(64);
  const SET = {
    enabled: true,
    apiVersion: 1,
    items: [
      {
        plugin: "fake-client",
        build: BUILD,
        entry: { url: `/api/v1/client/fake-client/${BUILD}/client.mjs`, integrity: "sha384-e" },
        styles: [
          { url: `/api/v1/client/fake-client/${BUILD}/styles/a.css`, integrity: "sha384-s" },
        ],
        components: [{ id: "page", slot: "platform.page" }],
      },
    ],
  };
  type Found = { type: unknown; props: Record<string, unknown> };
  /** The first element of the tree whose component is named `name`. */
  const find = (node: unknown, name: string): Found | null => {
    if (Array.isArray(node)) {
      for (const n of node) {
        const f = find(n, name);
        if (f) return f;
      }
      return null;
    }
    if (typeof node !== "object" || node === null || !("props" in node)) return null;
    const el = node as Found;
    if ((el.type as { name?: string })?.name === name) return el;
    return find(el.props.children, name);
  };
  const shellRoutesWith = (extra: Parameters<typeof serverRoutes>[0]) => shellRoutes(READY, extra);

  it("a workspace page reads the org set and hands it to the head (with the nonce) and the host", async () => {
    const routes = shellRoutesWith({ [`GET ${O}/ui/client`]: () => json(200, SET) });
    req.headers = new Headers({ "x-cap-path": "/agents", "x-nonce": "n0nce" });
    const element = await AppLayout({ children: <p>page body</p> });
    expect(routes.map(pathOf)).toContain(`${O}/ui/client`);
    const head = find(element, "ClientExtensionsHead");
    expect(head?.props).toMatchObject({ set: SET, nonce: "n0nce", safe: false, scope: "org" });
    expect(find(element, "ClientHostRoot")?.props).toMatchObject({
      source: { kind: "org", orgId: "o1" },
      safe: false,
    });
  });

  it("safe mode renders no client code but still knows the set (the banner)", async () => {
    shellRoutesWith({ [`GET ${O}/ui/client`]: () => json(200, SET) });
    req.headers = new Headers({ "x-cap-path": "/agents?safe-ui=1", "x-nonce": "n" });
    const element = await AppLayout({ children: <p>page body</p> });
    const head = find(element, "ClientExtensionsHead");
    expect(head?.props).toMatchObject({ safe: true });
    const { renderToString } = await import("react-dom/server");
    const { ClientExtensionsHead } = await import(
      "../src/components/client-ext/ClientExtensionsHead"
    );
    expect(
      renderToString(
        <ClientExtensionsHead {...(head?.props as Parameters<typeof ClientExtensionsHead>[0])} />,
      ),
    ).toBe("");
    expect(find(element, "ClientHostRoot")?.props).toMatchObject({ safe: true });
  });

  it("the admin console reads no client set; a platform page reads only its plugin's", async () => {
    const admin = shellRoutesWith({
      "GET /api/v1/admin/ui/client": () => json(200, SET),
      "GET /api/v1/admin/ui/contributions": () => json(200, { items: [] }),
      "GET /api/v1/admin/ui/arrangement": () => json(200, { slots: [] }),
    });
    const consolePage = await layoutAt("/admin/extensions");
    expect(admin.map(pathOf)).not.toContain(`${O}/ui/client`);
    expect(admin.map(pathOf)).not.toContain("/api/v1/admin/ui/client");
    expect(find(consolePage, "ClientHostRoot")?.props).toMatchObject({ source: { kind: "none" } });
    const page = shellRoutesWith({
      "GET /api/v1/admin/ui/client": () => json(200, SET),
      "GET /api/v1/admin/ui/contributions": () => json(200, { items: [] }),
      "GET /api/v1/admin/ui/arrangement": () => json(200, { slots: [] }),
    });
    const element = await layoutAt("/admin/p/fake-client/page");
    expect(page.map((c) => c.url)).toContain("/api/v1/admin/ui/client?plugin=fake-client");
    expect(page.map(pathOf)).not.toContain(`${O}/ui/client`);
    expect(find(element, "ClientExtensionsHead")?.props).toMatchObject({ scope: "admin" });
    expect(find(element, "ClientHostRoot")?.props).toMatchObject({
      source: { kind: "admin", plugin: "fake-client" },
    });
  });
});
