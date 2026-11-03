// The admin console reads from the query cache the layout prefetched (web query cache spec §3):
// first paint complete without a browser read, the loading state on an empty cache, the
// enterprise-admin gate (only the session is read below it), R5's failures and the mutations'
// cache updates. Pages not migrated yet still render on the server (`renderRoute`).
import { act, cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import AdminCatalogItemPage from "../src/app/(app)/admin/catalog/[itemId]/page";
import PluginImportPage from "../src/app/(app)/admin/catalog/import/page";
import AdminCatalogPage from "../src/app/(app)/admin/catalog/page";
import CatalogRequestsPage from "../src/app/(app)/admin/catalog/requests/page";
import MarketplaceEntriesPage from "../src/app/(app)/admin/marketplaces/entries/page";
import MarketplacesPage from "../src/app/(app)/admin/marketplaces/page";
import { bodyOf, json, stubApi } from "./support/api";
import { resetNavigation, router } from "./support/navigation";
import { renderRouteEmptyCache, renderRouteWithCache } from "./support/query";
import { ME } from "./support/render";
import { expectNoFirstPaintFetch, type Routes, renderRoute } from "./support/server";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

const T = "2026-10-19T12:00:00.000Z";
const NOT_ADMIN = { ...ME, account: { ...ME.account, isEnterpriseAdmin: false } };
const failing = () => json(500, { error: { code: "internal", message: "x" } });
const template = (name: string) => document.querySelector(`[data-template="${name}"]`);
const noAccess = () => template("StatusPage")?.getAttribute("data-kind") === "no-access";

const ACCOUNT = (id: string, name: string) => ({
  id,
  displayName: name,
  email: null,
  status: "active",
  isEnterpriseAdmin: id === "a1",
  createdAt: T,
});
const SETTINGS = {
  orgCreation: "anyone",
  runConcurrencyOverrides: { o2: 3 },
  priceCurrency: "USD",
  sandboxLimitOverrides: {},
  customConnectors: "allow",
  customSkills: "allow",
};

const SHA = "a".repeat(64);
const ext = (over: Record<string, unknown> = {}) => ({
  name: "demo",
  version: "1.0.0",
  source: "install",
  sha256: SHA,
  status: "disabled",
  desired: { version: "1.0.0", sha256: SHA, state: "disabled" },
  replicas: [],
  permissions: [],
  added: [],
  addedItems: [],
  warnings: [],
  removed: [],
  reviewHash: "0123456789abcdef",
  sensitive: false,
  snapshot: { version: "1.0.0", approvedAt: T, approvedBy: "a1", source: "web" },
  configurable: true,
  configValid: true,
  removable: true,
  required: false,
  installSource: "file",
  ...over,
});
const CONFIG = {
  plugin: "demo",
  version: "1.0.0",
  configurable: true,
  schema: { type: "object", properties: { region: { type: "string" } } },
  fields: [
    { path: "region", secret: false, hot: false, source: "file", readonly: true, value: "eu-1" },
  ],
  valid: true,
  validated: true,
  issues: [],
};

const ITEM_ID = "11111111-1111-4111-8111-111111111111";
const catalogItem = (over: Record<string, unknown> = {}) => ({
  id: ITEM_ID,
  name: "crm",
  publisher: "Acme",
  displayName: null,
  description: "",
  policy: "allow",
  latestVersion: "1.0.0",
  versions: ["1.0.0"],
  installs: 2,
  source: "marketplace",
  marketplaceId: "official",
  latestMarketplaceVersion: "1.0.0",
  newerInMarketplace: false,
  contentChanged: false,
  updatedAt: T,
  ...over,
});
const MARKETPLACE = {
  id: "official",
  name: "Capybara official marketplace",
  url: "https://example.com/index.json",
  mirrors: [],
  builtin: true,
  enabled: true,
  disabledByConfig: false,
  hasToken: false,
  lastRefreshedAt: null,
  lastStatus: "never",
  lastError: null,
  entryCount: 1,
};
const ENTRY = {
  sourceId: "official",
  sourceName: "Official",
  name: "crm",
  version: "1.0.0",
  summary: { en: "CRM plugin" },
  minKernel: null,
  homepage: null,
  permissions: null,
  source: {
    npm: { package: "@acme/plugin-crm", version: "1.0.0", integrity: `sha512-${"a".repeat(86)}==` },
  },
  compatible: true,
  importable: true,
  adopted: null,
  newerAvailable: false,
  contentChanged: false,
};
const PREPARED = {
  stagingId: "st1",
  permissionsMismatch: null,
  review: {
    name: "crm",
    version: "1.0.0",
    packageName: "@acme/plugin-crm",
    publisher: "Acme",
    description: "CRM plugin",
    connectorTemplates: [],
    skills: [],
    agents: [],
    dependencies: [],
    source: { kind: "npm", ref: "@acme/plugin-crm@1.0.0" },
    provenance: { checked: false, reason: "none" },
    contentDigest: "d".repeat(64),
    sensitive: false,
    reviewHash: "h1",
  },
};

const ROUTES: Routes = {
  "GET /api/v1/admin/catalog/items": () => json(200, { items: [catalogItem()], nextOffset: null }),
  [`GET /api/v1/admin/catalog/items/${ITEM_ID}`]: () =>
    json(200, {
      item: { ...catalogItem(), packageName: null, deletedAt: null },
      versions: [
        {
          version: "1.0.0",
          source: "file",
          sourceRef: "upload",
          integrity: null,
          contentDigest: null,
          sourceDetail: null,
          manifest: {
            name: "crm",
            version: "1.0.0",
            publisher: "Acme",
            description: "CRM plugin",
            dependencies: [{ name: "crm-core", version: "^1.0.0" }],
          },
          size: 1024,
          extensionSha256: null,
          importedAt: T,
        },
      ],
      hasIcon: false,
    }),
  "GET /api/v1/admin/catalog/requests": () =>
    json(200, {
      requests: [
        {
          id: "r1",
          orgId: "o1",
          orgName: "Acme",
          item: { id: ITEM_ID, name: "crm", displayName: null },
          version: null,
          stage: "deployment",
          status: "pending",
          note: "",
          requestedBy: "a2",
          requestedByName: "Mia",
          decidedBy: null,
          decidedAt: null,
          orgDecidedBy: null,
          orgDecidedAt: null,
          createdAt: T,
        },
      ],
    }),
  "GET /api/v1/admin/marketplaces": () => json(200, { items: [MARKETPLACE], offline: false }),
  "GET /api/v1/admin/marketplaces/entries": () => json(200, { items: [ENTRY] }),
  "GET /api/v1/admin/catalog/imports/st1": () => json(200, PREPARED),
  "GET /api/v1/admin/extensions": () => json(200, { extensions: [ext()], drainSeconds: 45 }),
  "GET /api/v1/admin/extensions/demo/config": () => json(200, CONFIG),
  "GET /api/v1/admin/overview": () =>
    json(200, { extensionsNeedingAction: 3, catalogRequestsPending: 1, orgs: 2, accounts: 7 }),
  "GET /api/v1/admin/accounts": () =>
    json(200, { accounts: [ACCOUNT("a1", "Grant"), ACCOUNT("a2", "Alice")], next: "a2" }),
  "GET /api/v1/admin/orgs": () =>
    json(200, { orgs: [{ id: "o2", slug: "beta", name: "Beta", memberCount: 4, createdAt: T }] }),
  "GET /api/v1/admin/settings": () => json(200, SETTINGS),
  "GET /api/v1/admin/models": () => json(200, { providers: [], prices: [], currency: "EUR" }),
  "GET /api/v1/admin/model-purposes": () => json(200, { purposes: [] }),
};

beforeEach(() => resetNavigation("/admin"));
afterEach(cleanup);

const settle = () => act(() => new Promise((r) => setTimeout(r, 20)));

/** An empty-cache client navigation to `path` whose `held` read answers only on `release()`. */
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

/** The template `name` is drawn busy and `text` (from the data) is not there yet. */
async function expectLoading(name: string, text: string) {
  await vi.waitFor(() => {
    if (template(name) === null) throw new Error("no page");
  });
  expect(document.querySelector("[aria-busy='true']")).not.toBeNull();
  expect(screen.queryByText(text)).toBeNull();
}

describe("first paint comes from the server (no browser fetch)", () => {
  it("/admin: a first render from the hydrated cache makes no browser read", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRouteWithCache("/admin", ROUTES);
    expect(screen.getByText("7")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
    await settle();
    expect(browser).toEqual([]);
  });

  it("/admin/accounts: a first render from the hydrated cache makes no browser read (load more when there is a next)", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRouteWithCache("/admin/accounts", ROUTES);
    expect(screen.getByText("Alice")).toBeTruthy();
    expect(screen.getByRole("button", { name: en.admin.accounts.loadMore })).toBeTruthy();
    await settle();
    expect(browser).toEqual([]);
  });

  it("/admin/orgs: a first render from the hydrated cache makes no browser read", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRouteWithCache("/admin/orgs", ROUTES);
    expect(screen.getByText("Beta")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
    await settle();
    expect(browser).toEqual([]);
  });

  it("/admin/settings and /admin/models: a first render from the hydrated cache makes no browser read", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRouteWithCache("/admin/settings", ROUTES);
    expect(screen.getByDisplayValue("USD")).toBeTruthy();
    cleanup();
    await renderRouteWithCache("/admin/models", ROUTES);
    expect(screen.getByText(en.models.admin.noProviders)).toBeTruthy();
    await settle();
    expect(browser).toEqual([]);
  });

  it.each([
    ["/admin", "GET /api/v1/admin/overview", "OverviewPage", "7"],
    ["/admin/accounts", "GET /api/v1/admin/accounts", "ListPage", "Alice"],
    ["/admin/orgs", "GET /api/v1/admin/orgs", "ListPage", "Beta"],
    [
      "/admin/settings",
      "GET /api/v1/admin/settings",
      "FormPage",
      en.admin.settings.orgCreation.anyone,
    ],
    ["/admin/models", "GET /api/v1/admin/models", "ListPage", en.models.admin.noProviders],
  ])(
    "%s: an empty cache shows the template's loading state, then the data",
    async (path, held, name, text) => {
      const { release } = await renderHeld(path, held);
      await expectLoading(name, text);
      await release();
      expect(await screen.findByText(text)).toBeTruthy();
      await vi.waitFor(() => expect(document.querySelector("[aria-busy='true']")).toBeNull());
    },
  );

  it("/admin: while the numbers load the note stays and the numbers are stat slots", async () => {
    const { release } = await renderHeld("/admin", "GET /api/v1/admin/overview");
    await expectLoading("OverviewPage", "7");
    expect(screen.getByText(en.admin.overview.noConversations)).toBeTruthy();
    expect(document.querySelectorAll('[data-part="stat-card"]')).toHaveLength(4);
    await release();
  });

  it("/admin/settings: the loading sections are the page's own (three card radios, the currency)", async () => {
    const { release } = await renderHeld("/admin/settings", "GET /api/v1/admin/settings");
    await expectLoading("FormPage", en.admin.settings.orgCreation.anyone);
    expect(document.querySelectorAll('[data-part="loading-radios"]')).toHaveLength(3);
    expect(document.querySelectorAll(".cb-form-section")).toHaveLength(4);
    await release();
  });

  it("/admin/models: the purposes load as the kernel's five cards", async () => {
    const { release } = await renderHeld("/admin/models", "GET /api/v1/admin/model-purposes");
    await vi.waitFor(() => {
      if (document.querySelector("[aria-busy='true']") === null) throw new Error("not loading");
    });
    expect(document.querySelectorAll('[data-part="loading-shaped-card"]')).toHaveLength(5);
    await release();
  });

  it("/admin/settings: a save writes the answered settings into the cache (nothing read again)", async () => {
    const calls = stubApi({
      ...ROUTES,
      "PUT /api/v1/admin/settings": (c) => json(200, { ...SETTINGS, ...(bodyOf(c) as object) }),
    });
    const { client } = await renderRouteWithCache("/admin/settings", ROUTES);
    const u = userEvent.setup();
    await u.clear(screen.getByDisplayValue("USD"));
    await u.type(screen.getByRole("textbox", { name: en.admin.settings.currency.label }), "EUR");
    await u.click(screen.getByRole("button", { name: en.admin.settings.save }));
    await vi.waitFor(() =>
      expect(client.getQueryData(["deployment", "settings"])).toMatchObject({
        priceCurrency: "EUR",
      }),
    );
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(["PUT /api/v1/admin/settings"]);
  });

  it("/admin/accounts: creating an account adds it to the cached list and invalidates the overview", async () => {
    const calls = stubApi({
      ...ROUTES,
      "POST /api/v1/admin/accounts": () => json(201, { account: ACCOUNT("a9", "Zoe") }),
    });
    const { client } = await renderRouteWithCache("/admin/accounts", ROUTES);
    await client.prefetchQuery({
      queryKey: ["deployment", "adminOverview"],
      queryFn: () => ({
        extensionsNeedingAction: 0,
        catalogRequestsPending: 0,
        orgs: 0,
        accounts: 0,
      }),
    });
    const u = userEvent.setup();
    await u.click(screen.getByRole("button", { name: en.admin.accounts.new }));
    const f = en.admin.accounts.form;
    await u.type(screen.getByRole("textbox", { name: new RegExp(f.login) }), "zoe");
    await u.type(screen.getByLabelText(new RegExp(f.password)), "secret-pass");
    await u.type(screen.getByRole("textbox", { name: new RegExp(f.displayName) }), "Zoe");
    await u.click(screen.getByRole("button", { name: f.submit }));
    expect(await screen.findByText("Zoe")).toBeTruthy();
    // the list is not read again (the answer is the account); the overview (not on screen) is
    // marked for its next read
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(["POST /api/v1/admin/accounts"]);
    expect(client.getQueryState(["deployment", "adminOverview"])?.isInvalidated).toBe(true);
  });

  it("/admin/extensions: a first render from the hydrated cache makes no browser read", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRouteWithCache("/admin/extensions", ROUTES);
    expect(screen.getByText("demo")).toBeTruthy();
    await settle();
    expect(browser).toEqual([]);
  });

  it("/admin/extensions/install: ?upgrade= comes from the query, the installed list from the cache", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRouteWithCache("/admin/extensions/install?upgrade=demo", ROUTES);
    expect(
      screen.getByText(en.admin.extensions.wizard.upgradeTitle.replace("{name}", "demo")),
    ).toBeTruthy();
    cleanup();
    await renderRouteWithCache("/admin/extensions/install", ROUTES);
    expect(screen.getByText(en.admin.extensions.wizard.title)).toBeTruthy();
    await settle();
    expect(browser).toEqual([]);
  });

  it("/admin/extensions/[name]: the extension and its config, with no browser read", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRouteWithCache("/admin/extensions/demo", ROUTES);
    await userEvent
      .setup()
      .click(screen.getByRole("tab", { name: en.admin.extensions.detail.tabs.config }));
    expect((screen.getByLabelText("region") as HTMLInputElement).value).toBe("eu-1");
    await settle();
    expect(browser).toEqual([]);
  });

  it.each([
    ["/admin/extensions", "ListPage"],
    ["/admin/extensions/demo", "DetailPage"],
  ])("%s: an empty cache shows the template's loading state, then the data", async (path, name) => {
    const { release } = await renderHeld(path, "GET /api/v1/admin/extensions");
    await expectLoading(name, "v1.0.0");
    await release();
    await vi.waitFor(() => expect(document.querySelector("[aria-busy='true']")).toBeNull());
    expect(screen.getAllByText(/1\.0\.0/).length).toBeGreaterThan(0);
  });

  it("/admin/extensions/install: the source step does not wait for the list (it renders for real)", async () => {
    const { release } = await renderHeld(
      "/admin/extensions/install",
      "GET /api/v1/admin/extensions",
    );
    expect(await screen.findByText(en.admin.extensions.wizard.title)).toBeTruthy();
    expect(
      screen.getByRole("radiogroup", { name: en.admin.extensions.wizard.sourceLabel }),
    ).toBeTruthy();
    expect(document.querySelector("[aria-busy='true']")).toBeNull();
    await release();
  });

  it("/admin/extensions/[name]: a config the kernel fails is the tab's own error, not read again on mount; retry reads it", async () => {
    const browser = stubApi({
      "GET /api/v1/admin/extensions/demo/config": () => json(200, CONFIG),
    });
    await renderRouteWithCache("/admin/extensions/demo", {
      ...ROUTES,
      "GET /api/v1/admin/extensions/demo/config": failing,
    });
    expect(screen.getByText("demo", { selector: "h1" })).toBeTruthy();
    const u = userEvent.setup();
    await u.click(screen.getByRole("tab", { name: en.admin.extensions.detail.tabs.config }));
    await settle();
    expect(browser).toEqual([]);
    await u.click(screen.getByRole("button", { name: en.admin.extensions.retry }));
    expect(await screen.findByLabelText("region")).toBeTruthy();
    expect(browser.map((c) => c.url)).toEqual(["/api/v1/admin/extensions/demo/config"]);
  });

  it("/admin/extensions/[name]: an extension not in the list is not found", async () => {
    expectNoFirstPaintFetch();
    await renderRouteWithCache("/admin/extensions/ghost", {
      ...ROUTES,
      "GET /api/v1/admin/extensions/ghost/config": () =>
        json(404, { error: { code: "extension.not_found", message: "x" } }),
    });
    expect(screen.getByText(en.admin.extensions.detail.notFound)).toBeTruthy();
  });

  it("enabling an extension writes it into the cached list and invalidates the org's readiness", async () => {
    const enabled = ext({
      status: "enabled",
      desired: { version: "1.0.0", sha256: SHA, state: "enabled" },
    });
    const browser = stubApi({
      ...ROUTES,
      "POST /api/v1/admin/extensions/demo/enable": () => json(200, enabled),
    });
    const { client } = await renderRouteWithCache("/admin/extensions/demo", ROUTES);
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: en.admin.extensions.detail.actions.enable }));
    await vi.waitFor(() =>
      expect(
        (
          client.getQueryData(["deployment", "extensions"]) as {
            extensions: { status: string }[];
          }
        ).extensions[0]?.status,
      ).toBe("enabled"),
    );
    expect(client.getQueryState(["org", "o1", "readiness"])?.isInvalidated).toBe(true);
    expect(router.refresh).not.toHaveBeenCalled();
    // the list is not read again (the answer is the extension)
    expect(browser.map((c) => `${c.method} ${c.url}`)).not.toContain(
      "GET /api/v1/admin/extensions",
    );
    expect(browser.map((c) => c.method)).toContain("POST");
  });

  it("/admin/catalog: the items, with their source from the marketplaces", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRoute(() => AdminCatalogPage(), ROUTES);
    expect(screen.getByText(/^v[^ ]+ · crm · .*Organizations 2$/)).toBeTruthy();
    expect(browser).toEqual([]);
  });

  it("/admin/catalog: marketplaces the kernel fails only drop the source labels", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRoute(() => AdminCatalogPage(), {
      ...ROUTES,
      "GET /api/v1/admin/marketplaces": failing,
    });
    expect(screen.getByText(/^v[^ ]+ · crm · .*Organizations 2$/)).toBeTruthy();
    expect(browser).toEqual([]);
  });

  it("/admin/catalog/[itemId]: the item, the dependency lookup and the sources", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRoute(item(ITEM_ID), ROUTES);
    expect(screen.getByRole("heading", { name: "crm" })).toBeTruthy();
    expect(screen.getByText(/crm-core/)).toBeTruthy();
    expect(browser).toEqual([]);
  });

  it("/admin/catalog/[itemId]: a missing item is not found; a failing catalog only leaves dependencies unchecked", async () => {
    expectNoFirstPaintFetch();
    await expect(
      renderRoute(item(ITEM_ID), {
        ...ROUTES,
        [`GET /api/v1/admin/catalog/items/${ITEM_ID}`]: () =>
          json(404, { error: { code: "catalog.item_not_found", message: "x" } }),
      }),
    ).rejects.toThrow("NOT_FOUND");
    await renderRoute(item(ITEM_ID), { ...ROUTES, "GET /api/v1/admin/catalog/items": failing });
    expect(screen.getByText(/crm-core/)).toBeTruthy();
    expect(screen.queryByText(/not in the catalog/)).toBeNull();
  });

  it("/admin/catalog/requests: the pending requests", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRoute(() => CatalogRequestsPage(), ROUTES);
    expect(screen.getAllByText("Acme · crm").length).toBeGreaterThan(0);
    expect(browser).toEqual([]);
  });

  it("/admin/catalog/import: no staging starts at the source step; ?staging= opens the review", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRoute(() => PluginImportPage({ searchParams: Promise.resolve({}) }), ROUTES);
    expect(
      screen.getByLabelText(en.catalog.admin.review.sourceLabel, { exact: false }),
    ).toBeTruthy();
    cleanup();
    const { calls } = await renderRoute(
      () => PluginImportPage({ searchParams: Promise.resolve({ staging: "st1" }) }),
      ROUTES,
    );
    expect(calls.map((c) => c.url)).toContain("/api/v1/admin/catalog/imports/st1");
    expect(screen.getByText("@acme/plugin-crm", { exact: false })).toBeTruthy();
    expect(browser).toEqual([]);
  });

  it("/admin/catalog/import: an expired staging is the page's own problem with a restart, not a not-found", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRoute(
      () => PluginImportPage({ searchParams: Promise.resolve({ staging: "gone" }) }),
      {
        ...ROUTES,
        "GET /api/v1/admin/catalog/imports/gone": () =>
          json(404, { error: { code: "plugin.staging_not_found", message: "gone" } }),
      },
    );
    expect(screen.getByText(en.catalog.admin.review.gone)).toBeTruthy();
    expect(screen.getByRole("button", { name: en.catalog.admin.review.restart })).toBeTruthy();
    expect(browser).toEqual([]);
  });

  it("/admin/marketplaces: the sources and the offline flag", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRoute(() => MarketplacesPage(), ROUTES);
    expect(screen.getByText("Official marketplace")).toBeTruthy();
    expect(browser).toEqual([]);
  });

  it("/admin/marketplaces/entries: the entries for the query's source and search", async () => {
    const browser = expectNoFirstPaintFetch();
    const { calls } = await renderRoute(
      () =>
        MarketplaceEntriesPage({
          searchParams: Promise.resolve({ sourceId: "official", q: " crm " }),
        }),
      ROUTES,
    );
    expect(calls.map((c) => c.url)).toContain(
      "/api/v1/admin/marketplaces/entries?sourceId=official&q=crm",
    );
    expect(screen.getByText("crm")).toBeTruthy();
    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("crm");
    expect(browser).toEqual([]);
  });

  it("/admin/marketplaces/entries: typing in the search reads in the browser (user-triggered)", async () => {
    expectNoFirstPaintFetch();
    await renderRoute(() => MarketplaceEntriesPage({ searchParams: Promise.resolve({}) }), ROUTES);
    const browser = stubApi({
      "GET /api/v1/admin/marketplaces/entries": () => json(200, { items: [] }),
    });
    await userEvent.setup().type(screen.getByRole("searchbox"), "zzz");
    await vi.waitFor(() =>
      expect(browser.map((c) => c.url)).toEqual(["/api/v1/admin/marketplaces/entries?q=zzz"]),
    );
  });

  it("a failing required read is the error state with a retry, not an empty page (not read again on mount)", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRouteWithCache("/admin/orgs", { ...ROUTES, "GET /api/v1/admin/settings": failing });
    expect(template("StatusPage")).not.toBeNull();
    expect(screen.queryByText("Beta")).toBeNull();
    await settle();
    expect(browser).toEqual([]);
  });
});

