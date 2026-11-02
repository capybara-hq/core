// The admin console renders on the server (web-SSR spec §6, task 10): first paint complete without a
// browser fetch, the enterprise-admin gate (only the session is read below it), and R5's failures.
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import AdminAccountsPage from "../src/app/(app)/admin/accounts/page";
import AdminCatalogItemPage from "../src/app/(app)/admin/catalog/[itemId]/page";
import PluginImportPage from "../src/app/(app)/admin/catalog/import/page";
import AdminCatalogPage from "../src/app/(app)/admin/catalog/page";
import CatalogRequestsPage from "../src/app/(app)/admin/catalog/requests/page";
import ExtensionDetailPage from "../src/app/(app)/admin/extensions/[name]/page";
import ExtensionInstallPage from "../src/app/(app)/admin/extensions/install/page";
import AdminExtensionsPage from "../src/app/(app)/admin/extensions/page";
import MarketplaceEntriesPage from "../src/app/(app)/admin/marketplaces/entries/page";
import MarketplacesPage from "../src/app/(app)/admin/marketplaces/page";
import AdminModelsPage from "../src/app/(app)/admin/models/page";
import AdminOrgsPage from "../src/app/(app)/admin/orgs/page";
import AdminOverviewPage from "../src/app/(app)/admin/page";
import AdminSettingsPage from "../src/app/(app)/admin/settings/page";
import { json, stubApi } from "./support/api";
import { resetNavigation, router } from "./support/navigation";
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

describe("first paint comes from the server (no browser fetch)", () => {
  it("/admin: the four numbers", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRoute(() => AdminOverviewPage(), ROUTES);
    expect(screen.getByText("7")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
    expect(browser).toEqual([]);
  });

  it("/admin/accounts: the first page, with load more when there is a next", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRoute(() => AdminAccountsPage(), ROUTES);
    expect(screen.getByText("Alice")).toBeTruthy();
    expect(screen.getByRole("button", { name: en.admin.accounts.loadMore })).toBeTruthy();
    expect(browser).toEqual([]);
  });

  it("/admin/orgs: the orgs with the deployment overrides", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRoute(() => AdminOrgsPage(), ROUTES);
    expect(screen.getByText("Beta")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
    expect(browser).toEqual([]);
  });

  it("/admin/settings and /admin/models", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRoute(() => AdminSettingsPage(), ROUTES);
    expect(screen.getByDisplayValue("USD")).toBeTruthy();
    cleanup();
    await renderRoute(() => AdminModelsPage(), ROUTES);
    expect(screen.getByText(en.models.admin.noProviders)).toBeTruthy();
    expect(browser).toEqual([]);
  });

  it("/admin/extensions: the list", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRoute(() => AdminExtensionsPage(), ROUTES);
    expect(screen.getByText("demo")).toBeTruthy();
    expect(browser).toEqual([]);
  });

  it("/admin/extensions/install: ?upgrade= comes from the query, the installed list from the server", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRoute(
      () => ExtensionInstallPage({ searchParams: Promise.resolve({ upgrade: "demo" }) }),
      ROUTES,
    );
    expect(
      screen.getByText(en.admin.extensions.wizard.upgradeTitle.replace("{name}", "demo")),
    ).toBeTruthy();
    cleanup();
    await renderRoute(() => ExtensionInstallPage({ searchParams: Promise.resolve({}) }), ROUTES);
    expect(screen.getByText(en.admin.extensions.wizard.title)).toBeTruthy();
    expect(browser).toEqual([]);
  });

  it("/admin/extensions/[name]: the extension and its config, with no browser fetch", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRoute(detail("demo"), ROUTES);
    await userEvent
      .setup()
      .click(screen.getByRole("tab", { name: en.admin.extensions.detail.tabs.config }));
    expect((screen.getByLabelText("region") as HTMLInputElement).value).toBe("eu-1");
    expect(browser).toEqual([]);
  });

  it("/admin/extensions/[name]: a config the kernel fails is the tab's own error, retried on the server", async () => {
    const browser = expectNoFirstPaintFetch();
    const { calls } = await renderRoute(detail("demo"), {
      ...ROUTES,
      "GET /api/v1/admin/extensions/demo/config": failing,
    });
    expect(screen.getByText("demo", { selector: "h1" })).toBeTruthy();
    const u = userEvent.setup();
    await u.click(screen.getByRole("tab", { name: en.admin.extensions.detail.tabs.config }));
    await u.click(screen.getByRole("button", { name: en.admin.extensions.retry }));
    expect(router.refresh).toHaveBeenCalled();
    expect(calls.filter((c) => c.url.endsWith("/demo/config")).length).toBe(2);
    expect(browser).toEqual([]);
  });

  it("/admin/extensions/[name]: an extension not in the list is not found", async () => {
    expectNoFirstPaintFetch();
    await renderRoute(detail("ghost"), {
      ...ROUTES,
      "GET /api/v1/admin/extensions/ghost/config": () =>
        json(404, { error: { code: "extension.not_found", message: "x" } }),
    });
    expect(screen.getByText(en.admin.extensions.detail.notFound)).toBeTruthy();
  });

  it("enabling an extension renders the page again on the server (the org's readiness may change)", async () => {
    expectNoFirstPaintFetch();
    const browser = stubApi({
      "POST /api/v1/admin/extensions/demo/enable": () =>
        json(
          200,
          ext({ status: "enabled", desired: { version: "1.0.0", sha256: SHA, state: "enabled" } }),
        ),
    });
    const { calls } = await renderRoute(detail("demo"), ROUTES);
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: en.admin.extensions.detail.actions.enable }));
    await vi.waitFor(() => expect(router.refresh).toHaveBeenCalled());
    await vi.waitFor(() =>
      expect(calls.filter((c) => c.url === "/api/v1/admin/extensions").length).toBe(2),
    );
    expect(browser.map((c) => c.method)).toEqual(["POST"]);
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

  it("a failing required read is an error, not an empty page", async () => {
    expectNoFirstPaintFetch();
    await expect(
      renderRoute(() => AdminOrgsPage(), { ...ROUTES, "GET /api/v1/admin/settings": failing }),
    ).rejects.toThrow();
  });
});

