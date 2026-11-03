// The organization and personal settings pages render on the server (web-SSR spec §6, task 9):
// first paint complete without a browser fetch, the gate cases, and the failure modes of R5.
import { act, cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import ExtensionsPage from "../src/app/(app)/settings/extensions/page";
import ModelsPage from "../src/app/(app)/settings/models/page";
import PluginsPage from "../src/app/(app)/settings/plugins/page";
import TokensPage from "../src/app/(app)/settings/tokens/page";
import { bodyOf, json, stubApi } from "./support/api";
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
  const r = await renderRouteEmptyCache(path, {
    ...routes,
    [held]: async (c) => {
      await gate;
      return answer(c);
    },
  });
  return { ...r, release: () => act(async () => release()) };
}

/** Waits for `name`'s template, then checks it is busy and `text` is not shown yet. */
async function expectLoading(name: string, text: string) {
  await vi.waitFor(() => {
    if (template(name) === null) throw new Error("no page");
  });
  expect(document.querySelector("[aria-busy='true']")).not.toBeNull();
  expect(screen.queryByText(text)).toBeNull();
}

const template = (name: string) => document.querySelector(`[data-template="${name}"]`);
const noAccess = () => template("StatusPage")?.getAttribute("data-kind") === "no-access";

beforeEach(() => resetNavigation("/settings/organization"));
afterEach(cleanup);

describe("first paint comes from the server (no browser fetch)", () => {
  it("/settings/organization and /settings/sandbox: a first render from the hydrated cache makes no browser read", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRouteWithCache("/settings/organization", ROUTES);
    expect(
      screen.getByRole("radio", { name: new RegExp(`^${en.orgSettings.toolSearch.off}`) }),
    ).toHaveProperty("checked", true);
    await settle();
    cleanup();
    await renderRouteWithCache("/settings/sandbox", ROUTES);
    expect(
      screen.getByRole("radio", { name: new RegExp(`^${en.orgSettings.sandbox.ask}`) }),
    ).toHaveProperty("checked", true);
    expect(screen.getByText(en.orgSettings.limits.title)).toBeTruthy();
    await settle();
    expect(browser).toEqual([]);
  });

  it.each([
    ["/settings/organization", en.orgSettings.toolSearch.offHint],
    ["/settings/sandbox", en.orgSettings.limits.title],
  ])("%s: an empty cache shows the template's loading state, then the data", async (path, text) => {
    const { release } = await renderHeld(path, `GET ${O}/settings`);
    await expectLoading("SettingsPage", text);
    await release();
    expect(await screen.findByText(text)).toBeTruthy();
    await vi.waitFor(() => expect(document.querySelector("[aria-busy='true']")).toBeNull());
  });

  it("/settings/organization: a failed read is the error state; retry reads it again", async () => {
    let fail = true;
    const answer = ROUTES[`GET ${O}/settings`] as NonNullable<Routes[string]>;
    const routes: Routes = {
      ...ROUTES,
      [`GET ${O}/settings`]: (c) => (fail ? failing() : answer(c)),
    };
    const calls = stubApi(routes);
    await renderRouteWithCache("/settings/organization", routes);
    expect(template("StatusPage")?.getAttribute("data-kind")).toBe("maintenance");
    await settle();
    expect(calls).toEqual([]);
    fail = false;
    await userEvent.setup().click(screen.getByRole("button", { name: en.errors.page.retry }));
    expect(await screen.findByText(en.orgSettings.toolSearch.offHint)).toBeTruthy();
  });

  it("saving the sandbox settings writes the answer into the cache the general page shares (no read)", async () => {
    const calls = stubApi({
      ...ROUTES,
      [`PATCH ${O}/settings`]: (c) =>
        json(200, {
          settings: { toolSearch: "off", locale: "en", ...(bodyOf(c) as object) },
        }),
    });
    const { client } = await renderRouteWithCache("/settings/sandbox", ROUTES);
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("radio", { name: new RegExp(`^${en.orgSettings.sandbox.allow}`) }),
    );
    const row = screen.getByRole("region", { name: "Pending changes" });
    await user.click(within(row).getByRole("button", { name: en.orgSettings.save }));
    expect(await screen.findByText(en.sandboxSettings.saved)).toBeTruthy();
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`PATCH ${O}/settings`]);
    const cached = client.getQueryData<{ settings: object; sandboxLimits?: object }>([
      "org",
      "o1",
      "orgSettings",
    ]);
    expect(cached?.settings).toMatchObject({ sandboxToolPolicy: "allow" });
    // the read-only parts the answer left out stay
    expect(cached?.sandboxLimits).toEqual({ cpu: 2, memoryMb: 4096, source: "deployment" });
  });

  it("/settings/members: a first render from the hydrated cache makes no browser read (members and, for an admin, the invitations)", async () => {
    const browser = expectNoFirstPaintFetch();
    const { calls } = await renderRouteWithCache("/settings/members", ROUTES);
    expect(screen.getByText("Bob")).toBeTruthy();
    expect(screen.getByText(en.members.invitations.status.pending)).toBeTruthy();
    expect(calls.map((c) => c.url)).toContain(`${O}/invitations`);
    await settle();
    expect(browser).toEqual([]);
  });

  it("/settings/members: a member reads no invitations", async () => {
    const browser = expectNoFirstPaintFetch();
    const { calls } = await renderRouteWithCache("/settings/members", ROUTES, { me: as("member") });
    expect(screen.getByText("Bob")).toBeTruthy();
    expect(calls.map((c) => c.url)).not.toContain(`${O}/invitations`);
    expect(screen.queryByText(en.members.invitations.title)).toBeNull();
    await settle();
    expect(browser).toEqual([]);
  });

  it("/settings/members: invitations the kernel fails draw the table's error; retry reads them in the browser", async () => {
    let fail = true;
    const answer = ROUTES[`GET ${O}/invitations`] as NonNullable<Routes[string]>;
    const routes: Routes = {
      ...ROUTES,
      [`GET ${O}/invitations`]: (c) => (fail ? failing() : answer(c)),
    };
    const browser = stubApi(routes);
    await renderRouteWithCache("/settings/members", routes);
    expect(screen.getByText("Bob")).toBeTruthy();
    await settle();
    // the hydrated error is not read again on mount
    expect(browser).toEqual([]);
    fail = false;
    await userEvent.setup().click(screen.getByRole("button", { name: en.common.retry }));
    expect(await screen.findByText(en.members.invitations.status.pending)).toBeTruthy();
    expect(browser.map((c) => `${c.method} ${c.url}`)).toEqual([`GET ${O}/invitations`]);
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("/settings/members: a failing member list is the error state, not an empty page", async () => {
    stubApi(ROUTES);
    await renderRouteWithCache("/settings/members", { ...ROUTES, [`GET ${O}/members`]: failing });
    expect(template("StatusPage")?.getAttribute("data-kind")).toBe("maintenance");
    expect(screen.queryByText("Bob")).toBeNull();
  });

  it("/settings/members: an empty cache shows the template's loading state, then the data", async () => {
    const { release } = await renderHeld("/settings/members", `GET ${O}/members`);
    await expectLoading("SettingsPage", "Bob");
    await release();
    expect(await screen.findByText("Bob")).toBeTruthy();
    await vi.waitFor(() => expect(document.querySelector("[aria-busy='true']")).toBeNull());
  });

  it("/settings/models, /plugins, /extensions, /tokens", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRoute(() => ModelsPage(), ROUTES);
    expect(screen.getByText(en.models.org.description)).toBeTruthy();
    cleanup();
    await renderRoute(() => PluginsPage(), ROUTES);
    expect(screen.getByText(en.catalog.plugins.empty)).toBeTruthy();
    cleanup();
    await renderRoute(() => ExtensionsPage(), ROUTES);
    expect(screen.getByText(en.extensions.empty)).toBeTruthy();
    cleanup();
    await renderRoute(() => TokensPage(), ROUTES);
    expect(screen.getByText(en.tokens.empty)).toBeTruthy();
    expect(browser).toEqual([]);
  });

  it("/settings/extensions: previewers the kernel fails only hide their block", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRoute(() => ExtensionsPage(), { ...ROUTES, [`GET ${O}/file-previewers`]: failing });
    expect(screen.getByText(en.extensions.empty)).toBeTruthy();
    expect(browser).toEqual([]);
  });
});

