// The organization and personal settings pages render on the server (web-SSR spec §6, task 9):
// first paint complete without a browser fetch, the gate cases, and the failure modes of R5.
import { act, cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import { json, noContent, stubApi } from "./support/api";
import { footControls, openCardMenu } from "./support/cards";
import { resetNavigation, router } from "./support/navigation";
import { renderRouteEmptyCache, renderRouteWithCache } from "./support/query";
import { ME } from "./support/render";
import { expectNoFirstPaintFetch, type Routes } from "./support/server";
import { NOT_READY } from "./support/shell";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

const O = "/api/v1/orgs/o1";
const T = "2026-10-19T12:00:00.000Z";
const failing = () => json(500, { error: { code: "internal", message: "x" } });

const MEMBERS = [
  {
    account: { id: "a1", displayName: "Grant", email: null },
    role: "owner",
    joinedAt: T,
    anonymous: false,
  },
  {
    account: { id: "a2", displayName: "Bob", email: "bob@corp.example" },
    role: "member",
    joinedAt: T,
    anonymous: false,
  },
];
const INVITATION = {
  id: "i1",
  orgId: "o1",
  role: "member",
  createdBy: "a1",
  createdAt: T,
  expiresAt: "2026-10-27T00:00:00.000Z",
  acceptedAt: null,
  revokedAt: null,
  status: "pending",
};
const personalApp = (id: string, name: string) => ({
  id,
  slug: id,
  name,
  connector: "mcp",
  endpoint: {},
  auth: { type: "oauth_code", ownership: "personal" },
  status: "active",
  createdAt: T,
  updatedAt: T,
  tools: [],
  credential: { ownership: "personal", status: "missing" },
});
const IDENTITY = {
  source: "fake-im:t1",
  externalId: "u-alice",
  email: "alice@corp.example",
  emailVerified: true,
  displayName: "Alice Wong",
  avatarUrl: null,
  linkedVia: "bind",
  createdAt: T,
};

/** The personal connection card named `name` on /account/connections, or null. */
const card = (name: string): HTMLElement | null => {
  const list = screen.queryByRole("list", { name: en.connections.nav.connections });
  if (list === null) return null;
  const li = within(list)
    .queryAllByRole("listitem")
    .find((x) => within(x).queryByText(name, { exact: true }) !== null);
  return (li as HTMLElement | undefined) ?? null;
};
const findCard = async (name: string) => {
  await vi.waitFor(() => {
    if (card(name) === null) throw new Error(`no card ${name}`);
  });
  return card(name) as HTMLElement;
};

const ROUTES: Routes = {
  [`GET ${O}/settings`]: () =>
    json(200, {
      settings: { toolSearch: "off", locale: "en", sandboxToolPolicy: "ask" },
      deployment: {
        autoMode: { mode: "allowed", source: "default" },
        cloudNetwork: { mode: "allowlist", allowHosts: [] },
      },
      sandboxLimits: { cpu: 2, memoryMb: 4096, source: "deployment" },
    }),
  [`GET ${O}/members`]: () => json(200, { members: MEMBERS }),
  [`GET ${O}/invitations`]: () => json(200, { invitations: [INVITATION] }),
  [`GET ${O}/model-purposes`]: () => json(200, { purposes: [] }),
  [`GET ${O}/models`]: () => json(200, { providers: [] }),
  [`GET ${O}/plugin-installs`]: () => json(200, { installs: [] }),
  [`GET ${O}/extensions`]: () => json(200, { extensions: [] }),
  [`GET ${O}/file-previewers`]: () => json(200, { items: [] }),
  [`GET ${O}/service-tokens`]: () => json(200, { tokens: [] }),
  [`GET ${O}/connectors`]: () =>
    json(200, {
      connectors: [
        personalApp("c1", "Docs"),
        personalApp("c2", "Wiki"),
        { ...personalApp("c3", "Shared"), auth: { type: "oauth_code", ownership: "shared" } },
      ],
    }),
  [`GET ${O}/connectors/c1`]: () => json(200, { connector: personalApp("c1", "Docs") }),
  [`GET ${O}/connectors/c2`]: () => json(200, { connector: personalApp("c2", "Wiki") }),
  [`GET ${O}/me/tool-grants`]: () => json(200, { grants: [] }),
  "GET /api/v1/me/identities": () => json(200, { identities: [IDENTITY] }),
  "GET /api/v1/auth/sources": () => json(200, { sources: [{ plugin: "fake-im" }] }),
};

/** Lets pending reads and effects run (a read after mount would show up in the calls). */
const settle = () => act(() => new Promise((r) => setTimeout(r, 20)));

/** A client navigation to `path` with an empty cache whose `held` read answers on `release()`. */
async function renderHeld(path: string, held: string, routes: Routes = ROUTES) {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const answer = routes[held];
  if (answer === undefined) throw new Error(`no route ${held}`);
  await renderRouteEmptyCache(path, {
    ...routes,
    [held]: async (c) => {
      await gate;
      return answer(c);
    },
  });
  return { release: () => act(async () => release()) };
}

const template = (name: string) => document.querySelector(`[data-template="${name}"]`);

beforeEach(() => resetNavigation("/settings/organization"));
afterEach(cleanup);

describe("first paint comes from the hydrated cache (no browser read)", () => {
  it("/account/connections: a first render from the hydrated cache makes no browser read (the layout's `then` read the details)", async () => {
    const browser = expectNoFirstPaintFetch();
    const { calls } = await renderRouteWithCache("/account/connections", ROUTES);
    expect(card("Docs")).not.toBeNull();
    expect(card("Wiki")).not.toBeNull();
    expect(screen.queryByText("Shared")).toBeNull();
    expect(calls.map((c) => c.url)).not.toContain(`${O}/connectors/c3`);
    await settle();
    expect(browser).toEqual([]);
  });

  it("the path's `account` leads to the first personal settings page (preferences)", async () => {
    await renderRouteWithCache("/account/connections", ROUTES);
    const link = await screen.findByRole("link", { name: "account" });
    expect(link.getAttribute("href")).toBe("/account/preferences");
  });

  it("/account/connections: a connector the kernel no longer shows is left out", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRouteWithCache("/account/connections", {
      ...ROUTES,
      [`GET ${O}/connectors/c2`]: () => json(404, { error: { code: "connector.not_found" } }),
    });
    expect(card("Docs")).not.toBeNull();
    expect(card("Wiki")).toBeNull();
    await settle();
    expect(browser).toEqual([]);
  });

  it("/account/connections: no personal connector is the page empty state, not a loose sentence (spec §6.18)", async () => {
    await renderRouteWithCache("/account/connections", {
      ...ROUTES,
      [`GET ${O}/connectors`]: () => json(200, { connectors: [] }),
    });
    const state = screen.getByText(en.connections.empty).closest('[data-part="empty-state"]');
    expect(state?.getAttribute("data-size")).toBe("page");
    expect(state?.textContent).toContain(en.connections.emptyHint);
    expect(state?.querySelector('[data-part="empty-illustration"]')).not.toBeNull();
  });

  it("/account/connections: a detail that fails otherwise (500) is the error state; retry reads it again", async () => {
    let failing500 = true;
    const routes: Routes = {
      ...ROUTES,
      [`GET ${O}/connectors/c2`]: () =>
        failing500
          ? json(500, { error: { code: "internal", message: "x" } })
          : json(200, { connector: personalApp("c2", "Wiki") }),
    };
    const calls = stubApi(routes);
    await renderRouteWithCache("/account/connections", routes);
    expect(template("StatusPage")?.getAttribute("data-kind")).toBe("maintenance");
    expect(card("Docs")).toBeNull();
    await settle();
    // the hydrated error is not read again on mount
    expect(calls).toEqual([]);
    failing500 = false;
    await userEvent.setup().click(screen.getByRole("button", { name: en.errors.page.retry }));
    expect(await findCard("Wiki")).toBeTruthy();
    expect(card("Docs")).not.toBeNull();
    expect(calls.map((c) => `${c.method} ${c.url}`)).toContain(`GET ${O}/connectors/c2`);
  });

  it.each([
    ["/account/grants", `GET ${O}/me/tool-grants`, en.connections.grants.empty],
    ["/account/identities", "GET /api/v1/me/identities", "Alice Wong"],
  ])("%s: a 404 of the list is the error state; retry reads it again", async (path, read, text) => {
    let missing = true;
    const answer = ROUTES[read] as NonNullable<Routes[string]>;
    const routes: Routes = {
      ...ROUTES,
      [read]: (c) =>
        missing ? json(404, { error: { code: "not_found", message: "x" } }) : answer(c),
    };
    const calls = stubApi(routes);
    await renderRouteWithCache(path, routes);
    expect(template("StatusPage")?.getAttribute("data-kind")).toBe("maintenance");
    expect(document.querySelector("[aria-busy='true']")).toBeNull();
    missing = false;
    await userEvent.setup().click(screen.getByRole("button", { name: en.errors.page.retry }));
    expect(await screen.findByText(text)).toBeTruthy();
    expect(calls.map((c) => `${c.method} ${c.url}`)).toContain(read);
  });

  it("/account/connections: an empty cache shows the template's loading state, then the data", async () => {
    const { release } = await renderHeld("/account/connections", `GET ${O}/connectors/c2`);
    await vi.waitFor(() => {
      if (template("SettingsPage") === null) throw new Error("no page");
    });
    // the list answered: one skeleton card per personal connector until every detail answered
    await vi.waitFor(() =>
      expect(document.querySelectorAll("[aria-busy='true'] [data-part='object-card']").length).toBe(
        2,
      ),
    );
    expect(card("Docs")).toBeNull();
    await release();
    expect(await findCard("Wiki")).toBeTruthy();
    expect(card("Docs")).not.toBeNull();
    await vi.waitFor(() => expect(document.querySelector("[aria-busy='true']")).toBeNull());
  });

  it("/account/grants: a first render from the hydrated cache makes no browser read", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRouteWithCache("/account/grants", ROUTES);
    expect(screen.getByText(en.connections.grants.empty)).toBeTruthy();
    await settle();
    expect(browser).toEqual([]);
  });

  it("/account/grants: an empty cache shows the template's loading state, then the data", async () => {
    const { release } = await renderHeld("/account/grants", `GET ${O}/me/tool-grants`);
    await vi.waitFor(() => {
      if (template("SettingsPage") === null) throw new Error("no page");
    });
    expect(document.querySelector("[aria-busy='true']")).not.toBeNull();
    expect(screen.queryByText(en.connections.grants.empty)).toBeNull();
    await release();
    expect(await screen.findByText(en.connections.grants.empty)).toBeTruthy();
    await vi.waitFor(() => expect(document.querySelector("[aria-busy='true']")).toBeNull());
  });

  it("/account/identities: a first render from the hydrated cache makes no browser read; no org needed; 验证 only for login plugins read", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRouteWithCache("/account/identities", ROUTES, {
      me: { ...ME, currentOrgId: null },
    });
    expect(screen.getByText("Alice Wong")).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: "Row actions" }));
    expect(screen.getByRole("menuitem", { name: en.identities.verify })).toBeTruthy();
    await settle();
    expect(browser).toEqual([]);
    cleanup();
    await renderRouteWithCache("/account/identities", {
      ...ROUTES,
      "GET /api/v1/auth/sources": failing,
    });
    await userEvent.setup().click(screen.getByRole("button", { name: "Row actions" }));
    expect(screen.queryByRole("menuitem", { name: en.identities.verify })).toBeNull();
    expect(screen.getByRole("menuitem", { name: en.identities.unlink })).toBeTruthy();
    await settle();
    // a section that failed on the first load is not read again on mount
    expect(browser).toEqual([]);
  });

  it("/account/identities: an empty cache shows the template's loading state, then the data", async () => {
    const { release } = await renderHeld("/account/identities", "GET /api/v1/me/identities");
    await vi.waitFor(() => {
      if (template("SettingsPage") === null) throw new Error("no page");
    });
    expect(document.querySelector("[aria-busy='true']")).not.toBeNull();
    expect(screen.queryByText("Alice Wong")).toBeNull();
    await release();
    expect(await screen.findByText("Alice Wong")).toBeTruthy();
    await vi.waitFor(() => expect(document.querySelector("[aria-busy='true']")).toBeNull());
  });
});