type Page = () => Promise<ReactNode>;
const detail =
  (name: string): Page =>
  () =>
    ExtensionDetailPage({ params: Promise.resolve({ name }) });
const item =
  (itemId: string): Page =>
  () =>
    AdminCatalogItemPage({ params: Promise.resolve({ itemId }) });
const PAGES: [string, Page][] = [
  ["/admin", () => AdminOverviewPage()],
  ["/admin/accounts", () => AdminAccountsPage()],
  ["/admin/orgs", () => AdminOrgsPage()],
  ["/admin/settings", () => AdminSettingsPage()],
  ["/admin/models", () => AdminModelsPage()],
  ["/admin/catalog", () => AdminCatalogPage()],
  ["/admin/catalog/[itemId]", item(ITEM_ID)],
  ["/admin/catalog/import", () => PluginImportPage({ searchParams: Promise.resolve({}) })],
  ["/admin/catalog/requests", () => CatalogRequestsPage()],
  ["/admin/marketplaces", () => MarketplacesPage()],
  [
    "/admin/marketplaces/entries",
    () => MarketplaceEntriesPage({ searchParams: Promise.resolve({}) }),
  ],
  ["/admin/extensions", () => AdminExtensionsPage()],
  ["/admin/extensions/install", () => ExtensionInstallPage({ searchParams: Promise.resolve({}) })],
  ["/admin/extensions/[name]", detail("demo")],
];

describe("the enterprise-admin gate", () => {
  it.each(PAGES)(
    "%s: a non-admin gets no access and only the session is read",
    async (_p, page) => {
      const r = await renderRoute(page, ROUTES, { me: NOT_ADMIN });
      expect(r.calls.map((c) => c.url)).toEqual(["/api/v1/me"]);
      expect(noAccess()).toBe(true);
    },
  );

  it("an admin needs no org: nothing is redirected", async () => {
    await renderRoute(() => AdminOverviewPage(), ROUTES, { me: { ...ME, currentOrgId: null } });
    expect(noAccess()).toBe(false);
  });
});

describe("accounts: load more stays in the browser", () => {
  it("appends the next page and drops the button at the end", async () => {
    expectNoFirstPaintFetch();
    const { calls } = await renderRoute(() => AdminAccountsPage(), ROUTES);
    const browser = (await import("./support/api")).stubApi({
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
