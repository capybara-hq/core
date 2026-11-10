import { describeNestedBox, findNestedBoxes } from "@capybara-hq/design/reference";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { declaredPermissions, type StaticExtensionManifest } from "../src/lib/catalog";
import { keys } from "../src/lib/query/keys";
import { bodyOf, type Call, json, lastStubRoutes, stubApi } from "./support/api";
import { resetNavigation } from "./support/navigation";
import { renderRouteWithCache } from "./support/query";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

/**
 * Client code on the admin console (client extensions spec §5.4, §10.2, §10.4): 插件界面代码 on
 * 平台设置 (the kill switch and the per-plugin list), 界面代码 on the extension detail (build,
 * files, sizes, reports, 停用界面代码), and the org-upload confirm's 客户端代码 group.
 */

const K = en.admin.settings.clientCode;
const C = en.admin.extensions.clientCode;
const SHA = "b".repeat(64);
const fill = (s: string, vars: Record<string, string | number>) =>
  s.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k]));

const SETTINGS = {
  orgCreation: "anyone",
  runConcurrencyOverrides: {},
  priceCurrency: "USD",
  sandboxLimitOverrides: {},
  customConnectors: "allow",
  customSkills: "allow",
  clientExtensions: { enabled: true, disabled: [] as string[] },
};

const CLIENT = {
  build: SHA,
  files: [
    { path: "client.mjs", bytes: 2048 },
    { path: "styles/neon.css", bytes: 512 },
  ],
  apiVersion: 1,
};

function ext(over: Record<string, unknown> = {}) {
  return {
    name: "theme-neon",
    displayName: { en: "Neon theme", zh: "霓虹主题" },
    version: "1.0.0",
    source: "install",
    installSource: "file",
    required: false,
    sha256: SHA,
    status: "enabled",
    desired: { version: "1.0.0", sha256: SHA, state: "enabled" },
    replicas: [],
    permissions: [
      {
        category: "client",
        sensitive: true,
        items: ["client code"],
        entries: [{ value: "client code", sensitive: true, reason: "client_code" }],
      },
    ],
    added: [],
    addedItems: [],
    removed: [],
    reviewHash: "0123456789abcdef",
    sensitive: true,
    warnings: [],
    snapshot: null,
    configurable: false,
    configValid: true,
    removable: true,
    uiDropped: [],
    client: CLIENT,
    clientReports: [
      {
        orgId: "o1",
        contribution: "brand",
        kind: "render",
        count: 4,
        firstAt: "2026-11-08T08:00:00.000Z",
        lastAt: "2026-11-09T08:00:00.000Z",
        lastMessage: "Cannot read properties of undefined",
      },
    ],
    ...over,
  };
}

const settingsRoutes = (extra: Record<string, (c: Call) => Response> = {}) =>
  stubApi({
    "GET /api/v1/admin/settings": () => json(200, SETTINGS),
    "GET /api/v1/admin/components?kind=theme": () => json(200, { components: [] }),
    "GET /api/v1/admin/ui/arrangement": () => json(200, { slots: [] }),
    "GET /api/v1/admin/extensions": () =>
      json(200, {
        extensions: [ext(), ext({ name: "plain", displayName: null, client: null })],
        drainSeconds: 30,
      }),
    "PUT /api/v1/admin/settings": (c) =>
      json(200, {
        ...SETTINGS,
        clientExtensions: {
          ...SETTINGS.clientExtensions,
          ...(bodyOf(c) as { clientExtensions: object }).clientExtensions,
        },
      }),
    ...extra,
  });

