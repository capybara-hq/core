// The organization and personal settings pages render on the server (web-SSR spec §6, task 9):
// first paint complete without a browser fetch, the gate cases, and the failure modes of R5.
import { act, cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import ConnectionsPage from "../src/app/(app)/account/connections/page";
import IdentitiesPage from "../src/app/(app)/account/identities/page";
import { json, noContent, stubApi } from "./support/api";
import { resetNavigation, router } from "./support/navigation";
import { renderRouteEmptyCache, renderRouteWithCache } from "./support/query";
import { ME } from "./support/render";
import { expectNoFirstPaintFetch, type Routes, renderRoute } from "./support/server";
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
const as = (role: string) => ({
  ...ME,
  account: { ...ME.account, isEnterpriseAdmin: false },
  memberships: [{ orgId: "o1", slug: "acme", name: "Acme", role }],
});
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

const ROUTES: Routes = {
  [`GET ${O}/settings`]: () =>
    json(200, {
      settings: { toolSearch: "off", locale: "en", sandboxToolPolicy: "ask" },
      deployment: { sandboxEgress: { mode: "open", allowHosts: [] } },
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
const noAccess = () => template("StatusPage")?.getAttribute("data-kind") === "no-access";

beforeEach(() => resetNavigation("/settings/organization"));
afterEach(cleanup);

describe("first paint comes from the server (no browser fetch)", () => {
  it("/account/connections: the personal connectors' details are read on the server in parallel", async () => {
    const browser = expectNoFirstPaintFetch();
    const { calls } = await renderRoute(() => ConnectionsPage(), ROUTES);
    expect(screen.getByRole("region", { name: "Docs" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Wiki" })).toBeTruthy();
    expect(screen.queryByText("Shared")).toBeNull();
    expect(calls.map((c) => c.url)).not.toContain(`${O}/connectors/c3`);
    expect(browser).toEqual([]);
  });

  it("/account/connections: a connector the kernel no longer shows is left out", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRoute(() => ConnectionsPage(), {
      ...ROUTES,
      [`GET ${O}/connectors/c2`]: () => json(404, { error: { code: "connector.not_found" } }),
    });
    expect(screen.getByRole("region", { name: "Docs" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Wiki" })).toBeNull();
    expect(browser).toEqual([]);
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

  it("/account/identities: no org needed; 验证 only for login plugins the server read", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRoute(() => IdentitiesPage(), ROUTES, { me: { ...ME, currentOrgId: null } });
    expect(screen.getByText("Alice Wong")).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: "Row actions" }));
    expect(screen.getByRole("menuitem", { name: en.identities.verify })).toBeTruthy();
    expect(browser).toEqual([]);
    cleanup();
    await renderRoute(() => IdentitiesPage(), { ...ROUTES, "GET /api/v1/auth/sources": failing });
    await userEvent.setup().click(screen.getByRole("button", { name: "Row actions" }));
    expect(screen.queryByRole("menuitem", { name: en.identities.verify })).toBeNull();
    expect(screen.getByRole("menuitem", { name: en.identities.unlink })).toBeTruthy();
    expect(browser).toEqual([]);
  });
});

type Page = () => Promise<ReactNode>;
const GATES: [string, Page, "guest", boolean][] = [
  ["/account/connections", () => ConnectionsPage(), "guest", true],
];

describe("the gates", () => {
  it.each(GATES)(
    "%s: below its role no access and nothing read; no org renders nothing; setup",
    async (_p, page, min, step) => {
      if (min !== "guest") {
        const denied = min === "admin" ? as("member") : as("guest");
        const r = await renderRoute(page, ROUTES, { me: denied });
        expect(new Set(r.calls.map((c) => c.url))).toEqual(
          new Set(["/api/v1/me", `${O}/readiness`]),
        );
        expect(noAccess()).toBe(true);
        cleanup();
      }
      const none = await renderRoute(page, ROUTES, { me: { ...ME, currentOrgId: null } });
      expect(none.calls.map((c) => c.url)).toEqual(["/api/v1/me"]);
      cleanup();
      if (step) {
        await renderRoute(page, ROUTES, { readiness: NOT_READY });
        expect(template("StatusPage")).toBeNull();
        expect(document.querySelector("h1")).not.toBeNull();
      } else {
        await expect(renderRoute(page, ROUTES, { readiness: NOT_READY })).rejects.toThrow(
          "REDIRECT /",
        );
      }
    },
  );

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
    await renderRoute(() => IdentitiesPage(), ROUTES, { readiness: NOT_READY });
    expect(screen.getByText("Alice Wong")).toBeTruthy();
  });
});

describe("mutations invalidate the cache", () => {
  it("revoking a grant invalidates toolGrants: the grants are read again", async () => {
    let grants = [
      { agentId: "ag1", agentName: "Echo", toolKey: "t__x", specHash: "h", createdAt: T },
    ];
    const routes: Routes = {
      ...ROUTES,
      [`GET ${O}/me/tool-grants`]: () => json(200, { grants }),
      [`DELETE ${O}/me/tool-grants/ag1/t__x`]: () => {
        grants = [];
        return noContent();
      },
    };
    const calls = stubApi(routes);
    await renderRouteWithCache("/account/grants", routes);
    await userEvent.setup().click(screen.getByRole("button", { name: /t__x/ }));
    expect(await screen.findByText(en.connections.grants.empty)).toBeTruthy();
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `DELETE ${O}/me/tool-grants/ag1/t__x`,
      `GET ${O}/me/tool-grants`,
    ]);
    expect(router.refresh).not.toHaveBeenCalled();
  });
});