describe("the gates", () => {
  it("/account/connections: no org renders nothing; it is a setup step", async () => {
    const none = await renderRouteWithCache("/account/connections", ROUTES, {
      me: { ...ME, currentOrgId: null },
    });
    expect(none.calls.map((c) => c.url)).toEqual(["/api/v1/me"]);
    cleanup();
    await renderRouteWithCache("/account/connections", ROUTES, { readiness: NOT_READY });
    expect(template("StatusPage")).toBeNull();
    expect(document.querySelector("h1")).not.toBeNull();
    await settle();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("/account/grants: no org renders nothing; it is a setup step", async () => {
    const none = await renderRouteWithCache("/account/grants", ROUTES, {
      me: { ...ME, currentOrgId: null },
    });
    expect(none.calls.map((c) => c.url)).toEqual(["/api/v1/me"]);
    cleanup();
    await renderRouteWithCache("/account/grants", ROUTES, { readiness: NOT_READY });
    expect(template("StatusPage")).toBeNull();
    expect(document.querySelector("h1")).not.toBeNull();
    await settle();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("/account/identities is no workspace page: it renders while the org is not ready", async () => {
    await renderRouteWithCache("/account/identities", ROUTES, { readiness: NOT_READY });
    expect(screen.getByText("Alice Wong")).toBeTruthy();
    await settle();
    expect(router.replace).not.toHaveBeenCalled();
  });
});

describe("mutations invalidate the cache", () => {
  it("disconnecting invalidates that connector: its detail is read again", async () => {
    let status = "connected";
    const routes: Routes = {
      ...ROUTES,
      [`GET ${O}/connectors/c1`]: () =>
        json(200, {
          connector: {
            ...personalApp("c1", "Docs"),
            credential: { ownership: "personal", status },
          },
        }),
      [`DELETE ${O}/connectors/c1/credentials/me`]: () => {
        status = "missing";
        return noContent();
      },
    };
    const calls = stubApi(routes);
    await renderRouteWithCache("/account/connections", routes);
    const docs = await findCard("Docs");
    const items = await openCardMenu(docs);
    await userEvent
      .setup()
      .click(items.find((i) => i.textContent === en.connections.disconnect) as HTMLElement);
    await vi.waitFor(() => expect(footControls(docs)).toEqual([en.connections.oauthConnect]));
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `DELETE ${O}/connectors/c1/credentials/me`,
      `GET ${O}/connectors/c1`,
    ]);
  });

  it("revoking a grant invalidates toolGrants: the grants are read again", async () => {
    let grants = [
      { agentId: "ag1", agentName: "Echo", toolKey: "mcp__t__x", specHash: "h", createdAt: T },
    ];
    const routes: Routes = {
      ...ROUTES,
      [`GET ${O}/me/tool-grants`]: () => json(200, { grants }),
      [`DELETE ${O}/me/tool-grants/ag1/mcp__t__x`]: () => {
        grants = [];
        return noContent();
      },
    };
    const calls = stubApi(routes);
    await renderRouteWithCache("/account/grants", routes);
    await userEvent.setup().click(screen.getByRole("button", { name: /t \[x\]/ }));
    expect(await screen.findByText(en.connections.grants.empty)).toBeTruthy();
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `DELETE ${O}/me/tool-grants/ag1/mcp__t__x`,
      `GET ${O}/me/tool-grants`,
    ]);
    expect(router.refresh).not.toHaveBeenCalled();
  });
});