type Page = () => Promise<ReactNode>;
const GATES: [string, Page, "member" | "admin" | "guest", boolean][] = [
  ["/settings/models", () => ModelsPage(), "admin", true],
  ["/settings/plugins", () => PluginsPage(), "admin", false],
  ["/settings/extensions", () => ExtensionsPage(), "admin", false],
  ["/settings/tokens", () => TokensPage(), "admin", false],
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
});

/** The pages that read through the query cache: path, the role they need, whether a setup step. */
const ROUTE_GATES: [string, "member" | "admin", boolean][] = [
  ["/settings/organization", "member", false],
  ["/settings/sandbox", "member", false],
  ["/settings/members", "member", true],
];

describe("the gates (query cache)", () => {
  it.each(ROUTE_GATES)(
    "%s: below its role no access and nothing read; no org renders nothing; setup",
    async (path, min, step) => {
      const denied = min === "admin" ? as("member") : as("guest");
      const r = await renderRouteWithCache(path, ROUTES, { me: denied });
      expect(new Set(r.calls.map((c) => c.url))).toEqual(new Set(["/api/v1/me", `${O}/readiness`]));
      expect(noAccess()).toBe(true);
      cleanup();
      const none = await renderRouteWithCache(path, ROUTES, { me: { ...ME, currentOrgId: null } });
      expect(none.calls.map((c) => c.url)).toEqual(["/api/v1/me"]);
      expect(document.body.textContent).toBe("");
      cleanup();
      await renderRouteWithCache(path, ROUTES, { readiness: NOT_READY });
      if (step) {
        expect(template("StatusPage")).toBeNull();
        expect(document.querySelector("h1")).not.toBeNull();
        await settle();
        expect(router.replace).not.toHaveBeenCalled();
      } else {
        await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith("/"));
      }
    },
  );
});