beforeEach(() => resetNavigation("/admin/settings"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("插件界面代码 on /admin/settings", () => {
  it("the kill switch writes clientExtensions.enabled and invalidates the client set", async () => {
    const calls = settingsRoutes();
    const { client } = await renderRouteWithCache("/admin/settings", lastStubRoutes());
    client.setQueryData(keys.org("o1").clientExtensions(), { enabled: true, items: [] });
    client.setQueryData(keys.deployment().clientExtensions("theme-neon"), {
      enabled: true,
      items: [],
    });
    const section = (await screen.findByRole("heading", { name: K.title })).closest(
      "section",
    ) as HTMLElement;
    // one switch for all, one per plugin with client code (a plugin without any is not listed)
    expect(within(section).getByRole("switch", { name: K.all }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(
      within(section).getByRole("switch", { name: fill(K.pluginLabel, { name: "Neon theme" }) }),
    ).toBeTruthy();
    expect(within(section).queryByText("plain")).toBeNull();
    const neonRow = () =>
      within(section)
        .getByRole("switch", { name: fill(K.pluginLabel, { name: "Neon theme" }) })
        .closest("li") as HTMLElement;
    expect(within(neonRow()).getByText(K.pluginOnHint)).toBeTruthy();
    const user = userEvent.setup();
    await user.click(within(section).getByRole("switch", { name: K.all }));
    expect(within(section).getByText(K.allOffHint)).toBeTruthy();
    // with every plugin's interface code off, no plugin row says it is running
    expect(within(neonRow()).queryByText(K.pluginOnHint)).toBeNull();
    expect(within(neonRow()).getByText(K.pluginAllOffHint)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: en.admin.settings.save }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(bodyOf(calls.find((c) => c.method === "PUT"))).toEqual({
      clientExtensions: { enabled: false },
    });
    await waitFor(() =>
      expect(client.getQueryState(keys.org("o1").clientExtensions())?.isInvalidated).toBe(true),
    );
    expect(
      client.getQueryState(keys.deployment().clientExtensions("theme-neon"))?.isInvalidated,
    ).toBe(true);
    expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
  });

  it("a plugin's switch writes the disabled list; a stopped plugin stays listed (zh)", async () => {
    const calls = settingsRoutes({
      "GET /api/v1/admin/settings": () =>
        json(200, { ...SETTINGS, clientExtensions: { enabled: true, disabled: ["gone"] } }),
    });
    await renderRouteWithCache("/admin/settings", lastStubRoutes(), { locale: "zh" });
    const z = zh.admin.settings.clientCode;
    const section = (await screen.findByRole("heading", { name: z.title })).closest(
      "section",
    ) as HTMLElement;
    // a plugin still listed as stopped, though not installed any more
    expect(
      within(section)
        .getByRole("switch", { name: fill(z.pluginLabel, { name: "gone" }) })
        .getAttribute("aria-checked"),
    ).toBe("false");
    const user = userEvent.setup();
    await user.click(
      within(section).getByRole("switch", { name: fill(z.pluginLabel, { name: "霓虹主题" }) }),
    );
    await user.click(screen.getByRole("button", { name: zh.admin.settings.save }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(bodyOf(calls.find((c) => c.method === "PUT"))).toEqual({
      clientExtensions: { disabled: ["gone", "theme-neon"] },
    });
  });
});

const ACME = {
  id: "o1",
  slug: "acme",
  name: "Acme",
  createdAt: "2026-11-01T00:00:00.000Z",
  memberCount: 3,
};

const detailRoutes = (
  view: Record<string, unknown>,
  extra: Record<string, (c: Call) => Response> = {},
) =>
  stubApi({
    "GET /api/v1/admin/extensions": () => json(200, { extensions: [view], drainSeconds: 30 }),
    [`GET /api/v1/admin/extensions/${String(view.name)}/config`]: () =>
      json(200, {
        plugin: view.name,
        version: "1.0.0",
        configurable: false,
        schema: null,
        fields: [],
        valid: true,
        validated: true,
        issues: [],
      }),
    "GET /api/v1/admin/settings": () => json(200, SETTINGS),
    // the reports name orgs: the list is read with the extension
    "GET /api/v1/admin/orgs": () => json(200, { orgs: [ACME], limitDefaults: {} }),
    "PUT /api/v1/admin/settings": (c) =>
      json(200, {
        ...SETTINGS,
        clientExtensions: {
          enabled: true,
          ...(bodyOf(c) as { clientExtensions: object }).clientExtensions,
        },
      }),
    ...extra,
  });

describe("界面代码 on /admin/extensions/[name]", () => {
  beforeEach(() => resetNavigation("/admin/extensions/theme-neon"));

  it("the extension detail lists the build and reports and 停用界面代码 writes disabled", async () => {
    const calls = detailRoutes(ext());
    const { client } = await renderRouteWithCache("/admin/extensions/theme-neon", lastStubRoutes());
    client.setQueryData(keys.org("o1").clientExtensions(), { enabled: true, items: [] });
    expect(await screen.findByText(C.title)).toBeTruthy();
    // the settings were read on the server (the extension has client code): no browser read
    expect(calls.some((c) => c.url === "/api/v1/admin/settings" && c.method === "GET")).toBe(false);
    expect(screen.getByText(C.running)).toBeTruthy();
    expect(screen.getByText(SHA.slice(0, 12))).toBeTruthy();
    expect(screen.getByText("2 files · 2.5 KB")).toBeTruthy();
    const files = screen.getByRole("table", { name: C.filesTitle });
    expect(within(files).getByText("client.mjs")).toBeTruthy();
    expect(within(files).getByText("styles/neon.css")).toBeTruthy();
    const reports = screen.getByRole("table", { name: C.reportsTitle });
    const row = within(reports).getByRole("row", { name: /Cannot read properties/ });
    expect(within(row).getByText(C.kind.render)).toBeTruthy();
    expect(within(row).getByText("brand")).toBeTruthy();
    expect(within(row).getByText("4")).toBeTruthy();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: C.stop }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(bodyOf(calls.find((c) => c.method === "PUT"))).toEqual({
      clientExtensions: { disabled: ["theme-neon"] },
    });
    // the answer is the setting now: the state and the action flip
    expect(await screen.findByText(C.stoppedState)).toBeTruthy();
    expect(screen.getByRole("button", { name: C.resume })).toBeTruthy();
    expect(client.getQueryState(keys.org("o1").clientExtensions())?.isInvalidated).toBe(true);
    expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
  });

  it("reports name the org; a deleted org has its own line, admin pages theirs", async () => {
    const report = (orgId: string | null, contribution: string) => ({
      orgId,
      contribution,
      kind: "render",
      count: 1,
      firstAt: "2026-11-08T08:00:00.000Z",
      lastAt: "2026-11-09T08:00:00.000Z",
      lastMessage: `failed in ${contribution}`,
    });
    const calls = detailRoutes(
      ext({
        clientReports: [report("o1", "brand"), report("o-gone", "hud"), report(null, "page")],
      }),
    );
    await renderRouteWithCache("/admin/extensions/theme-neon", lastStubRoutes());
    const reports = await screen.findByRole("table", { name: C.reportsTitle });
    const rowOf = (text: string) => within(reports).getByRole("row", { name: new RegExp(text) });
    // the org list was read on the server with the extension (reports name orgs)
    expect(calls.some((c) => c.url === "/api/v1/admin/orgs")).toBe(false);
    expect(within(rowOf("failed in brand")).getByText("Acme")).toBeTruthy();
    expect(within(rowOf("failed in brand")).queryByText("o1")).toBeNull();
    expect(within(rowOf("failed in hud")).getByText(C.deletedOrg)).toBeTruthy();
    expect(within(rowOf("failed in page")).getByText(C.adminPages)).toBeTruthy();
  });

  it("恢复界面代码 takes a stopped plugin out of the list; no reports shows the empty line (zh)", async () => {
    const calls = detailRoutes(ext({ clientReports: [] }), {
      "GET /api/v1/admin/settings": () =>
        json(200, {
          ...SETTINGS,
          clientExtensions: { enabled: true, disabled: ["other", "theme-neon"] },
        }),
    });
    await renderRouteWithCache("/admin/extensions/theme-neon", lastStubRoutes(), { locale: "zh" });
    const z = zh.admin.extensions.clientCode;
    expect(await screen.findByText(z.stoppedState)).toBeTruthy();
    expect(screen.getByText(z.noReports)).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: z.resume }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(bodyOf(calls.find((c) => c.method === "PUT"))).toEqual({
      clientExtensions: { disabled: ["other"] },
    });
  });

  it("停用界面代码 reads the list fresh, so another super admin's change is kept", async () => {
    let reads = 0;
    const calls = detailRoutes(ext(), {
      // the page read [] on its first load; meanwhile someone stopped "other"
      "GET /api/v1/admin/settings": () =>
        json(200, {
          ...SETTINGS,
          clientExtensions: { enabled: true, disabled: reads++ === 0 ? [] : ["other"] },
        }),
    });
    await renderRouteWithCache("/admin/extensions/theme-neon", lastStubRoutes());
    await userEvent.setup().click(await screen.findByRole("button", { name: C.stop }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(bodyOf(calls.find((c) => c.method === "PUT"))).toEqual({
      clientExtensions: { disabled: ["other", "theme-neon"] },
    });
  });

  it("an extension without client code shows no 界面代码 and reads no settings", async () => {
    const calls = detailRoutes(ext({ client: null, clientReports: [] }));
    await renderRouteWithCache("/admin/extensions/theme-neon", lastStubRoutes());
    await screen.findByRole("tab", { name: new RegExp(en.admin.extensions.detail.tabs.overview) });
    expect(screen.queryByText(C.title)).toBeNull();
    expect(calls.some((c) => c.url === "/api/v1/admin/settings")).toBe(false);
  });
});

describe("declaredPermissions (the org-upload confirm)", () => {
  const manifest = (
    permissions: StaticExtensionManifest["permissions"],
  ): StaticExtensionManifest => ({
    name: "theme-neon",
    version: "1.0.0",
    sdk: "^0.1.0",
    provides: [],
    requires: [],
    optional: [],
    permissions,
  });

  it("client code and components are sensitive groups of their own; views and embeds stay in ui", () => {
    const groups = declaredPermissions(
      manifest({
        client: true,
        ui: { views: ["board"], embeds: ["app"], components: ["brand", "hero"] },
      }),
      {
        entry: "./dist/client/client.mjs",
        styles: ["./dist/client/styles/neon.css"],
        assets: ["./dist/client/assets/logo.svg"],
      },
    );
    expect(groups).toEqual([
      { category: "ui", items: ["board", "app"], sensitive: false },
      { category: "components", items: ["brand", "hero"], sensitive: true },
      {
        category: "client",
        items: [
          "./dist/client/client.mjs",
          "./dist/client/styles/neon.css",
          "./dist/client/assets/logo.svg",
        ],
        sensitive: true,
      },
    ]);
  });

  it("without the client section the group names the permission key", () => {
    expect(declaredPermissions(manifest({ client: true }))).toEqual([
      { category: "client", items: ["permissions.client"], sensitive: true },
    ]);
    expect(declaredPermissions(manifest({ tools: ["search"] }))).toEqual([
      { category: "tools", items: ["search"], sensitive: false },
    ]);
  });
});

describe("客户端代码 with sizes in the reviews", () => {
  const PENDING_ID = "33333333-3333-4333-8333-333333333333";
  const pendingItem = {
    id: PENDING_ID,
    name: "theme-neon",
    publisher: "Neon",
    displayName: null,
    description: "",
    scope: "optional",
    scopeOrgs: [],
    builtin: false,
    disabled: false,
    shownToOthers: true,
    enabledOrgs: 0,
    pending: true,
    permissionsHash: "ph1",
    latestVersion: "1.0.0",
    versions: ["1.0.0"],
    installs: 0,
    source: "file",
    marketplaceId: null,
    latestMarketplaceVersion: null,
    newerInMarketplace: false,
    contentChanged: false,
    componentCounts: { extension: 1, skills: 0, connectorTemplates: 0, agentTemplates: 0 },
    sourceFormat: "capybara",
    updatedAt: "2026-11-01T00:00:00.000Z",
  };
  const manifest = {
    name: "theme-neon",
    version: "1.0.0",
    publisher: "Neon",
    description: "",
    extension: {
      entry: "./dist/index.mjs",
      manifest: {
        name: "theme-neon",
        version: "1.0.0",
        sdk: "^0.1.0",
        provides: [],
        requires: [],
        optional: [],
        permissions: { client: true, ui: { components: ["brand"] } },
      },
      client: {
        entry: "./dist/client/client.mjs",
        styles: ["./dist/client/styles/neon.css"],
      },
    },
  };

  it("the permission confirmation lists the pending build's files with sizes and the total", async () => {
    resetNavigation("/admin/plugins/pending");
    stubApi({
      "GET /api/v1/admin/catalog/items?pending=true": () =>
        json(200, { items: [pendingItem], nextOffset: null }),
      "GET /api/v1/admin/catalog/requests": () => json(200, { requests: [] }),
      "GET /api/v1/admin/catalog/items": () =>
        json(200, { items: [pendingItem], nextOffset: null }),
      [`GET /api/v1/admin/catalog/items/${PENDING_ID}`]: () =>
        json(200, {
          item: { ...pendingItem, packageName: null, deletedAt: null },
          versions: [
            {
              version: "1.0.0",
              source: "file",
              sourceRef: "upload",
              integrity: null,
              contentDigest: null,
              sourceDetail: null,
              manifest,
              size: 4096,
              extensionSha256: SHA,
              importedAt: "2026-11-01T00:00:00.000Z",
              client: {
                files: [
                  { path: "./dist/client/client.mjs", bytes: 2048 },
                  { path: "./dist/client/styles/neon.css", bytes: 512 },
                ],
                totalBytes: 2560,
                apiVersion: 1,
              },
            },
          ],
          hasIcon: false,
          suggestedAppearance: null,
        }),
    });
    await renderRouteWithCache("/admin/plugins/pending", lastStubRoutes());
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: en.catalog.admin.pending.review }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("./dist/client/client.mjs · 2 KB")).toBeTruthy();
    expect(within(dialog).getByText("./dist/client/styles/neon.css · 512 B")).toBeTruthy();
    expect(within(dialog).getByText("2 files, 2.5 KB in total")).toBeTruthy();
    // the components are their own sensitive group
    expect(within(dialog).getByText(en.extensions.category.components)).toBeTruthy();
    expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
  });

  it("the org Sheet's permission review lists the running build's files with sizes", async () => {
    resetNavigation("/extensions");
    stubApi({
      "GET /api/v1/orgs/o1/extensions": () =>
        json(200, {
          extensions: [
            {
              plugin: "theme-neon",
              displayName: { en: "Neon theme", zh: "霓虹主题" },
              version: "1.0.0",
              enabled: true,
              configurable: false,
              config: null,
              secrets: [],
              orgConfigSchema: null,
              provides: [],
              permissions: ext().permissions,
              client: {
                files: [{ path: "./dist/client/client.mjs", bytes: 2048 }],
                totalBytes: 2048,
                apiVersion: 1,
              },
            },
          ],
        }),
      "GET /api/v1/orgs/o1/file-previewers": () => json(200, { items: [] }),
      "GET /api/v1/orgs/o1/extension-points": () => json(200, { points: [] }),
      "GET /api/v1/orgs/o1/ui/arrangement": () => json(200, { slots: [] }),
      "GET /api/v1/orgs/o1/extensions/theme-neon/tools": () => json(200, { tools: [] }),
      "GET /api/v1/auth/sources": () => json(200, { sources: [] }),
    });
    await renderRouteWithCache("/extensions", lastStubRoutes());
    const user = userEvent.setup();
    await user.click(await screen.findByRole("row", { name: /Neon theme/ }));
    const sheet = await screen.findByRole("dialog", { name: "Neon theme" });
    // the permissions are folded into one line: open them
    await user.click(
      within(sheet).getByRole("button", { name: new RegExp(en.extensions.sensitive) }),
    );
    expect(await within(sheet).findByText("· ./dist/client/client.mjs · 2 KB")).toBeTruthy();
    expect(within(sheet).getByText("1 file, 2 KB in total")).toBeTruthy();
  });
});
