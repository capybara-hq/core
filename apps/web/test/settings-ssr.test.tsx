// The organization settings pages read from the query cache the layout prefetched (web query
// cache spec §3): first paint complete without a browser read, the loading state on an empty
// cache, the gate cases, the failure modes of R5 and the mutations' cache updates.
import { act, cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import { bodyOf, json, stubApi } from "./support/api";
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
const as = (role: string) => ({
  ...ME,
  account: { ...ME.account, isSuperAdmin: false },
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
  [`GET ${O}/ui/contributions`]: () => json(200, { items: [] }),
  [`GET ${O}/members`]: () => json(200, { members: MEMBERS }),
  [`GET ${O}/invitations`]: () => json(200, { invitations: [INVITATION] }),
  [`GET ${O}/model-purposes`]: () => json(200, { purposes: [] }),
  [`GET ${O}/models`]: () => json(200, { providers: [] }),
  [`GET ${O}/models/catalog`]: () => json(200, { providers: [] }),
  [`GET ${O}/plugin-installs`]: () => json(200, { installs: [] }),
  [`GET ${O}/extensions`]: () => json(200, { extensions: [] }),
  [`GET ${O}/file-previewers`]: () => json(200, { items: [] }),
  [`GET ${O}/ui/arrangement`]: () => json(200, { slots: [] }),
  [`GET ${O}/extension-points`]: () => json(200, { points: [] }),
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

const EXTENSION = {
  plugin: "todo",
  displayName: { zh: "待办", en: "Todo" },
  version: "1.0.0",
  enabled: true,
  available: true,
  configurable: false,
  orgConfigSchema: null,
  config: null,
  secrets: [],
  permissions: [],
  provides: [],
};
const PREVIEWER = {
  plugin: "todo",
  id: "md",
  title: { zh: "Markdown", en: "Markdown" },
  accepts: { extensions: ["md"] },
  position: 0,
  disabled: false,
};

const template = (name: string) => document.querySelector(`[data-template="${name}"]`);
const noAccess = () => template("StatusPage")?.getAttribute("data-kind") === "no-access";

beforeEach(() => resetNavigation("/settings/organization"));
afterEach(cleanup);

describe("first paint comes from the hydrated cache (no browser read)", () => {
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
    ["/settings/sandbox", en.orgSettings.sandbox.askHint],
  ])("%s: an empty cache shows the template's loading state, then the data", async (path, text) => {
    const { release } = await renderHeld(path, `GET ${O}/settings`);
    await expectLoading("SettingsPage", text);
    await release();
    expect(await screen.findByText(text)).toBeTruthy();
    await vi.waitFor(() => expect(document.querySelector("[aria-busy='true']")).toBeNull());
  });

  it.each([
    // the radio cards of tool search; the read-only note only for a member
    ["/settings/organization", `GET ${O}/settings`, { radios: 1, kv: 0, items: 0, switches: 0 }],
    // the tool policy and egress radios, the resources' key-value
    ["/settings/sandbox", `GET ${O}/settings`, { radios: 2, kv: 1, items: 0, switches: 0 }],
    // the 用途默认 tab: the kernel's six purposes as item rows, each with its model select
    [
      "/settings/models?tab=purposes",
      `GET ${O}/model-purposes`,
      { radios: 0, kv: 0, items: 6, switches: 0 },
    ],
  ] as const)(
    "%s: the loading state draws the page's static shapes (Q6)",
    async (path, held, shapes) => {
      const { release } = await renderHeld(path, held);
      await vi.waitFor(() => {
        if (document.querySelector("[aria-busy='true']") === null) throw new Error("not loading");
      });
      expect(document.querySelectorAll('[data-part="loading-radios"]')).toHaveLength(shapes.radios);
      expect(document.querySelectorAll('[data-part="loading-key-value"]')).toHaveLength(shapes.kv);
      expect(
        document.querySelectorAll(
          '[data-part="loading-item-list"] > [data-part="loading-item-row"]',
        ),
      ).toHaveLength(shapes.items);
      expect(document.querySelectorAll('[data-box="block"][style*="32px"]')).toHaveLength(
        shapes.switches,
      );
      // extensions: each group's hint line and permission rows; plugins: each item's components
      expect(
        document.querySelectorAll(
          '[data-part="loading-item-group"] > [data-part="loading-item-row"]',
        ),
      ).toHaveLength(shapes.switches * 2);
      expect(
        // the hint is Text variant="prose": its slot is at the prose-small line (the body size)
        document.querySelectorAll(
          '.cb-form-section-fields > [data-part="skeleton-text"][data-size="body"]',
        ),
      ).toHaveLength(shapes.switches);
      await release();
      await vi.waitFor(() => expect(document.querySelector("[aria-busy='true']")).toBeNull());
    },
  );

  it("/settings/organization: a member's loading tool search has the read-only note's slot, an owner's none", async () => {
    const card = () =>
      document.querySelector('[data-part="loading-radios"]')?.parentElement?.lastElementChild;
    const held = async (me?: ReturnType<typeof as>) => {
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => {
        release = r;
      });
      await renderRouteEmptyCache(
        "/settings/organization",
        {
          ...ROUTES,
          [`GET ${O}/settings`]: async (c) => {
            await gate;
            return (ROUTES[`GET ${O}/settings`] as NonNullable<Routes[string]>)(c);
          },
        },
        me ? { me } : {},
      );
      await vi.waitFor(() => {
        if (document.querySelector('[data-part="loading-radios"]') === null) throw new Error("no");
      });
      return () => act(async () => release());
    };
    const r1 = await held(as("member"));
    expect(card()?.getAttribute("data-size")).toBe("small");
    await r1();
    cleanup();
    const r2 = await held();
    expect(card()?.getAttribute("data-part")).toBe("loading-radios");
    await r2();
  });

  it("/settings/organization: the loading page keeps its four sections and an owner's danger zone (the role is the session's)", async () => {
    const loading = async (me: ReturnType<typeof as>) => {
      await renderRouteEmptyCache(
        "/settings/organization",
        { ...ROUTES, [`GET ${O}/settings`]: () => new Promise<Response>(() => {}) },
        { me },
      );
      await vi.waitFor(() => {
        if (document.querySelector('[data-part="loading-radios"]') === null) throw new Error("no");
      });
    };
    await loading(as("owner"));
    expect(document.querySelectorAll('[data-part="form-section"]')).toHaveLength(4);
    expect(screen.getByRole("heading", { name: en.orgSettings.toolSearch.title })).toBeTruthy();
    expect(screen.getByRole("heading", { name: en.orgSettings.timeZone.title })).toBeTruthy();
    expect(screen.getByRole("heading", { name: en.orgSettings.platformTool.title })).toBeTruthy();
    expect(document.querySelectorAll('[data-part="danger-zone"]')).toHaveLength(1);
    expect(screen.getByRole("button", { name: en.orgLifecycle.delete.action })).toBeTruthy();
    // one busy announcement for the page (the sections do not announce)
    const page = template("SettingsPage") as HTMLElement;
    expect(page.querySelectorAll('[role="status"]')).toHaveLength(1);
    cleanup();
    await loading(as("admin"));
    expect(document.querySelectorAll('[data-part="danger-zone"]')).toHaveLength(0);
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

  it("/settings/models: a first render from the hydrated cache makes no browser read", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRouteWithCache("/settings/models", ROUTES);
    // the 模型 tab (the default) of an org with no providers
    expect(screen.getByText(en.models.org.noProviders)).toBeTruthy();
    await settle();
    expect(browser).toEqual([]);
  });

  it.each([
    ["/settings/models", `GET ${O}/model-purposes`, en.models.org.noProviders],
    ["/settings/models", `GET ${O}/models`, en.models.org.noProviders],
    ["/settings/models", `GET ${O}/models/catalog`, en.models.org.noProviders],
    ["/settings/models?tab=purposes", `GET ${O}/models/catalog`, en.models.org.description],
  ])(
    "%s: an empty cache shows the template's loading state, then the data (held: %s)",
    async (path, held, text) => {
      const { release } = await renderHeld(path, held);
      await vi.waitFor(() => {
        if (template("SettingsPage") === null) throw new Error("no page");
      });
      expect(document.querySelector("[aria-busy='true']")).not.toBeNull();
      await release();
      await vi.waitFor(() => expect(document.querySelector("[aria-busy='true']")).toBeNull());
      expect(screen.getByText(text)).toBeTruthy();
    },
  );

  it("/settings/tokens: a first render from the hydrated cache makes no browser read", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRouteWithCache("/settings/tokens", ROUTES);
    expect(screen.getByText(en.tokens.empty)).toBeTruthy();
    await settle();
    expect(browser).toEqual([]);
  });

  it("/settings/tokens: an empty cache shows the template's loading state, then the data", async () => {
    const { release } = await renderHeld("/settings/tokens", `GET ${O}/service-tokens`);
    await expectLoading("SettingsPage", en.tokens.empty);
    await release();
    expect(await screen.findByText(en.tokens.empty)).toBeTruthy();
    await vi.waitFor(() => expect(document.querySelector("[aria-busy='true']")).toBeNull());
  });

  it("/extensions: a first render from the hydrated cache makes no browser read", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRouteWithCache("/extensions", {
      ...ROUTES,
      [`GET ${O}/extensions`]: () => json(200, { extensions: [EXTENSION] }),
      [`GET ${O}/file-previewers`]: () => json(200, { items: [PREVIEWER] }),
      [`GET ${O}/ui/arrangement`]: () => json(200, { slots: [] }),
    });
    expect(screen.getByRole("row", { name: /Todo/ })).toBeTruthy();
    expect(screen.getByRole("switch", { name: /Markdown/ })).toBeTruthy();
    await settle();
    expect(browser).toEqual([]);
  });

  it("/extensions: previewers the kernel fails only hide their block (not read again on mount)", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRouteWithCache("/extensions", {
      ...ROUTES,
      [`GET ${O}/file-previewers`]: failing,
      [`GET ${O}/ui/arrangement`]: () => json(200, { slots: [] }),
    });
    expect(screen.getByText(en.extensions.empty)).toBeTruthy();
    await settle();
    expect(browser).toEqual([]);
  });

  it("/extensions: an empty cache shows the template's loading state, then the data", async () => {
    const { release } = await renderHeld("/extensions", `GET ${O}/extensions`);
    await expectLoading("ListPage", en.extensions.empty);
    await release();
    expect(await screen.findByText(en.extensions.empty)).toBeTruthy();
    await vi.waitFor(() => expect(document.querySelector("[aria-busy='true']")).toBeNull());
  });

  it("/extensions: disabling an extension writes it into the cache and invalidates what it brings", async () => {
    const routes: Routes = {
      ...ROUTES,
      [`GET ${O}/extensions`]: () => json(200, { extensions: [EXTENSION] }),
      [`GET ${O}/file-previewers`]: () => json(200, { items: [PREVIEWER] }),
    };
    const calls = stubApi({
      ...routes,
      [`GET ${O}/readiness`]: () => json(200, { modelProvider: "ready", agents: 1 }),
      [`PUT ${O}/extensions/todo`]: () =>
        json(200, { extension: { ...EXTENSION, enabled: false } }),
    });
    const { client } = await renderRouteWithCache("/extensions", routes);
    // the models and purposes are cached (as after a visit to /settings/models)
    client.setQueryData(["org", "o1", "models"], { providers: [] });
    client.setQueryData(["org", "o1", "orgPurposes"], { purposes: [] });
    await userEvent
      .setup()
      .click(
        screen.getByRole("switch", { name: en.extensions.enableLabel.replace("{plugin}", "Todo") }),
      );
    await vi.waitFor(() => expect(screen.getByText(en.extensions.disabled)).toBeTruthy());
    // the list is not read again (the answer is the extension); the shown readiness,
    // previewers and default providers are, and the cached models and purposes are stale
    // (界面位置 lives on 组织设置 › 外观: not shown here, so not read)
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `PUT ${O}/extensions/todo`,
      `GET ${O}/readiness`,
      `GET ${O}/file-previewers`,
      `GET ${O}/extension-points`,
    ]);
    expect(client.getQueryState(["org", "o1", "models"])?.isInvalidated).toBe(true);
    expect(client.getQueryState(["org", "o1", "orgPurposes"])?.isInvalidated).toBe(true);
  });
});

/** The pages that read through the query cache: path, the role they need, whether a setup step. */
const ROUTE_GATES: [string, "member" | "admin", boolean][] = [
  ["/settings/organization", "member", false],
  ["/settings/sandbox", "member", false],
  ["/settings/members", "member", true],
  ["/settings/models", "admin", true],
  // a setup step since the 2026-11-07 acceptance: connecting a channel needs its extension on
  ["/extensions", "member", true],
  ["/settings/tokens", "admin", false],
];

describe("the gates", () => {
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