type Page = () => Promise<ReactNode>;
const item =
  (itemId: string): Page =>
  () =>
    AdminCatalogItemPage({ params: Promise.resolve({ itemId }) });
/** The migrated pages (the query cache's gate). */
const CACHED: string[] = [
  "/admin",
  "/admin/accounts",
  "/admin/orgs",
  "/admin/settings",
  "/admin/models",
  "/admin/extensions",
  "/admin/extensions/install",
  "/admin/extensions/demo",
];
const PAGES: [string, Page][] = [
  ["/admin/catalog", () => AdminCatalogPage()],
  ["/admin/catalog/[itemId]", item(ITEM_ID)],
  ["/admin/catalog/import", () => PluginImportPage({ searchParams: Promise.resolve({}) })],
  ["/admin/catalog/requests", () => CatalogRequestsPage()],
  ["/admin/marketplaces", () => MarketplacesPage()],
  [
    "/admin/marketplaces/entries",
    () => MarketplaceEntriesPage({ searchParams: Promise.resolve({}) }),
  ],
];

describe("the enterprise-admin gate", () => {
  it.each(CACHED)("%s: a non-admin gets no access and only the session is read", async (path) => {
    const r = await renderRouteWithCache(path, ROUTES, { me: NOT_ADMIN });
    expect(new Set(r.calls.map((c) => c.url))).toEqual(
      new Set(["/api/v1/me", "/api/v1/orgs/o1/readiness"]),
    );
    expect(noAccess()).toBe(true);
  });

  it.each(CACHED)("%s: an admin needs no org", async (path) => {
    const r = await renderRouteWithCache(path, ROUTES, { me: { ...ME, currentOrgId: null } });
    expect(noAccess()).toBe(false);
    expect(r.calls.map((c) => c.url)).toContain("/api/v1/me");
    expect(document.querySelector("[data-template]")).not.toBeNull();
  });

  it.each(PAGES)(
    "%s: a non-admin gets no access and only the session is read",
    async (_p, page) => {
      const r = await renderRoute(page, ROUTES, { me: NOT_ADMIN });
      expect(r.calls.map((c) => c.url)).toEqual(["/api/v1/me"]);
      expect(noAccess()).toBe(true);
    },
  );
});

describe("accounts: load more stays in the browser", () => {
  it("appends the next page and drops the button at the end", async () => {
    expectNoFirstPaintFetch();
    const { calls } = await renderRouteWithCache("/admin/accounts", ROUTES);
    const browser = stubApi({
      "GET /api/v1/admin/accounts": () =>
        json(200, { accounts: [ACCOUNT("a3", "Carol")], next: null }),
    });
    await userEvent.setup().click(screen.getByRole("button", { name: en.admin.accounts.loadMore }));
    expect(await screen.findByText("Carol")).toBeTruthy();
    expect(screen.queryByRole("button", { name: en.admin.accounts.loadMore })).toBeNull();
    expect(browser.map((c) => c.url)).toEqual(["/api/v1/admin/accounts?limit=200&after=a2"]);
    expect(calls.filter((c) => c.url.startsWith("/api/v1/admin/accounts")).length).toBe(1);
  });
});
