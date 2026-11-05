// The admin console reads from the query cache the layout prefetched (web query cache spec §3):
// first paint complete without a browser read, the loading state on an empty cache, the
// enterprise-admin gate (only the session is read below it), R5's failures and the mutations'
// cache updates.
import { act, cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import { bodyOf, json, stubApi } from "./support/api";
import { resetNavigation, router } from "./support/navigation";
import { renderRouteEmptyCache, renderRouteWithCache, testQueryClient } from "./support/query";
import { ME } from "./support/render";
import { expectNoFirstPaintFetch, type Routes } from "./support/server";

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
  scope: "optional",
  scopeOrgs: [],
  builtin: false,
  disabled: false,
  shownToOthers: true,
  enabledOrgs: 0,
  pending: false,
  permissionsHash: null,
  latestVersion: "1.0.0",
  versions: ["1.0.0"],
  installs: 2,
  source: "marketplace",
  marketplaceId: "official",
  latestMarketplaceVersion: "1.0.0",
  newerInMarketplace: false,
  contentChanged: false,
  componentCounts: { extension: 0, skills: 1, connectorTemplates: 0, agentTemplates: 0 },
  sourceFormat: "capybara",
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
  "GET /api/v1/admin/catalog/items?pending=true": () => json(200, { items: [], nextOffset: null }),
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
          kind: "access",
          entry: null,
          status: "pending",
          note: "",
          reason: null,
          requestedBy: "a2",
          requestedByName: "Mia",
          decidedBy: null,
          decidedAt: null,
          stagingId: null,
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
async function renderHeld(
  path: string,
  held: string,
  routes: Routes = ROUTES,
  opts: Parameters<typeof renderRouteEmptyCache>[2] = {},
) {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const answer = routes[held];
  if (answer === undefined) throw new Error(`no route ${held}`);
  const r = await renderRouteEmptyCache(
    path,
    {
      ...routes,
      [held]: async (c) => {
        await gate;
        return answer(c);
      },
    },
    opts,
  );
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

describe("first paint comes from the hydrated cache (no browser read)", () => {
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

  it.each([
    ["/admin/models", "GET /api/v1/admin/models"],
    ["/admin/plugins/sources", "GET /api/v1/admin/marketplaces"],
  ])(
    "%s: the loading page announces once (its sections inside one busy region)",
    async (path, held) => {
      const { release } = await renderHeld(path, held);
      await vi.waitFor(() => {
        if (document.querySelector("[aria-busy='true']") === null) throw new Error("not loading");
      });
      expect(document.querySelectorAll(".cb-form-section").length).toBe(2);
      // one busy announcer (the toasts' live region is no announcer of the page)
      expect(document.querySelectorAll("[role='status'][aria-busy='true']")).toHaveLength(1);
      expect(screen.getAllByText("Loading")).toHaveLength(1);
      await release();
    },
  );

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

  it("/admin/settings: a save invalidates the models page (its currency) and /me when org creation changes", async () => {
    const calls = stubApi({
      ...ROUTES,
      "PUT /api/v1/admin/settings": (c) => json(200, { ...SETTINGS, ...(bodyOf(c) as object) }),
    });
    const { client } = await renderRouteWithCache("/admin/settings", ROUTES);
    await client.prefetchQuery({
      queryKey: ["deployment", "adminModels"],
      queryFn: () => ({ providers: [], prices: [], currency: "USD" }),
    });
    const u = userEvent.setup();
    await u.click(
      screen.getByRole("radio", {
        name: new RegExp(`^${en.admin.settings.orgCreation.enterprise_admin}`),
      }),
    );
    await u.click(screen.getByRole("button", { name: en.admin.settings.save }));
    await vi.waitFor(() =>
      expect(client.getQueryState(["deployment", "adminModels"])?.isInvalidated).toBe(true),
    );
    // /me (whether the account may create an org) is on screen: it is read again
    await vi.waitFor(() =>
      expect(calls.map((c) => `${c.method} ${c.url}`)).toContain("GET /api/v1/me"),
    );
    expect(calls[0]?.method).toBe("PUT");
  });

  it("/admin/orgs: saving an org's limits invalidates that org's settings and the models page", async () => {
    stubApi({
      ...ROUTES,
      "PUT /api/v1/admin/settings": () => json(200, SETTINGS),
    });
    const { client } = await renderRouteWithCache("/admin/orgs", ROUTES);
    for (const queryKey of [
      ["org", "o2", "orgSettings"],
      ["deployment", "adminModels"],
    ])
      await client.prefetchQuery({ queryKey, queryFn: () => ({}) });
    const u = userEvent.setup();
    const row = screen.getByText("Beta").closest("tr") as HTMLElement;
    await u.click(within(row).getByRole("button", { name: "Row actions" }));
    await u.click(await screen.findByRole("menuitem", { name: en.admin.orgs.edit }));
    const dialog = await screen.findByRole("dialog");
    await u.click(within(dialog).getByRole("button", { name: en.admin.orgs.dialog.save }));
    await vi.waitFor(() =>
      expect(client.getQueryState(["org", "o2", "orgSettings"])?.isInvalidated).toBe(true),
    );
    expect(client.getQueryState(["deployment", "adminModels"])?.isInvalidated).toBe(true);
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

  it("/admin/extensions/[name]: the loading overview is its facts, its buttons and the replicas table", async () => {
    const { release } = await renderHeld("/admin/extensions/demo", "GET /api/v1/admin/extensions");
    await expectLoading("DetailPage", "v1.0.0");
    expect(document.querySelectorAll('[data-part="loading-card"]')).toHaveLength(0);
    const kv = document.querySelector('[data-part="loading-key-value"]');
    expect(kv?.getAttribute("data-columns")).toBe("2");
    expect(screen.getByText(en.admin.extensions.detail.replicasTitle)).toBeTruthy();
    expect(screen.getByText(en.admin.extensions.detail.replicaColumns.heartbeat)).toBeTruthy();
    expect(
      screen
        .getByRole("tab", { name: en.admin.extensions.detail.tabs.overview })
        .getAttribute("aria-selected"),
    ).toBe("true");
    await release();
  });

  it("/admin/extensions/[name]: a cached pending-config extension loads on its config tab", async () => {
    const client = testQueryClient();
    // the extension is cached (its poll entry) while the list is still on its way
    client.setQueryData(["deployment", "extension", "demo"], ext({ status: "pending_config" }));
    const { release } = await renderHeld(
      "/admin/extensions/demo",
      "GET /api/v1/admin/extensions",
      ROUTES,
      { client },
    );
    await expectLoading("DetailPage", "v1.0.0");
    expect(
      screen
        .getByRole("tab", { name: en.admin.extensions.detail.tabs.config })
        .getAttribute("aria-selected"),
    ).toBe("true");
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

  it("/admin/plugins: a first render from the hydrated cache makes no browser read (sources from the marketplaces)", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRouteWithCache("/admin/plugins", ROUTES);
    expect(screen.getByText(/^v[^ ]+ · .* orgs? using it$/)).toBeTruthy();
    await settle();
    expect(browser).toEqual([]);
  });

  it("/admin/plugins: marketplaces the kernel fails only drop the source labels (not read again on mount)", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRouteWithCache("/admin/plugins", {
      ...ROUTES,
      "GET /api/v1/admin/marketplaces": failing,
    });
    expect(screen.getByText(/^v[^ ]+ · .* orgs? using it$/)).toBeTruthy();
    await settle();
    expect(browser).toEqual([]);
  });

  it("/admin/plugins/[itemId]: a first render from the hydrated cache makes no browser read (dependencies, sources)", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRouteWithCache(`/admin/plugins/${ITEM_ID}`, ROUTES);
    expect(screen.getByRole("heading", { name: "crm" })).toBeTruthy();
    expect(screen.getByText(/crm-core/)).toBeTruthy();
    await settle();
    expect(browser).toEqual([]);
  });

  it("/admin/plugins/[itemId]: a missing item is the not-found state in the shell; a failing catalog only leaves dependencies unchecked", async () => {
    expectNoFirstPaintFetch();
    await renderRouteWithCache(`/admin/plugins/${ITEM_ID}`, {
      ...ROUTES,
      [`GET /api/v1/admin/catalog/items/${ITEM_ID}`]: () =>
        json(404, { error: { code: "catalog.item_not_found", message: "x" } }),
    });
    expect(template("StatusPage")?.getAttribute("data-kind")).toBe("404");
    cleanup();
    await renderRouteWithCache(`/admin/plugins/${ITEM_ID}`, {
      ...ROUTES,
      "GET /api/v1/admin/catalog/items": failing,
    });
    expect(screen.getByText(/crm-core/)).toBeTruthy();
    expect(screen.queryByText(/not in the catalog/)).toBeNull();
  });

  it("/admin/plugins/pending: a first render from the hydrated cache makes no browser read", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRouteWithCache("/admin/plugins/pending", ROUTES);
    expect(screen.getAllByText("Acme · crm").length).toBeGreaterThan(0);
    await settle();
    expect(browser).toEqual([]);
  });

  it("/admin/plugins/import: no staging starts at the source step; ?staging= opens the review from the cache", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRouteWithCache("/admin/plugins/import", ROUTES);
    expect(
      screen.getByLabelText(en.catalog.admin.review.sourceLabel, { exact: false }),
    ).toBeTruthy();
    cleanup();
    const { calls } = await renderRouteWithCache("/admin/plugins/import?staging=st1", ROUTES);
    expect(calls.map((c) => c.url)).toContain("/api/v1/admin/catalog/imports/st1");
    expect(screen.getByText("@acme/plugin-crm", { exact: false })).toBeTruthy();
    await settle();
    expect(browser).toEqual([]);
  });

  it("/admin/plugins/import: an expired staging is the page's own problem with a restart, not a not-found", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRouteWithCache("/admin/plugins/import?staging=gone", {
      ...ROUTES,
      "GET /api/v1/admin/catalog/imports/gone": () =>
        json(404, { error: { code: "plugin.staging_not_found", message: "gone" } }),
    });
    expect(screen.getByText(en.catalog.admin.review.gone)).toBeTruthy();
    expect(screen.getByRole("button", { name: en.catalog.admin.review.restart })).toBeTruthy();
    await settle();
    expect(browser).toEqual([]);
  });

  it.each([
    ["/admin/plugins", "GET /api/v1/admin/catalog/items", "ListPage", "using it"],
    [
      `/admin/plugins/${ITEM_ID}`,
      `GET /api/v1/admin/catalog/items/${ITEM_ID}`,
      "DetailPage",
      "Acme",
    ],
    ["/admin/plugins/pending", "GET /api/v1/admin/catalog/requests", "ListPage", "Acme · crm"],
    [
      "/admin/plugins/import?staging=st1",
      "GET /api/v1/admin/catalog/imports/st1",
      "WizardPage",
      "@acme/plugin-crm",
    ],
  ])(
    "%s: an empty cache shows the template's loading state, then the data",
    async (path, held, name, text) => {
      const { release } = await renderHeld(path, held);
      await expectLoading(name, text);
      await release();
      expect((await screen.findAllByText(text, { exact: false })).length).toBeGreaterThan(0);
      await vi.waitFor(() => expect(document.querySelector("[aria-busy='true']")).toBeNull());
    },
  );

  it("/admin/plugins/[itemId]: the loading detail is the components and the inspector's six facts", async () => {
    const { release } = await renderHeld(
      `/admin/plugins/${ITEM_ID}`,
      `GET /api/v1/admin/catalog/items/${ITEM_ID}`,
    );
    await expectLoading("DetailPage", "Acme");
    expect(document.querySelectorAll('[data-part="loading-card"]')).toHaveLength(0);
    expect(document.querySelectorAll('[data-part="loading-inspector-row"]')).toHaveLength(6);
    await release();
  });

  it("/admin/plugins/import?staging=: the loading review is a stack (no wizard card)", async () => {
    const { release } = await renderHeld(
      "/admin/plugins/import?staging=st1",
      "GET /api/v1/admin/catalog/imports/st1",
    );
    await expectLoading("WizardPage", "@acme/plugin-crm");
    expect(document.querySelector('[data-template="WizardPage"] [data-part="card"]')).toBeNull();
    expect(document.querySelectorAll('[data-part="loading-field"]')).toHaveLength(0);
    await release();
  });

  it("/admin/plugins/pending: a decision invalidates the requests and the overview", async () => {
    const calls = stubApi({
      ...ROUTES,
      "POST /api/v1/admin/catalog/requests/r1/decide": () =>
        json(200, { request: { id: "r1", status: "approved" } }),
    });
    const { client } = await renderRouteWithCache("/admin/plugins/pending", ROUTES);
    await client.prefetchQuery({
      queryKey: ["deployment", "adminOverview"],
      queryFn: () => ({
        extensionsNeedingAction: 0,
        catalogRequestsPending: 1,
        orgs: 0,
        accounts: 0,
      }),
    });
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: en.catalog.admin.pending.approve }));
    await vi.waitFor(() =>
      expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(
        expect.arrayContaining([
          "POST /api/v1/admin/catalog/requests/r1/decide",
          "GET /api/v1/admin/catalog/requests?status=pending",
        ]),
      ),
    );
    expect(client.getQueryState(["deployment", "adminOverview"])?.isInvalidated).toBe(true);
  });

  it("/admin/plugins/sources: a first render from the hydrated cache makes no browser read", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRouteWithCache("/admin/plugins/sources", ROUTES);
    expect(screen.getByText("Official marketplace")).toBeTruthy();
    await settle();
    expect(browser).toEqual([]);
  });

  it("/admin/plugins/market: the entries for the query's source and search come from the cache", async () => {
    const browser = expectNoFirstPaintFetch();
    const { calls } = await renderRouteWithCache(
      "/admin/plugins/market?sourceId=official&q=%20crm%20",
      ROUTES,
    );
    expect(calls.map((c) => c.url)).toContain(
      "/api/v1/admin/marketplaces/entries?sourceId=official&q=crm",
    );
    expect(screen.getByText("crm")).toBeTruthy();
    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("crm");
    await settle();
    expect(browser).toEqual([]);
  });

  it("/admin/plugins/market: typing in the search reads in the browser, its own cache entry", async () => {
    const { client } = await renderRouteWithCache("/admin/plugins/market", ROUTES);
    const browser = stubApi({
      "GET /api/v1/admin/marketplaces/entries": () => json(200, { items: [] }),
    });
    await userEvent.setup().type(screen.getByRole("searchbox"), "zzz");
    await vi.waitFor(() =>
      expect(browser.map((c) => c.url)).toEqual(["/api/v1/admin/marketplaces/entries?q=zzz"]),
    );
    expect(await screen.findByText(en.catalog.admin.entries.noResults)).toBeTruthy();
    // the unfiltered entries stay in their own entry
    expect(
      (client.getQueryData(["deployment", "marketplaceEntries", "", ""]) as { items: unknown[] })
        .items,
    ).toHaveLength(1);
  });

  it("/admin/plugins/sources: an empty cache shows the template's loading state, then the data", async () => {
    const { release } = await renderHeld(
      "/admin/plugins/sources",
      "GET /api/v1/admin/marketplaces",
    );
    await expectLoading("ListPage", "CRM plugin");
    // the two static sections stay, their fields placeholders
    expect(
      screen.getByRole("heading", { name: en.catalog.admin.marketplaces.official }),
    ).toBeTruthy();
    expect(screen.queryByDisplayValue(MARKETPLACE.url)).toBeNull();
    await release();
    expect(await screen.findByDisplayValue(MARKETPLACE.url)).toBeTruthy();
    await vi.waitFor(() => expect(document.querySelector("[aria-busy='true']")).toBeNull());
  });

  it("/admin/plugins/market: an empty cache shows the template's loading state, then the data", async () => {
    const { release } = await renderHeld(
      "/admin/plugins/market",
      "GET /api/v1/admin/marketplaces/entries",
    );
    await expectLoading("ListPage", "CRM plugin");
    await release();
    expect(await screen.findByText("CRM plugin")).toBeTruthy();
    await vi.waitFor(() => expect(document.querySelector("[aria-busy='true']")).toBeNull());
  });

  it("/admin/plugins/sources: turning a marketplace off writes the answer into the cache and invalidates the entries", async () => {
    const calls = stubApi({
      ...ROUTES,
      "PATCH /api/v1/admin/marketplaces/official": () =>
        json(200, { ...MARKETPLACE, enabled: false }),
    });
    const { client } = await renderRouteWithCache("/admin/plugins/sources", ROUTES);
    await client.prefetchQuery({
      queryKey: ["deployment", "marketplaceEntries", "", ""],
      queryFn: () => ({ items: [] }),
    });
    await userEvent.setup().click(screen.getByRole("switch"));
    await vi.waitFor(() =>
      expect(
        (client.getQueryData(["deployment", "marketplaces"]) as { items: { enabled: boolean }[] })
          .items[0]?.enabled,
      ).toBe(false),
    );
    expect(client.getQueryState(["deployment", "marketplaceEntries", "", ""])?.isInvalidated).toBe(
      true,
    );
    // the list is not read again (the answer is the marketplace)
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "PATCH /api/v1/admin/marketplaces/official",
    ]);
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

/** The admin console's pages (the gate from the query cache). */
const CACHED: string[] = [
  "/admin",
  "/admin/accounts",
  "/admin/orgs",
  "/admin/settings",
  "/admin/models",
  "/admin/extensions",
  "/admin/extensions/demo",
  "/admin/plugins",
  `/admin/plugins/${ITEM_ID}`,
  "/admin/plugins/import",
  "/admin/plugins/pending",
  "/admin/plugins/sources",
  "/admin/plugins/market",
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
