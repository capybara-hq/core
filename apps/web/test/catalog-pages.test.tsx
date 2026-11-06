import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { defaultSlug, slugOf } from "../src/components/CatalogInstallWizard";
import {
  MARKETPLACE_ERROR_KINDS,
  MARKETPLACE_SKIP_REASONS,
  marketplaceErrorKind,
  TRANSLATION_CODE_PLACEHOLDERS,
  TRANSLATION_CODES,
  TRANSLATION_DETAIL_KEYS,
  TRANSLATION_GROUPS,
} from "../src/lib/catalog";
import type { Me } from "../src/lib/session";
import { bodyOf, json, lastStubRoutes, stubApi as stubApiOnly } from "./support/api";
import { resetNavigation, router } from "./support/navigation";
import { renderRouteEmptyCache, renderRouteWithCache } from "./support/query";
import { ME } from "./support/render";
import { expectNoFirstPaintFetch, type Routes } from "./support/server";
import { NOT_READY } from "./support/shell";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
// The admin pages take their query and params from the address (a first load of that path)
/** `/admin/plugins/import` with the address's query (a first load). */
const importPath = () => `/admin/plugins/import${window.location.search}`;
/** `/admin/plugins/market` with the address's query (a first load). */
const entriesPath = () => `/admin/plugins/market${window.location.search}`;
/** `/admin/plugins/<id>` (a first load). */
const adminItemPath = () => `/admin/plugins/${encodeURIComponent(params.current.itemId ?? "")}`;
const params = { current: {} as Record<string, string> };
/**
 * The admin 插件 pages also read the head's counts (the pending plugins and requests), the items
 * and the orgs: answered empty unless a test stubs them.
 */
const ADMIN_DEFAULTS: Routes = {
  // The admin plugin detail's components table reads the platform components (its scope column)
  "GET /api/v1/admin/components?kind=skill": () => json(200, { components: [] }),
  "GET /api/v1/admin/components?kind=connector_template": () => json(200, { components: [] }),
  "GET /api/v1/admin/components?kind=agent_template": () => json(200, { components: [] }),
  "GET /api/v1/admin/orgs": () => json(200, { orgs: [] }),
  "GET /api/v1/admin/catalog/items": () => json(200, { items: [], nextOffset: null }),
  "GET /api/v1/admin/catalog/items?pending=true": () => json(200, { items: [], nextOffset: null }),
  "GET /api/v1/admin/catalog/requests": () => json(200, { requests: [] }),
  // The org 插件 pages: the org's extensions (org admins; their config) and the marketplace
  // entries (org admins; the 市场 tab)
  "GET /api/v1/orgs/o1/extensions": () => json(200, { extensions: [] }),
  "GET /api/v1/orgs/o1/marketplaces/entries": () => json(200, { items: [] }),
  "GET /api/v1/orgs/o1/plugin-installs": () => json(200, { installs: [] }),
  // The plugin `INSTALL` is an install of (its detail page shows the installs)
  "GET /api/v1/orgs/o1/catalog/11111111-1111-4111-8111-111111111111": () =>
    json(200, {
      item: orgItem({
        name: "crm",
        state: "on",
        installed: { pluginInstallId: "i1", version: "1.0.0", upgradeAvailable: null },
      }),
      hasIcon: false,
      extension: null,
      templates: [],
      dependencies: [],
      skills: [],
    }),
};
const stubApi = (routes: Routes) =>
  stubApiOnly({
    ...ADMIN_DEFAULTS,
    // a test's own item list also answers the unpaged reads
    ...(routes["GET /api/v1/admin/catalog/items"] !== undefined &&
    routes["GET /api/v1/admin/catalog/items?pending=true"] === undefined
      ? {
          "GET /api/v1/admin/catalog/items?pending=true": ADMIN_DEFAULTS[
            "GET /api/v1/admin/catalog/items?pending=true"
          ] as Routes[string],
        }
      : {}),
    ...routes,
  });
vi.mock("next/navigation", () => ({
  useParams: () => params.current,
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

type RenderOpts = Parameters<typeof renderRouteWithCache>[2];
/** `/plugins` as a first load: the layout prefetches from the latest `stubApi` routes. */
const renderPlugins = (opts: RenderOpts = {}) =>
  renderRouteWithCache("/plugins", lastStubRoutes(), opts);
/** `/plugins/<id>` as a first load: the layout prefetches from the latest `stubApi` routes. */
const renderItem = (opts: RenderOpts = {}) =>
  renderRouteWithCache(`/plugins/${params.current.itemId ?? ""}`, lastStubRoutes(), opts);
/** `/plugins/<ID>` as a first load, where this org's installs of the plugin are shown. */
const renderInstalls = (opts: RenderOpts = {}) => {
  params.current = { itemId: ID };
  return renderItem(opts);
};
/** `/plugins/<id>/enable` as a first load: the layout prefetches from the latest `stubApi` routes. */
const renderInstall = (opts: RenderOpts = {}) =>
  renderRouteWithCache(`/plugins/${params.current.itemId ?? ""}/enable`, lastStubRoutes(), opts);

const msgs = { zh, en } as const;
/** The design ErrorDetail's toggle (design i18n `errorDetail.raw`). */
const RAW_ERROR = { zh: "原始错误", en: "Raw error" } as const;
/** The design ObjectRow's menu trigger (design i18n `shell.moreActions`). */
const RAW_MORE = { zh: "更多操作", en: "More actions" } as const;
const LOCALES = ["zh", "en"] as const;
const fill = (s: string, vars: Record<string, string | number>) =>
  s.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k]));
const template = (name: string) => document.querySelector(`[data-template="${name}"]`);
/** An accessible name that starts with `label` (optional fields append "(optional)"). */
const startsWith = (label: string) => (name: string) => name.startsWith(label);

const ORG = "/api/v1/orgs/o1";
const ID = "11111111-1111-4111-8111-111111111111";
const MEMBER: Me = {
  ...ME,
  memberships: [{ ...ME.memberships[0], role: "member" } as Me["memberships"][number]],
};

beforeEach(() => {
  resetNavigation("/");
  params.current = {};
  window.history.replaceState(null, "", "/");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function orgItem(over: Record<string, unknown> = {}) {
  return {
    id: ID,
    name: "pdf-tools",
    publisher: "Acme",
    displayName: null,
    description: "PDF helpers",
    scope: "optional",
    builtin: false,
    disabled: false,
    latestVersion: "1.0.0",
    versions: ["1.0.0"],
    source: "file",
    updatedAt: "2026-10-22T00:00:00.000Z",
    state: "off",
    switchable: true,
    notDeployed: false,
    installed: null,
    request: null,
    componentCounts: { extension: 0, skills: 1, connectorTemplates: 0, agentTemplates: 0 },
    sourceFormat: "capybara",
    ...over,
  };
}

/** The input the wizard sent with the switch (`PUT …/switch { enabled: true, inputs }`). */
const switchInputs = (calls: { method: string; body: unknown }[]) => {
  const b = bodyOf(calls.find((c) => c.method === "PUT") as Parameters<typeof bodyOf>[0]) as {
    enabled: boolean;
    inputs: unknown;
  };
  expect(b.enabled).toBe(true);
  return b.inputs;
};

/** Lets pending reads and effects run (a read after mount would show up in the calls). */
const settle = () => act(() => new Promise((r) => setTimeout(r, 20)));

/**
 * A client navigation to `path` with an empty cache whose `held` read answers only on `release()`:
 * the template's loading state is drawn until then.
 */
async function renderHeld(path: string, routes: Routes, held: string) {
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

const escapeRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A row of the org 插件 list, found by its name link. */
const rowOf = (list: HTMLElement, name: string) =>
  within(list)
    .getAllByRole("listitem")
    .find((r) => within(r).queryByRole("link", { name }) !== null) as HTMLElement;
/** The row's buttons and links other than its name and its menu trigger. */
const actionsOf = (row: HTMLElement, name: string) =>
  [...within(row).queryAllByRole("button"), ...within(row).queryAllByRole("link")]
    .filter((e) => !e.hasAttribute("aria-haspopup"))
    .map((e) => e.textContent ?? "")
    .filter((label) => label !== name);
const PREVIEW = {
  installId: "i1",
  name: "crm",
  version: "1.0.0",
  components: [{ kind: "skill", ref: "notes", created: true }],
  kept: [{ kind: "extension", ref: "crm", reason: "pre_existing" }],
  agents: [{ id: "a1", name: "Sales bot", uses: [{ kind: "skill", ref: "notes" }] }],
};

describe("/plugins: states and actions follow the scope and the switch", () => {
  it.each(LOCALES)("org admins: each state and its action (%s)", async (locale) => {
    const p = msgs[locale].plugins;
    const items = [
      orgItem({ id: "a", name: "off" }),
      orgItem({
        id: "b",
        name: "builtin",
        builtin: true,
        scope: "all",
        state: "on",
        switchable: false,
      }),
      orgItem({ id: "c", name: "everyone", scope: "all", state: "on", switchable: false }),
      orgItem({
        id: "d",
        name: "on",
        state: "on",
        installed: { pluginInstallId: "i1", version: "1.0.0", upgradeAvailable: null },
      }),
      orgItem({
        id: "e",
        name: "offered",
        scope: "named",
        state: "not_offered",
        switchable: false,
      }),
      orgItem({
        id: "f",
        name: "asked",
        scope: "named",
        state: "not_offered",
        switchable: false,
        request: { id: "r1", kind: "access", createdAt: "2026-10-22T00:00:00.000Z" },
      }),
      orgItem({
        id: "g",
        name: "needs",
        state: "needs_config",
        componentCounts: { extension: 0, skills: 0, connectorTemplates: 1, agentTemplates: 0 },
      }),
    ];
    stubApi({ [`GET ${ORG}/catalog`]: () => json(200, { items }) });
    await renderPlugins({ locale });
    expect(template("ListPage")).not.toBeNull();
    const list = await screen.findByRole("list", { name: p.title });
    const row = (name: string) => rowOf(list, name);
    expect(within(row("off")).getByText(p.state.off)).toBeTruthy();
    expect(actionsOf(row("off"), "off")).toEqual([p.action.enable]);
    // An `all` or builtin plugin: on for every org, no switch
    for (const name of ["builtin", "everyone"]) {
      expect(within(row(name)).getByText(p.state.platform)).toBeTruthy();
      expect(actionsOf(row(name), name)).toEqual([]);
    }
    expect(within(row("builtin")).getByText(msgs[locale].catalog.admin.chips.builtin)).toBeTruthy();
    expect(within(row("on")).getByText(p.state.on)).toBeTruthy();
    // 停用 sits in the row's menu (a destructive action)
    expect(actionsOf(row("on"), "on")).toEqual([]);
    expect(within(row("on")).getByRole("button", { name: RAW_MORE[locale] })).toBeTruthy();
    expect(within(row("offered")).getByText(p.state.not_offered)).toBeTruthy();
    expect(actionsOf(row("offered"), "offered")).toEqual([p.action.request]);
    expect(within(row("asked")).getByText(p.state.requested)).toBeTruthy();
    expect(actionsOf(row("asked"), "asked")).toEqual([]);
    expect(within(row("needs")).getByText(p.state.needs_config)).toBeTruthy();
    // A plugin with connector templates asks for their input first
    expect(
      within(row("needs")).getByRole("link", { name: p.action.enable }).getAttribute("href"),
    ).toBe("/plugins/g/enable");
  });

  it("启用 an optional plugin without input sends the switch { enabled: true }", async () => {
    const p = zh.plugins;
    let on = false;
    const calls = stubApi({
      [`GET ${ORG}/catalog`]: () =>
        json(200, { items: [orgItem({ state: on ? "on" : "off", name: "notes" })] }),
      [`PUT ${ORG}/catalog/${ID}/switch`]: () => {
        on = true;
        return json(200, { item: orgItem({ state: "on", name: "notes" }) });
      },
    });
    await renderPlugins({ locale: "zh" });
    const list = await screen.findByRole("list", { name: p.title });
    await userEvent
      .setup()
      .click(within(rowOf(list, "notes")).getByRole("button", { name: p.action.enable }));
    await waitFor(() =>
      expect(bodyOf(calls.find((c) => c.method === "PUT"))).toEqual({ enabled: true }),
    );
    expect(await within(rowOf(list, "notes")).findByText(p.state.on)).toBeTruthy();
  });

  it("停用 shows what the switch-off takes away, the agents included, then confirms with its hash", async () => {
    const p = en.plugins;
    const calls = stubApi({
      [`GET ${ORG}/catalog`]: () =>
        json(200, {
          items: [
            orgItem({
              name: "crm",
              state: "on",
              installed: { pluginInstallId: "i1", version: "1.0.0", upgradeAvailable: null },
            }),
          ],
        }),
      [`PUT ${ORG}/catalog/${ID}/switch`]: (c) =>
        (bodyOf(c) as { confirm?: string }).confirm === undefined
          ? json(200, { preview: PREVIEW, confirm: "h1" })
          : json(200, { item: orgItem({ name: "crm", state: "off" }) }),
    });
    await renderPlugins();
    const list = await screen.findByRole("list", { name: p.title });
    const user = userEvent.setup();
    await user.click(within(rowOf(list, "crm")).getByRole("button", { name: "More actions" }));
    await user.click(await screen.findByRole("menuitem", { name: p.action.disable }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Sales bot/)).toBeTruthy();
    expect(
      within(dialog).getByText(`− ${en.catalog.plugins.componentKind.skill} notes`),
    ).toBeTruthy();
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);
    await user.click(within(dialog).getByRole("button", { name: p.switchOff.confirm }));
    await waitFor(() =>
      expect(bodyOf(calls.filter((c) => c.method === "PUT")[1])).toEqual({
        enabled: false,
        confirm: "h1",
      }),
    );
    expect(bodyOf(calls.filter((c) => c.method === "PUT")[0])).toEqual({ enabled: false });
  });

  it("members see the rows without switch actions; 申请启用 only on an optional plugin that is off", async () => {
    const p = en.plugins;
    const calls = stubApi({
      [`GET ${ORG}/catalog`]: () =>
        json(200, {
          items: [
            orgItem({ id: "a", name: "off", switchable: false }),
            orgItem({ id: "b", name: "builtin", builtin: true, scope: "all", state: "on" }),
            orgItem({ id: "c", name: "on", state: "on" }),
            orgItem({ id: "d", name: "offered", scope: "named", state: "not_offered" }),
          ],
        }),
      [`POST ${ORG}/catalog/a/requests`]: () => json(201, { request: { id: "r1" } }),
    });
    await renderPlugins({ me: MEMBER });
    const list = await screen.findByRole("list", { name: p.title });
    for (const name of ["builtin", "on", "offered"]) {
      expect(actionsOf(rowOf(list, name), name)).toEqual([]);
    }
    expect(actionsOf(rowOf(list, "off"), "off")).toEqual([p.action.requestEnable]);
    await userEvent
      .setup()
      .click(within(rowOf(list, "off")).getByRole("button", { name: p.action.requestEnable }));
    await waitFor(() =>
      expect(bodyOf(calls.find((c) => c.method === "POST"))).toEqual({ kind: "enable" }),
    );
  });

  it("org admins: 申请 asks for a plugin that is not offered (access)", async () => {
    const p = en.plugins;
    const calls = stubApi({
      [`GET ${ORG}/catalog`]: () =>
        json(200, {
          items: [orgItem({ name: "offered", scope: "named", state: "not_offered" })],
        }),
      [`POST ${ORG}/catalog/${ID}/requests`]: () => json(201, { request: { id: "r1" } }),
    });
    await renderPlugins();
    const list = await screen.findByRole("list", { name: p.title });
    await userEvent
      .setup()
      .click(within(rowOf(list, "offered")).getByRole("button", { name: p.action.request }));
    await waitFor(() =>
      expect(bodyOf(calls.find((c) => c.method === "POST"))).toEqual({ kind: "access" }),
    );
  });

  it("org admins: the 市场 tab lists the entries with 申请引入; it is hidden when browsing is off", async () => {
    const p = en.plugins;
    const entry = {
      sourceId: "official",
      sourceName: "Official",
      name: "jina",
      version: "1.2.0",
      summary: { en: "Web tools" },
      minKernel: null,
      homepage: null,
      permissions: null,
      source: { npm: { package: "@x/jina", version: "1.2.0", integrity: "sha512-x" } },
      compatible: true,
      importable: true,
      adopted: null,
      newerAvailable: false,
      contentChanged: false,
    };
    const calls = stubApi({
      [`GET ${ORG}/catalog`]: () => json(200, { items: [orgItem()] }),
      [`GET ${ORG}/marketplaces/entries`]: () => json(200, { items: [entry] }),
      [`POST ${ORG}/marketplace-requests`]: () => json(201, { request: { id: "r1" } }),
    });
    await renderPlugins();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: new RegExp(p.tabs.market) }));
    const list = await screen.findByRole("list", { name: p.market.title });
    await user.click(within(list).getByRole("button", { name: p.action.requestImport }));
    await waitFor(() =>
      expect(bodyOf(calls.find((c) => c.method === "POST"))).toEqual({
        marketplaceId: "official",
        name: "jina",
        version: "1.2.0",
      }),
    );
    expect(await within(list).findByText(p.state.requested)).toBeTruthy();
    cleanup();
    vi.unstubAllGlobals();
    // orgMarketplaceBrowse off: the entries route is a 404 and there is no 市场 tab
    stubApi({
      [`GET ${ORG}/catalog`]: () => json(200, { items: [orgItem()] }),
      [`GET ${ORG}/marketplaces/entries`]: () =>
        json(404, { error: { code: "not_found", message: "x" } }),
    });
    await renderPlugins();
    await screen.findByRole("list", { name: p.title });
    await settle();
    expect(screen.queryByRole("tab", { name: new RegExp(p.tabs.market) })).toBeNull();
  });

  it.each(LOCALES)(
    "org admins: a 市场 row shows the display name, else the name, and the summary in the UI language (%s)",
    async (locale) => {
      const p = msgs[locale].plugins;
      const entry = (over: Record<string, unknown>) => ({
        sourceId: "official",
        sourceName: "Official",
        name: "jina",
        version: "1.2.0",
        summary: { en: "Web tools", zh: "网页工具" },
        displayName: { zh: "吉娜", en: "Jina" },
        minKernel: null,
        homepage: null,
        permissions: null,
        source: { npm: { package: "@x/jina", version: "1.2.0", integrity: "sha512-x" } },
        compatible: true,
        importable: true,
        adopted: null,
        newerAvailable: false,
        contentChanged: false,
        ...over,
      });
      stubApi({
        [`GET ${ORG}/catalog`]: () => json(200, { items: [orgItem()] }),
        [`GET ${ORG}/marketplaces/entries`]: () =>
          json(200, {
            items: [
              entry({}),
              entry({ name: "exa", displayName: null, summary: { en: "Search" } }),
            ],
          }),
      });
      await renderPlugins({ locale });
      const user = userEvent.setup();
      await user.click(await screen.findByRole("tab", { name: new RegExp(p.tabs.market) }));
      const list = await screen.findByRole("list", { name: p.market.title });
      const jina = within(list)
        .getByText(locale === "zh" ? "吉娜" : "Jina")
        .closest("li") as HTMLElement;
      expect(within(jina).getByText(locale === "zh" ? "网页工具" : "Web tools")).toBeTruthy();
      const exa = within(list).getByText("exa").closest("li") as HTMLElement;
      expect(within(exa).getByText("Search")).toBeTruthy();
    },
  );

  it("org admins: the 市场 tab has one row per plugin, the latest version; 其他版本 requests an older one", async () => {
    const p = en.plugins;
    const entry = (version: string) => ({
      sourceId: "official",
      sourceName: "Official",
      name: "jina",
      version,
      summary: { en: "Web tools" },
      minKernel: null,
      homepage: null,
      permissions: null,
      source: { npm: { package: "@x/jina", version, integrity: "sha512-x" } },
      compatible: true,
      importable: true,
      adopted: null,
      newerAvailable: false,
      contentChanged: false,
    });
    const calls = stubApi({
      [`GET ${ORG}/catalog`]: () => json(200, { items: [orgItem()] }),
      [`GET ${ORG}/marketplaces/entries`]: () =>
        json(200, { items: [entry("1.1.0"), entry("1.10.0"), entry("1.2.0")] }),
      [`POST ${ORG}/marketplace-requests`]: () => json(201, { request: { id: "r1" } }),
    });
    await renderPlugins();
    const user = userEvent.setup();
    const tab = await screen.findByRole("tab", { name: new RegExp(p.tabs.market) });
    expect(tab.textContent).toContain("1");
    await user.click(tab);
    const list = await screen.findByRole("list", { name: p.market.title });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(within(list).getByText(/v1\.10\.0/)).toBeTruthy();
    await user.click(within(list).getByRole("button", { name: p.action.requestImport }));
    await waitFor(() =>
      expect(bodyOf(calls.find((c) => c.method === "POST"))).toMatchObject({ version: "1.10.0" }),
    );
    expect(await within(list).findByText(p.state.requested)).toBeTruthy();
    // the older versions are in the row's menu
    await user.click(within(list).getByRole("button", { name: "More actions" }));
    await user.click(await screen.findByRole("menuitem", { name: p.market.otherVersions }));
    const older = await screen.findByRole("menuitem", {
      name: fill(p.market.requestVersion, { version: "v1.2.0" }),
    });
    expect(
      screen.getByRole("menuitem", { name: fill(p.market.requestVersion, { version: "v1.1.0" }) }),
    ).toBeTruthy();
    older.focus();
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(bodyOf(calls.filter((c) => c.method === "POST").at(-1))).toMatchObject({
        version: "1.2.0",
      }),
    );
  });

  it("members get no 市场 tab and read no entries", async () => {
    const calls = stubApi({ [`GET ${ORG}/catalog`]: () => json(200, { items: [orgItem()] }) });
    await renderPlugins({ me: MEMBER });
    await screen.findByRole("list", { name: en.plugins.title });
    await settle();
    expect(screen.queryByRole("tab")).toBeNull();
    expect(calls.some((c) => c.url.includes("marketplaces"))).toBe(false);
  });
});

describe("/extensions: the switch follows the plugin", () => {
  const EXT = {
    plugin: "crm",
    displayName: null,
    version: "1.0.0",
    enabled: true,
    configurable: false,
    config: null,
    secrets: [],
    permissions: [],
    orgConfigSchema: null,
    catalogItem: { itemId: ID, scope: "optional" },
    switchable: true,
  };

  it("switching an extension off shows the plugin's switch-off preview, then confirms with its hash", async () => {
    const p = en.plugins;
    const calls = stubApi({
      [`GET ${ORG}/extensions`]: () => json(200, { extensions: [EXT] }),
      [`PUT ${ORG}/extensions/crm`]: (c) =>
        (bodyOf(c) as { confirm?: string }).confirm === undefined
          ? json(200, { preview: PREVIEW, confirm: "h1" })
          : json(200, { extension: { ...EXT, enabled: false } }),
      [`GET ${ORG}/extension-points`]: () => json(200, { points: [] }),
      [`GET ${ORG}/file-previewers`]: () => json(200, { items: [] }),
    });
    await renderRouteWithCache("/extensions", lastStubRoutes());
    expect(template("ListPage")).not.toBeNull();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("switch", { name: "Enable crm" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Sales bot/)).toBeTruthy();
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);
    await user.click(within(dialog).getByRole("button", { name: p.switchOff.confirm }));
    await waitFor(() =>
      expect(bodyOf(calls.filter((c) => c.method === "PUT")[1])).toEqual({
        enabled: false,
        confirm: "h1",
      }),
    );
  });

  it.each(LOCALES)(
    "an extension of an `all` plugin reads 已启用 · 平台统一 and its switch is read-only (%s)",
    async (locale) => {
      const calls = stubApi({
        [`GET ${ORG}/extensions`]: () =>
          json(200, {
            extensions: [{ ...EXT, catalogItem: { itemId: ID, scope: "all" }, switchable: false }],
          }),
        [`GET ${ORG}/extension-points`]: () => json(200, { points: [] }),
        [`GET ${ORG}/file-previewers`]: () => json(200, { items: [] }),
      });
      await renderRouteWithCache("/extensions", lastStubRoutes(), { locale });
      expect(await screen.findByText(msgs[locale].plugins.state.platform)).toBeTruthy();
      const toggle = screen.getByRole("switch");
      expect(
        toggle.hasAttribute("disabled") || toggle.getAttribute("aria-disabled") === "true",
      ).toBe(true);
      await userEvent.setup().click(toggle);
      expect(calls.some((c) => c.method === "PUT")).toBe(false);
    },
  );
});

const extension = (over: Record<string, unknown> = {}) => ({
  name: "crm",
  version: "1.0.0",
  sha256: "a".repeat(64),
  action: "install",
  deployed: false,
  currentVersion: null,
  currentSha256: null,
  permissions: [
    {
      category: "provides",
      sensitive: true,
      items: ["sandbox@1"],
      entries: [{ value: "sandbox@1", sensitive: true, reason: "sandbox" }],
    },
  ],
  added: [],
  addedItems: [],
  removed: [],
  warnings: [],
  reviewHash: "p1",
  sensitive: true,
  ...over,
});

const REVIEW = {
  name: "crm",
  version: "1.0.0",
  packageName: "@acme/plugin-crm",
  publisher: "Acme",
  description: "CRM plugin",
  extension: extension(),
  connectorTemplates: [
    {
      id: "gh",
      displayName: { zh: "GitHub", en: "GitHub" },
      description: "",
      plugin: "connector-mcp",
      connector: "mcp",
      endpoint: { url: "https://mcp.example.com" },
      auth: { type: "bearer", ownership: "org" },
      editableEndpoint: ["url"],
      endpointChecked: true,
    },
  ],
  skills: [
    {
      name: "pdf-tools",
      description: "PDF helpers",
      body: "# PDF",
      path: "skills/pdf-tools",
      files: 2,
    },
  ],
  dependencies: [
    { name: "crm-core", range: "^1.0.0", resolved: "1.2.0" },
    { name: "crm-extra", range: "^2.0.0", resolved: null },
  ],
  source: { kind: "npm", ref: "@acme/plugin-crm@1.0.0" },
  provenance: { checked: false, reason: "the registry has no provenance for this version" },
  contentDigest: "d".repeat(64),
  sensitive: true,
  reviewHash: "h1",
};

describe("/admin/plugins/import (WizardPage)", () => {
  it.each(LOCALES)("the review lists agent templates with tier and tools (%s)", async (locale) => {
    const c = msgs[locale].catalog.components;
    stubApi({
      "POST /api/v1/admin/catalog/import/npm": () =>
        json(200, {
          stagingId: "st1",
          review: {
            ...REVIEW,
            agentTemplates: [
              {
                name: "reviewer",
                path: "agents/reviewer.md",
                description: "Reviews work.",
                instructions: "Review it carefully.",
                model: "fast",
                tools: ["Read", "Bash"],
              },
              {
                name: "planner",
                path: "agents/planner.md",
                description: "Plans.",
                instructions: "Plan.",
                model: "inherit",
              },
            ],
          },
        }),
    });
    await renderRouteWithCache(importPath(), lastStubRoutes(), { locale });
    const user = userEvent.setup();
    const r = msgs[locale].catalog.admin.review;
    await user.click(await screen.findByRole("radio", { name: new RegExp(`^${r.sourceNpm}`) }));
    await user.type(
      screen.getByRole("textbox", { name: msgs[locale].admin.extensions.wizard.npmPackage }),
      "@acme/plugin-crm",
    );
    await user.click(screen.getByRole("button", { name: r.fetch }));
    const agents = await screen.findByRole("region", { name: c.agentTemplates });
    const tier = msgs[locale].agents.form.subagents.tier;
    expect(within(agents).getByText(`reviewer · ${tier.fast}`)).toBeTruthy();
    expect(within(agents).getByText(fill(c.agentTools, { tools: "Read, Bash" }))).toBeTruthy();
    expect(within(agents).getByText(`planner · ${tier.inherit}`)).toBeTruthy();
    expect(within(agents).getByText(c.agentToolsInherit)).toBeTruthy();
  });

  it.each(LOCALES)(
    "one review: extension action and sensitive items, skills, templates, resolved and unresolved dependencies; confirm needs the sensitive ack and posts { reviewHash } (%s)",
    async (locale) => {
      const r = msgs[locale].catalog.admin.review;
      const c = msgs[locale].catalog.components;
      const w = msgs[locale].admin.extensions.wizard;
      const calls = stubApi({
        "POST /api/v1/admin/catalog/import/npm": () =>
          json(200, { stagingId: "st1", review: REVIEW }),
        "POST /api/v1/admin/catalog/imports/st1/confirm": () =>
          json(201, { item: { id: ID, name: "crm" }, deploy: null }),
      });
      await renderRouteWithCache(importPath(), lastStubRoutes(), { locale });
      expect(template("WizardPage")).not.toBeNull();
      const user = userEvent.setup();
      await user.click(await screen.findByRole("radio", { name: new RegExp(`^${r.sourceNpm}`) }));
      await user.type(screen.getByRole("textbox", { name: w.npmPackage }), "@acme/plugin-crm");
      await user.click(screen.getByRole("button", { name: r.fetch }));
      const ext = await screen.findByRole("region", { name: c.extension });
      expect(within(ext).getByText(fill(r.action.install, { version: "v1.0.0" }))).toBeTruthy();
      expect(within(ext).getAllByText(msgs[locale].extensions.sensitive).length).toBeGreaterThan(0);
      const skills = screen.getByRole("region", { name: c.skills });
      expect(within(skills).getByText(`pdf-tools · ${fill(c.skillFiles, { n: 2 })}`)).toBeTruthy();
      const templates = screen.getByRole("region", { name: c.templates });
      expect(within(templates).getByText(fill(r.editable, { paths: "url" }))).toBeTruthy();
      const deps = screen.getByRole("region", { name: c.dependencies });
      expect(
        within(deps).getByText(
          fill(c.dependencyResolved, { name: "crm-core", range: "^1.0.0", version: "v1.2.0" }),
        ),
      ).toBeTruthy();
      expect(
        within(deps).getByText(
          fill(c.dependencyUnresolved, { name: "crm-extra", range: "^2.0.0" }),
        ),
      ).toBeTruthy();
      // The address names the staged import (a reload comes back to this review)
      expect(router.replace).toHaveBeenCalledWith("/admin/plugins/import?staging=st1");
      await user.click(screen.getByRole("button", { name: w.next }));

      const confirm = screen.getByRole("button", { name: r.confirm }) as HTMLButtonElement;
      expect(confirm.disabled).toBe(true);
      // Confirming always installs the extension on the deployment: no choice any more
      expect(screen.getByText(r.deployOn)).toBeTruthy();
      expect(confirm.disabled).toBe(true);
      await user.click(screen.getByRole("checkbox", { name: r.ack }));
      expect(confirm.disabled).toBe(false);
      await user.click(confirm);
      await waitFor(() => expect(router.push).toHaveBeenCalledWith(`/admin/plugins/${ID}`));
      expect(bodyOf(calls.find((x) => x.url.endsWith("/confirm")))).toEqual({
        reviewHash: "h1",
        // the confirm step's default scope (no request asked for it)
        scope: "optional",
      });
    },
  );

  it("?staging=<id>: shows the review prepared on another page; a plugin without an extension confirms with the review hash only", async () => {
    const r = en.catalog.admin.review;
    const review = { ...REVIEW, extension: undefined, sensitive: false, dependencies: [] };
    window.history.replaceState(null, "", "/admin/plugins/import?staging=st2");
    const calls = stubApi({
      "GET /api/v1/admin/catalog/imports/st2": () =>
        json(200, {
          stagingId: "st2",
          review,
          permissionsMismatch: { missing: ["tools", "secrets"], extra: ["storage"] },
        }),
      "POST /api/v1/admin/catalog/imports/st2/confirm": () =>
        json(201, { item: { id: ID, name: "crm" }, deploy: null }),
    });
    await renderRouteWithCache(importPath(), lastStubRoutes());
    const ext = await screen.findByRole("region", { name: en.catalog.components.extension });
    expect(within(ext).getByText(en.catalog.components.extensionNone)).toBeTruthy();
    // The marketplace's permission mismatch comes with the staged review
    expect(screen.getByText(fill(r.mismatchMissing, { keys: "tools, secrets" }))).toBeTruthy();
    expect(screen.getByText(fill(r.mismatchExtra, { keys: "storage" }))).toBeTruthy();
    // Prepared elsewhere: no way back to the source step
    expect(screen.queryByRole("button", { name: en.admin.extensions.wizard.back })).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: en.admin.extensions.wizard.next }));
    expect(screen.getByText(r.noExtension)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: r.confirm }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith(`/admin/plugins/${ID}`));
    expect(bodyOf(calls.find((x) => x.url.endsWith("/confirm")))).toEqual({
      reviewHash: "h1",
      scope: "optional",
    });
  });

  it("?staging=<id> expired or confirmed: says so; starting over shows the source step", async () => {
    const r = en.catalog.admin.review;
    window.history.replaceState(null, "", "/admin/plugins/import?staging=gone");
    stubApi({
      "GET /api/v1/admin/catalog/imports/gone": () =>
        json(404, { error: { code: "plugin.staging_not_found", message: "x" } }),
    });
    await renderRouteWithCache(importPath(), lastStubRoutes());
    expect(await screen.findByText(`${en.errors.plugin.staging_not_found}`)).toBeTruthy();
    expect(screen.getByText(r.gone)).toBeTruthy();
    expect(screen.queryByRole("radio", { name: new RegExp(`^${r.sourceNpm}`) })).toBeNull();
    await userEvent.setup().click(screen.getByRole("button", { name: r.restart }));
    expect(await screen.findByRole("radio", { name: new RegExp(`^${r.sourceNpm}`) })).toBeTruthy();
    expect(screen.queryByText(r.gone)).toBeNull();
    expect(router.replace).toHaveBeenCalledWith("/admin/plugins/import");
  });

  it("a failed deploy after confirm shows the code, the message and the note, with a link to the item", async () => {
    const r = en.catalog.admin.review;
    window.history.replaceState(null, "", "/admin/plugins/import?staging=st3");
    stubApi({
      "GET /api/v1/admin/catalog/imports/st3": () =>
        json(200, {
          stagingId: "st3",
          review: { ...REVIEW, sensitive: false, extension: extension({ sensitive: false }) },
        }),
      "POST /api/v1/admin/catalog/imports/st3/confirm": () =>
        json(201, {
          item: { id: ID, name: "crm" },
          deploy: {
            name: "crm",
            action: "install",
            version: "1.0.0",
            sha256: "a".repeat(64),
            result: "failed",
            code: "extension.migration_failed",
            message: "relation exists",
            note: "snapshot_not_restored: changed meanwhile",
          },
        }),
    });
    await renderRouteWithCache(importPath(), lastStubRoutes());
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: en.admin.extensions.wizard.next }));
    await user.click(screen.getByRole("button", { name: r.confirm }));
    expect(
      await screen.findByText(
        fill(r.deployFailed, {
          name: "crm",
          version: "v1.0.0",
          code: "extension.migration_failed",
        }),
      ),
    ).toBeTruthy();
    expect(screen.getByText("relation exists")).toBeTruthy();
    expect(screen.getByText("snapshot_not_restored: changed meanwhile")).toBeTruthy();
    expect(screen.getByRole("link", { name: r.openItem }).getAttribute("href")).toBe(
      `/admin/plugins/${ID}`,
    );
    expect(router.push).not.toHaveBeenCalled();
  });

  it("the source step: card radios and the 选择文件 drop zone with the chosen file in it", async () => {
    stubApi({ "GET /api/v1/me": () => json(200, ME) });
    await renderRouteWithCache(importPath(), lastStubRoutes(), { locale: "zh" });
    const r = zh.catalog.admin.review;
    const group = await screen.findByRole("radiogroup", { name: r.sourceLabel });
    expect(group.getAttribute("data-variant")).toBe("card");
    expect(within(group).getByText(r.sourceGitHint)).toBeTruthy();
    const zone = document.querySelector('[data-part="file-picker"]') as HTMLElement;
    expect(
      within(zone).getByRole("button", { name: zh.admin.extensions.wizard.choose }),
    ).toBeTruthy();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.setup().upload(input, new File([new Uint8Array([1, 2, 3])], "todo.tgz"));
    expect(within(zone).getByText("todo.tgz")).toBeTruthy();
  });

  it("a pre-0.1.0 upload shows the legacy-format error prominently", async () => {
    stubApi({
      "GET /api/v1/me": () => json(200, ME),
      "POST /api/v1/admin/catalog/import/file": () =>
        json(422, { error: { code: "catalog.legacy_format", message: "x" } }),
    });
    await renderRouteWithCache(importPath(), lastStubRoutes());
    const user = userEvent.setup();
    await screen.findByRole("radio", {
      name: new RegExp(`^${escapeRe(en.catalog.admin.review.sourceFile)}`),
    });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, new File([new Uint8Array([1, 2, 3])], "old.tgz"));
    await user.click(screen.getByRole("button", { name: en.catalog.admin.review.fetch }));
    expect(await screen.findByText(`${en.errors.catalog.legacy_format}`)).toBeTruthy();
  });
});

describe("descriptions in the UI language (descriptionZh)", () => {
  it.each(LOCALES)(
    "the import review shows the description in the UI language (%s)",
    async (locale) => {
      stubApi({
        "POST /api/v1/admin/catalog/import/npm": () =>
          json(200, { stagingId: "st1", review: { ...REVIEW, descriptionZh: "客户管理插件" } }),
      });
      await renderRouteWithCache(importPath(), lastStubRoutes(), { locale });
      const user = userEvent.setup();
      const r = msgs[locale].catalog.admin.review;
      await user.click(await screen.findByRole("radio", { name: new RegExp(`^${r.sourceNpm}`) }));
      await user.type(
        screen.getByRole("textbox", { name: msgs[locale].admin.extensions.wizard.npmPackage }),
        "@acme/plugin-crm",
      );
      await user.click(screen.getByRole("button", { name: r.fetch }));
      expect(await screen.findByText(locale === "zh" ? "客户管理插件" : "CRM plugin")).toBeTruthy();
    },
  );

  it.each(LOCALES)(
    "the workspace list and plugin page show the description in the UI language (%s)",
    async (locale) => {
      const want = locale === "zh" ? "PDF 助手" : "PDF helpers";
      const zhItem = orgItem({ descriptionZh: "PDF 助手" });
      stubApi({ [`GET ${ORG}/catalog`]: () => json(200, { items: [zhItem] }) });
      await renderPlugins({ locale });
      expect(await screen.findByText(want)).toBeTruthy();
      cleanup();
      vi.unstubAllGlobals();
      params.current = { itemId: ID };
      stubApi({
        [`GET ${ORG}/catalog/${ID}`]: () =>
          json(200, {
            item: zhItem,
            hasIcon: false,
            extension: null,
            templates: [],
            dependencies: [],
            skills: [],
          }),
        [`GET ${ORG}/plugin-installs`]: () => json(200, { installs: [] }),
        [`GET ${ORG}/extensions`]: () => json(200, { extensions: [] }),
      });
      await renderItem({ locale });
      expect(await screen.findByText(want)).toBeTruthy();
    },
  );
});

describe("/plugins/[itemId]/enable (WizardPage)", () => {
  it("read-only endpoint fields stay read-only, editable ones change; the body has only the changed editable fields and credentials; a dependency failure names it and says it was rolled back", async () => {
    params.current = { itemId: ID };
    const t = en.catalog.org.install;
    const detail = {
      item: orgItem({ name: "crm" }),
      hasIcon: false,
      extension: "crm",
      templates: [
        {
          id: "gh",
          displayName: { zh: "GitHub", en: "GitHub" },
          description: "",
          plugin: "connector-mcp",
          connector: "mcp",
          endpoint: { url: "https://mcp.example.com", headers: { "X-Org": "acme" } },
          editableEndpoint: ["url"],
          auth: { type: "bearer", ownership: "org" },
          ownership: "org",
        },
      ],
      dependencies: [{ name: "crm-core", range: "^1.0.0" }],
      skills: ["skills/pdf-tools"],
    };
    const calls = stubApi({
      [`GET ${ORG}/catalog/${ID}`]: () => json(200, detail),
      [`GET ${ORG}/extensions`]: () => json(200, { extensions: [] }),
      [`PUT ${ORG}/catalog/${ID}/switch`]: () =>
        json(502, {
          error: {
            code: "plugin.install_failed",
            message: "x",
            details: [
              { step: "skills", code: "internal", dependency: "crm-core", rolledBack: true },
            ],
          },
        }),
    });
    await renderInstall();
    expect(template("WizardPage")).not.toBeNull();
    const fixed = (await screen.findByLabelText("headers.X-Org")) as HTMLInputElement;
    expect(fixed.readOnly).toBe(true);
    expect(fixed.value).toBe("acme");
    const url = screen.getByLabelText("url") as HTMLInputElement;
    expect(url.readOnly).toBe(false);
    const user = userEvent.setup();
    await user.clear(url);
    await user.type(url, "https://mcp.acme.internal");
    await user.type(screen.getByLabelText(en.connectors.form.tokenLabel), "tok");
    await user.click(screen.getByRole("button", { name: t.next }));
    // The extension step: nothing to fill in (the extension has no org config here)
    expect(screen.getByText(t.extensionNone)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: t.next }));
    // Confirm lists the dependencies installed with it
    expect(screen.getByText(t.summaryDependencies)).toBeTruthy();
    expect(screen.getByText("· crm-core ^1.0.0")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: t.submit }));
    expect(
      await screen.findByText(
        `${fill(t.failed, { step: t.step.skills, code: "internal" })} ${fill(t.failedIn, { dependency: "crm-core" })}`,
      ),
    ).toBeTruthy();
    expect(switchInputs(calls)).toEqual({
      version: "1.0.0",
      connectors: {
        gh: {
          name: "GitHub",
          slug: "gh",
          endpoint: { url: "https://mcp.acme.internal" },
          credential: { token: "tok" },
        },
      },
    });
  });

  it("a personal static-auth template asks the installer for their own credential (required, posted) with the hint about other members (final review I2)", async () => {
    params.current = { itemId: ID };
    for (const locale of LOCALES) {
      const t = msgs[locale].catalog.org.install;
      const calls = stubApi({
        [`GET ${ORG}/catalog/${ID}`]: () =>
          json(200, {
            item: orgItem({ name: "docs" }),
            hasIcon: false,
            extension: null,
            templates: [
              {
                id: "docs",
                displayName: null,
                description: "",
                plugin: "connector-mcp",
                connector: "mcp",
                endpoint: { url: "https://mcp.example.com" },
                editableEndpoint: [],
                auth: { type: "bearer", ownership: "personal" },
                ownership: "personal",
              },
            ],
            dependencies: [],
            skills: [],
          }),
        [`GET ${ORG}/extensions`]: () => json(200, { extensions: [] }),
        [`PUT ${ORG}/catalog/${ID}/switch`]: () =>
          json(200, { item: orgItem({ name: "docs", state: "on" }) }),
      });
      await renderInstall({ locale });
      expect(await screen.findByText(t.personalHint)).toBeTruthy();
      const next = screen.getByRole("button", { name: t.next }) as HTMLButtonElement;
      expect(next.disabled).toBe(true);
      const user = userEvent.setup();
      await user.type(screen.getByLabelText(msgs[locale].connectors.form.tokenLabel), "mine");
      expect(next.disabled).toBe(false);
      await user.click(next);
      await user.click(screen.getByRole("button", { name: t.submit }));
      await waitFor(() => expect(router.push).toHaveBeenCalledWith(`/plugins/${ID}`));
      expect(switchInputs(calls)).toEqual({
        version: "1.0.0",
        connectors: { docs: { slug: "docs", credential: { token: "mine" } } },
      });
      cleanup();
      vi.unstubAllGlobals();
    }
  });

  it("a 409 catalog.dependency_unresolved names the dependency and its range", async () => {
    params.current = { itemId: ID };
    const t = en.catalog.org.install;
    stubApi({
      [`GET ${ORG}/catalog/${ID}`]: () =>
        json(200, {
          item: orgItem({ name: "crm" }),
          hasIcon: false,
          extension: null,
          templates: [],
          dependencies: [{ name: "crm-core", range: "^1.0.0" }],
          skills: ["skills/notes"],
        }),
      [`GET ${ORG}/extensions`]: () => json(200, { extensions: [] }),
      [`PUT ${ORG}/catalog/${ID}/switch`]: () =>
        json(409, {
          error: {
            code: "catalog.dependency_unresolved",
            message: "x",
            details: [{ dependency: "crm-core", range: "^1.0.0" }],
          },
        }),
    });
    await renderInstall();
    expect(screen.getByText(t.summaryDependencies)).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: t.submit }));
    expect(await screen.findByText(`${en.errors.catalog.dependency_unresolved}`)).toBeTruthy();
    expect(
      screen.getByText(
        `${fill(en.catalog.components.errorDependency, { dependency: "crm-core ^1.0.0" })}`,
      ),
    ).toBeTruthy();
  });

  it("the extension's org config is sent as extensionConfig when this install enables it; success goes to the installed plugins", async () => {
    params.current = { itemId: ID };
    const t = en.catalog.org.install;
    const calls = stubApi({
      [`GET ${ORG}/readiness`]: () => json(200, { modelProvider: "ready", agents: 1 }),
      [`GET ${ORG}/catalog/${ID}`]: () =>
        json(200, {
          item: orgItem({ name: "crm" }),
          hasIcon: false,
          extension: "crm",
          templates: [],
          dependencies: [],
          skills: [],
        }),
      [`GET ${ORG}/extensions`]: () =>
        json(200, {
          extensions: [
            {
              plugin: "crm",
              displayName: { zh: "客户系统", en: "CRM Suite" },
              version: "1.0.0",
              enabled: false,
              configurable: true,
              config: null,
              secrets: [],
              permissions: [],
              orgConfigSchema: {
                type: "object",
                properties: { region: { type: "string", title: "Region" } },
                required: ["region"],
              },
            },
          ],
        }),
      [`PUT ${ORG}/catalog/${ID}/switch`]: () =>
        json(200, { item: orgItem({ name: "crm", state: "on" }) }),
    });
    const { client } = await renderInstall();
    // the list is cached (as after a visit to /plugins)
    client.setQueryData(["org", "o1", "catalog"], { items: [] });
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Region", { exact: false }), "eu");
    // the config card is titled with the extension's display name, not its id
    expect(screen.getByText("CRM Suite")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: t.next }));
    await user.click(screen.getByRole("button", { name: t.submit }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith(`/plugins/${ID}`));
    // the install invalidates pluginChangeKeys: the cached catalog is marked stale, the shown
    // item, the org's extensions and its readiness are read again
    expect(client.getQueryState(["org", "o1", "catalog"])?.isInvalidated).toBe(true);
    await waitFor(() =>
      expect(new Set(calls.filter((c) => c.method === "GET").map((c) => c.url))).toEqual(
        new Set([`${ORG}/catalog/${ID}`, `${ORG}/extensions`, `${ORG}/readiness`]),
      ),
    );
    expect(switchInputs(calls)).toEqual({
      version: "1.0.0",
      extensionConfig: { region: "eu" },
    });
  });
});

const INSTALL = {
  id: "i1",
  itemId: ID,
  name: "crm",
  version: "1.0.0",
  status: "installed",
  installedBy: "a1",
  installedAt: "2026-10-22T00:00:00.000Z",
  error: null,
  components: [
    { kind: "extension", ref: "todo", created: false, skillVersion: null, dropped: false },
    { kind: "connector", ref: "c1", created: true, skillVersion: null, dropped: false },
    { kind: "skill", ref: "s1", created: true, skillVersion: null, dropped: false },
    { kind: "plugin", ref: "i2", created: true, skillVersion: null, dropped: false },
  ],
  upgradeAvailable: null,
  deploymentPending: false,
};
/** A dependency install `INSTALL` brought in (its `plugin` component). */
const DEP_INSTALL = {
  ...INSTALL,
  id: "i2",
  itemId: "22222222-2222-4222-8222-222222222222",
  name: "crm-core",
  components: [],
};

describe("/plugins/[itemId]: this org's installs (org admins)", () => {
  it.each(LOCALES)(
    "components with dependency installs by plugin name; cleaning up a failed install reports what was removed and kept, with reasons (%s)",
    async (locale) => {
      const a = msgs[locale].catalog.plugins;
      let gone = false;
      const calls = stubApi({
        [`GET ${ORG}/readiness`]: () => json(200, { modelProvider: "ready", agents: 1 }),
        [`GET ${ORG}/plugin-installs`]: () =>
          json(200, { installs: gone ? [] : [{ ...INSTALL, status: "failed" }, DEP_INSTALL] }),
        [`DELETE ${ORG}/plugin-installs/i1`]: () => {
          gone = true;
          return json(200, {
            removed: [
              { kind: "connector", ref: "c1" },
              { kind: "plugin", ref: "i2" },
            ],
            kept: [
              { kind: "extension", ref: "todo", reason: "pre_existing" },
              { kind: "skill", ref: "s1", reason: "used_by_agents" },
            ],
          });
        },
      });
      await renderInstalls({ locale });
      expect(template("DetailPage")).not.toBeNull();
      expect(
        await screen.findByText(`· ${a.componentKind.plugin} crm-core — ${a.created}`),
      ).toBeTruthy();
      // only this plugin's install: the dependency's install is on its own page
      expect(screen.queryByText(fill(a.dependencyOf, { names: "crm" }))).toBeNull();
      const user = userEvent.setup();
      await user.click(await screen.findByRole("button", { name: a.cleanup }));
      const dialog = await screen.findByRole("dialog");
      await user.click(within(dialog).getByRole("button", { name: a.confirm.confirm }));
      const report = await screen.findByRole("region", {
        name: fill(a.report.title, { name: "crm" }),
      });
      expect(within(report).getByText(`− ${a.componentKind.connector} c1`)).toBeTruthy();
      expect(within(report).getByText(`− ${a.componentKind.plugin} crm-core`)).toBeTruthy();
      expect(
        within(report).getByText(
          `· ${a.componentKind.extension} todo — ${a.report.reason.pre_existing}`,
        ),
      ).toBeTruthy();
      expect(
        within(report).getByText(
          `· ${a.componentKind.skill} s1 — ${a.report.reason.used_by_agents}`,
        ),
      ).toBeTruthy();
      // the clean-up invalidates what a plugin change touches: the installs, the item and the
      // org's readiness (an extension it brought may have been a model provider) are read again
      await waitFor(() =>
        expect(new Set(calls.map((c) => `${c.method} ${c.url}`))).toEqual(
          new Set([
            `DELETE ${ORG}/plugin-installs/i1`,
            `GET ${ORG}/plugin-installs`,
            `GET ${ORG}/catalog/${ID}`,
            `GET ${ORG}/extensions`,
            `GET ${ORG}/readiness`,
          ]),
        ),
      );
      expect(calls[0]?.method).toBe("DELETE");
    },
  );

  it("a dependency install says which plugins installed it; a healthy install has no clean-up", async () => {
    const a = en.catalog.plugins;
    stubApi({
      [`GET ${ORG}/plugin-installs`]: () =>
        json(200, {
          installs: [
            { ...INSTALL, itemId: "other" },
            { ...DEP_INSTALL, itemId: ID },
          ],
        }),
    });
    await renderInstalls();
    expect(await screen.findByText(fill(a.dependencyOf, { names: "crm" }))).toBeTruthy();
    expect(screen.queryByRole("button", { name: a.cleanup })).toBeNull();
  });

  it("still installing: a 409 plugin.install_in_progress explains it", async () => {
    stubApi({
      [`GET ${ORG}/plugin-installs`]: () =>
        json(200, { installs: [{ ...INSTALL, status: "installing" }] }),
      [`DELETE ${ORG}/plugin-installs/i1`]: () =>
        json(409, { error: { code: "plugin.install_in_progress", message: "x" } }),
    });
    await renderInstalls();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: en.catalog.plugins.cleanup }));
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: en.catalog.plugins.confirm.confirm,
      }),
    );
    expect(await screen.findByText(`${en.catalog.plugins.inProgress}`)).toBeTruthy();
  });
});

const SOURCES = {
  offline: true,
  items: [
    {
      id: "official",
      name: "Capybara official marketplace",
      url: "https://catalog.capybarahq.com/v1/index.json",
      mirrors: [],
      builtin: true,
      enabled: false,
      disabledByConfig: true,
      hasToken: false,
      lastRefreshedAt: null,
      lastStatus: "never",
      lastError: null,
      entryCount: 0,
    },
    {
      id: "s2",
      name: "Acme",
      url: "https://catalog.acme.com/index.json",
      mirrors: [],
      builtin: false,
      enabled: true,
      disabledByConfig: false,
      hasToken: true,
      lastRefreshedAt: "2026-10-22T00:00:00.000Z",
      lastStatus: "error",
      lastError: "HTTP 500",
      entryCount: 3,
    },
  ],
};

describe("/admin/plugins/sources (ListPage)", () => {
  it.each(LOCALES)(
    "官方地址只读、离线模式说明；自定义清单可改，显示状态与刷新（%s）",
    async (locale) => {
      const s = msgs[locale].catalog.admin.marketplaces;
      stubApi({
        "GET /api/v1/admin/marketplaces": () => json(200, SOURCES),
        "POST /api/v1/admin/marketplaces/s2/refresh": () =>
          json(200, { ...SOURCES.items[1], lastStatus: "ok", lastError: null }),
      });
      await renderRouteWithCache("/admin/plugins/sources", lastStubRoutes(), { locale });
      expect(template("ListPage")).not.toBeNull();
      // Its own page under 插件 (添加市场源 leads here): the path links back, no tabs
      expect(screen.getByRole("link", { name: "plugins" }).getAttribute("href")).toBe(
        "/admin/plugins",
      );
      const tabs = msgs[locale].catalog.admin.tabs;
      expect(screen.queryByRole("link", { name: new RegExp(`^${tabs.installed}`) })).toBeNull();
      expect(await screen.findByText(s.offline)).toBeTruthy();
      const official = screen.getByDisplayValue(
        SOURCES.items[0]?.url as string,
      ) as HTMLInputElement;
      expect(official.readOnly).toBe(true);
      const acme = screen.getByDisplayValue(SOURCES.items[1]?.url as string) as HTMLInputElement;
      expect(acme.readOnly).toBe(false);
      // A refresh error is one sentence in the reader's language; the raw text is behind a toggle
      expect(screen.getByText(s.statusValue.errors.http_status)).toBeTruthy();
      expect(screen.queryByText("HTTP 500", { exact: false })).toBeNull();
      const raw = screen.getByRole("button", { name: RAW_ERROR[locale] });
      await userEvent.setup().click(raw);
      expect(screen.getByText("HTTP 500")).toBeTruthy();
      // The status label sits above its value (no 「状态:」 squeezed beside a long line)
      expect(screen.getAllByText(s.status).length).toBeGreaterThan(0);
      expect(screen.queryByText(`${s.status}:`)).toBeNull();
      // Every marketplace's switch is labelled on screen, the official one too
      const switches = screen.getAllByRole("switch");
      expect(switches.map((x) => x.getAttribute("aria-label"))).toEqual([
        fill(s.enabledLabel, { name: s.official }),
        fill(s.enabledLabel, { name: "Acme" }),
      ]);
      expect(screen.getByText(fill(s.enabledLabel, { name: s.official }))).toBeTruthy();
      const refresh = screen.getAllByRole("button", { name: s.refresh });
      // 官方清单被配置关闭：不能刷新
      expect((refresh[0] as HTMLButtonElement).disabled).toBe(true);
      await userEvent.setup().click(refresh[1] as HTMLElement);
      expect(await screen.findByText(fill(s.refreshed, { name: "Acme" }))).toBeTruthy();
    },
  );
});

describe("marketplaces: the two tabs share one head", () => {
  const ENTRY = {
    sourceId: "s2",
    sourceName: "Acme",
    name: "cat-a",
    version: "1.0.0",
    summary: { en: "Cat A" },
    minKernel: null,
    homepage: null,
    permissions: null,
    source: { npm: { package: "@acme/cat-a", version: "1.0.0", integrity: "sha512-x" } },
    compatible: true,
    importable: true,
    adopted: null,
    newerAvailable: false,
    contentChanged: false,
  };
  const head = () => document.querySelector('[data-part="page-header"]') as HTMLElement;

  it.each(LOCALES)(
    "sources has its description and search; the market tab has the 插件 head with its counts (%s)",
    async (locale) => {
      const m = msgs[locale].catalog.admin;
      stubApi({
        "GET /api/v1/admin/marketplaces": () => json(200, SOURCES),
        "GET /api/v1/admin/marketplaces/entries": () => json(200, { items: [ENTRY] }),
      });
      await renderRouteWithCache("/admin/plugins/sources", lastStubRoutes(), { locale });
      const sourcesHead = head();
      expect(within(sourcesHead).getByText(m.marketplaces.description)).toBeTruthy();
      expect(
        within(sourcesHead).getByRole("searchbox", { name: m.marketplaces.search }),
      ).toBeTruthy();
      cleanup();

      resetNavigation("/admin/plugins/market");
      await renderRouteWithCache(entriesPath(), lastStubRoutes(), { locale });
      const entriesHead = head();
      expect(within(entriesHead).getByText(m.description)).toBeTruthy();
      const tabs = within(
        entriesHead.querySelector('[data-part="page-header-tabs"]') as HTMLElement,
      )
        .getAllByRole("link")
        .map((a) => a.textContent);
      expect(tabs).toEqual([`${m.tabs.installed}0`, m.tabs.market, `${m.tabs.pending}0`]);
      expect(within(entriesHead).getByRole("searchbox", { name: m.entries.search })).toBeTruthy();
    },
  );

  it("the sources search filters the marketplaces by name or address", async () => {
    const m = en.catalog.admin.marketplaces;
    stubApi({ "GET /api/v1/admin/marketplaces": () => json(200, SOURCES) });
    await renderRouteWithCache("/admin/plugins/sources", lastStubRoutes());
    const user = userEvent.setup();
    await user.type(screen.getByRole("searchbox", { name: m.search }), "acme.com");
    expect(screen.queryByDisplayValue(SOURCES.items[0]?.url as string)).toBeNull();
    expect(screen.getByDisplayValue(SOURCES.items[1]?.url as string)).toBeTruthy();
    await user.clear(screen.getByRole("searchbox", { name: m.search }));
    await user.type(screen.getByRole("searchbox", { name: m.search }), "nothing-here");
    expect(screen.getByText(m.noMatch)).toBeTruthy();
  });

  it.each(LOCALES)("the empty entries list points to 添加市场源 (%s)", (locale) => {
    const m = msgs[locale].catalog.admin;
    expect(m.entries.empty).toContain(
      locale === "zh" ? `「${m.actions.addSource}」` : m.actions.addSource,
    );
  });
});

describe("marketplaceErrorKind", () => {
  it("maps the kernel's refresh errors to a kind; anything else is unknown", () => {
    const git = "https://github.com/capybara-hq/plugins.git: cannot list the refs of x";
    expect(
      marketplaceErrorKind(
        `${git}: Access to github.com is refused: it resolves to a private or reserved address (add the hostname to marketplaces.allowPrivateHosts to allow an internal host).`,
      ),
    ).toBe("private_address");
    expect(marketplaceErrorKind("https://x.com/m.json: Cannot resolve x.com.")).toBe("dns");
    expect(marketplaceErrorKind(`${git}: timed out after 30 s`)).toBe("timeout");
    expect(marketplaceErrorKind("https://x/m.json: the marketplace responded with HTTP 404")).toBe(
      "http_status",
    );
    expect(
      marketplaceErrorKind("https://x/m.json: the marketplace manifest is not valid JSON"),
    ).toBe("invalid");
    expect(marketplaceErrorKind("refresh aborted")).toBe("unknown");
  });

  it.each(LOCALES)("every kind has a sentence ending with a full stop (%s)", (locale) => {
    const errors = msgs[locale].catalog.admin.marketplaces.statusValue.errors;
    for (const k of MARKETPLACE_ERROR_KINDS) {
      expect(errors[k]).toMatch(locale === "zh" ? /。$/ : /\.$/);
    }
  });
});

describe("/admin/plugins and marketplace entries", () => {
  const item = (over: Record<string, unknown>) => ({
    id: ID,
    name: "cat-a",
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
    latestMarketplaceVersion: "2.0.0",
    newerInMarketplace: true,
    contentChanged: false,
    componentCounts: { extension: 0, skills: 1, connectorTemplates: 0, agentTemplates: 0 },
    sourceFormat: "capybara",
    updatedAt: "2026-10-22T00:00:00.000Z",
    ...over,
  });
  const entry = (over: Record<string, unknown> = {}) => ({
    sourceId: "official",
    sourceName: "Official",
    name: "cat-a",
    version: "2.0.0",
    summary: { en: "Cat A" },
    minKernel: null,
    homepage: null,
    permissions: { keys: ["tools"], sensitive: ["tools"] },
    source: {
      npm: {
        package: "@acme/plugin-cat-a",
        version: "2.0.0",
        integrity: `sha512-${"a".repeat(86)}==`,
      },
    },
    compatible: true,
    importable: true,
    adopted: { itemId: ID, versions: ["1.0.0"] },
    newerAvailable: true,
    contentChanged: false,
    ...over,
  });
  const version = (v: string, manifest: Record<string, unknown> = {}) => ({
    version: v,
    source: "file",
    sourceRef: "upload",
    integrity: null,
    contentDigest: null,
    sourceDetail: null,
    manifest: {
      name: "crm",
      version: v,
      publisher: "Acme",
      description: "CRM plugin",
      ...manifest,
    },
    size: 1024,
    extensionSha256: null,
    importedAt: "2026-10-22T00:00:00.000Z",
  });

  it.each(LOCALES)(
    "list and item detail show the description in the UI language (%s)",
    async (locale) => {
      const want = locale === "zh" ? "客户管理插件" : "CRM plugin";
      const zhItem = item({
        name: "crm",
        description: "CRM plugin",
        descriptionZh: "客户管理插件",
      });
      stubApi({
        "GET /api/v1/admin/catalog/items": () => json(200, { items: [zhItem], nextOffset: null }),
        "GET /api/v1/admin/marketplaces": () => json(200, SOURCES),
      });
      await renderRouteWithCache("/admin/plugins", lastStubRoutes(), { locale });
      expect(await screen.findByText(want)).toBeTruthy();
      cleanup();
      vi.unstubAllGlobals();
      params.current = { itemId: ID };
      stubApi({
        [`GET /api/v1/admin/catalog/items/${ID}`]: () =>
          json(200, {
            item: { ...zhItem, packageName: null, deletedAt: null },
            versions: [version("1.0.0")],
            hasIcon: false,
          }),
        "GET /api/v1/admin/marketplaces": () => json(200, SOURCES),
        "GET /api/v1/admin/catalog/items": () => json(200, { items: [], nextOffset: null }),
      });
      await renderRouteWithCache(adminItemPath(), lastStubRoutes(), { locale });
      expect(await screen.findByText(want)).toBeTruthy();
    },
  );

  it("list: source and “update available”; the search narrows by name", async () => {
    const t = en.catalog;
    stubApi({
      "GET /api/v1/admin/catalog/items": () =>
        json(200, {
          items: [
            item({}),
            item({
              id: "m",
              name: "manual-skill",
              marketplaceId: null,
              latestMarketplaceVersion: null,
              newerInMarketplace: false,
            }),
          ],
          nextOffset: null,
        }),
      "GET /api/v1/admin/marketplaces": () => json(200, SOURCES),
    });
    await renderRouteWithCache("/admin/plugins", lastStubRoutes());
    const list = await screen.findByRole("list", { name: t.admin.title });
    const row = (name: string) =>
      within(list)
        .getAllByText(new RegExp(name))
        .map((n) => n.closest("li") as HTMLElement)[0] as HTMLElement;
    expect(within(row("cat-a")).getByText(new RegExp(t.source.official))).toBeTruthy();
    // a newer compatible version in its marketplace is the row's state
    const update = fill(t.admin.state.update, { version: "v2.0.0" });
    expect(within(row("cat-a")).getByText(update)).toBeTruthy();
    expect(within(row("manual-skill")).getByText(new RegExp(t.source.manual))).toBeTruthy();
    expect(within(row("manual-skill")).queryByText(update)).toBeNull();
    expect(within(row("manual-skill")).getByText(t.admin.state.running)).toBeTruthy();
    // The search narrows by name
    await userEvent.setup().type(screen.getByRole("searchbox", { name: t.admin.search }), "manual");
    expect(within(list).queryByText(/cat-a/)).toBeNull();
  });

  it("entries: incompatible marked; a git entry on a host outside allowedHosts names the host and cannot be imported; truncation hint", async () => {
    const c = en.catalog.admin.entries;
    stubApi({
      "GET /api/v1/admin/marketplaces": () => json(200, SOURCES),
      "GET /api/v1/admin/marketplaces/entries": () =>
        json(200, {
          items: [
            entry(),
            entry({ name: "old-a", version: "3.0.0", compatible: false, adopted: null }),
            entry({
              name: "git-a",
              version: "1.0.0",
              source: { git: { url: "https://github.com/acme/git-a.git" } },
              importable: false,
              reason: "host_not_allowed",
              adopted: null,
              newerAvailable: false,
            }),
          ],
          truncated: true,
        }),
    });
    await renderRouteWithCache(entriesPath(), lastStubRoutes());
    expect(await screen.findByText(c.truncated)).toBeTruthy();
    // The 插件 head with its tab 市场 active
    expect(
      screen
        .getByRole("link", { name: new RegExp(`^${en.catalog.admin.tabs.market}`) })
        .getAttribute("aria-current"),
    ).toBeTruthy();
    // object rows, not a table; no filter rail
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("radiogroup")).toBeNull();
    const list = screen.getByRole("list", { name: c.title });
    const row = (name: string) => within(list).getByText(name).closest("li") as HTMLElement;
    expect(
      within(row("old-a")).getByText(
        new RegExp(escapeRe(fill(c.incompatible, { version: "v3.0.0" }))),
      ),
    ).toBeTruthy();
    const git = row("git-a");
    const notAllowed = fill(c.reason.host_not_allowed, { host: "github.com" });
    expect(within(git).getByText(notAllowed)).toBeTruthy();
    expect(within(git).getByText(/https:\/\/github\.com\/acme\/git-a\.git/)).toBeTruthy();
    // nothing to import: no row action
    expect(within(git).queryByRole("button", { name: c.import })).toBeNull();
    // the reason is the row's state; a menu holding only that disabled line is not drawn
    expect(within(git).queryByRole("button", { name: "More actions" })).toBeNull();
  });

  it("entries: importing stages the plugin and opens the import review; an integrity mismatch is a prominent error", async () => {
    const c = en.catalog.admin.entries;
    let fail = true;
    const calls = stubApi({
      "GET /api/v1/admin/marketplaces": () => json(200, SOURCES),
      "GET /api/v1/admin/marketplaces/entries": () =>
        json(200, { items: [entry({ adopted: null, newerAvailable: false })], truncated: false }),
      "POST /api/v1/admin/marketplaces/official/entries/cat-a/import": () =>
        fail
          ? json(502, { error: { code: "marketplace.integrity_mismatch", message: "x" } })
          : json(200, {
              stagingId: "st9",
              review: REVIEW,
              permissionsMismatch: { missing: ["tools"], extra: [] },
            }),
    });
    await renderRouteWithCache(entriesPath(), lastStubRoutes());
    const list = await screen.findByRole("list", { name: c.title });
    const user = userEvent.setup();
    const importIt = async () => {
      await user.click(
        await within(list).findByRole("button", {
          name: fill(c.importVersion, { version: "v2.0.0" }),
        }),
      );
    };
    await importIt();
    expect(await screen.findByText(`${en.errors.marketplace.integrity_mismatch}`)).toBeTruthy();
    fail = false;
    await importIt();
    await waitFor(() =>
      expect(router.push).toHaveBeenCalledWith("/admin/plugins/import?staging=st9"),
    );
    expect(bodyOf(calls.filter((x) => x.method === "POST").at(-1))).toEqual({ version: "2.0.0" });
  });

  it.each(LOCALES)(
    "entries: a row shows the entry's display name, else its name, and the summary in the UI language (%s)",
    async (locale) => {
      stubApi({
        "GET /api/v1/admin/marketplaces": () => json(200, SOURCES),
        "GET /api/v1/admin/marketplaces/entries": () =>
          json(200, {
            items: [
              entry({
                displayName: { zh: "甲猫", en: "Cat A" },
                summary: { en: "Cat tools", zh: "猫工具" },
              }),
              entry({ name: "dog-b", displayName: null, summary: { en: "Dog tools" } }),
            ],
            truncated: false,
          }),
      });
      await renderRouteWithCache(entriesPath(), lastStubRoutes(), { locale });
      const list = await screen.findByRole("list", {
        name: msgs[locale].catalog.admin.entries.title,
      });
      const cat = within(list)
        .getByText(locale === "zh" ? "甲猫" : "Cat A")
        .closest("li") as HTMLElement;
      expect(within(cat).getByText(locale === "zh" ? "猫工具" : "Cat tools")).toBeTruthy();
      const dog = within(list).getByText("dog-b").closest("li") as HTMLElement;
      // no zh summary: the English one in both languages
      expect(within(dog).getByText("Dog tools")).toBeTruthy();
    },
  );

  it("entries: one row per plugin with its latest version; an older import can be updated; 其他版本 imports another version", async () => {
    const c = en.catalog.admin.entries;
    const at = (name: string, v: string, over: Record<string, unknown> = {}) =>
      entry({ name, version: v, adopted: null, newerAvailable: false, ...over });
    const old = { adopted: { itemId: ID, versions: ["1.0.0-rc.0"] } };
    const calls = stubApi({
      "GET /api/v1/admin/marketplaces": () => json(200, SOURCES),
      "GET /api/v1/admin/marketplaces/entries": () =>
        json(200, {
          items: [
            // imported at an older version; rc.10 is the newest (semver, not text order)
            at("cat-a", "1.0.0-rc.2", { ...old, newerAvailable: true }),
            at("cat-a", "1.0.0-rc.10", { ...old, newerAvailable: true }),
            at("cat-a", "1.0.0-rc.0", old),
            // never imported
            at("dog-b", "0.9.0"),
            at("dog-b", "1.0.0"),
            // imported at the latest
            at("eel-c", "2.0.0", { adopted: { itemId: "e1", versions: ["2.0.0"] } }),
            at("eel-c", "1.0.0", { adopted: { itemId: "e1", versions: ["2.0.0"] } }),
          ],
          truncated: false,
        }),
      "POST /api/v1/admin/marketplaces/official/entries/cat-a/import": () =>
        json(200, { stagingId: "st9", review: REVIEW }),
    });
    await renderRouteWithCache(entriesPath(), lastStubRoutes());
    const list = await screen.findByRole("list", { name: c.title });
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    const row = (name: string) => within(list).getByText(name).closest("li") as HTMLElement;
    // imported at an older version: 可更新到 the latest, 更新 imports it
    const cat = row("cat-a");
    expect(
      within(cat).getByText(
        fill(c.adoptedUpdate, { version: "v1.0.0-rc.0", latest: "v1.0.0-rc.10" }),
      ),
    ).toBeTruthy();
    // the state says it: no 有新版本 chip
    expect(within(cat).queryByText(en.catalog.newer)).toBeNull();
    const user = userEvent.setup();
    await user.click(within(cat).getByRole("button", { name: c.update }));
    await waitFor(() =>
      expect(bodyOf(calls.filter((x) => x.method === "POST").at(-1))).toEqual({
        version: "1.0.0-rc.10",
      }),
    );
    // never imported: 未引入 and 引入 the latest
    const dog = row("dog-b");
    expect(within(dog).getByText(c.notAdopted)).toBeTruthy();
    expect(
      within(dog).getByRole("button", { name: fill(c.importVersion, { version: "v1.0.0" }) }),
    ).toBeTruthy();
    // imported at the latest: 已引入 and 查看
    const eel = row("eel-c");
    expect(within(eel).getByText(fill(c.adopted, { version: "v2.0.0" }))).toBeTruthy();
    expect(within(eel).getByRole("link", { name: c.view }).getAttribute("href")).toContain(
      "/admin/plugins/e1",
    );
    // 其他版本: the other versions, the imported one not importable again
    await user.click(within(cat).getByRole("button", { name: "More actions" }));
    await user.click(await screen.findByRole("menuitem", { name: c.otherVersions }));
    const rc2 = await screen.findByRole("menuitem", {
      name: fill(c.importVersion, { version: "v1.0.0-rc.2" }),
    });
    const rc0 = screen.getByRole("menuitem", {
      name: fill(c.adopted, { version: "v1.0.0-rc.0" }),
    });
    expect(rc0.getAttribute("aria-disabled")).toBe("true");
    rc2.focus();
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(bodyOf(calls.filter((x) => x.method === "POST").at(-1))).toEqual({
        version: "1.0.0-rc.2",
      }),
    );
  });

  it("item detail: the agent templates of the latest version", async () => {
    params.current = { itemId: ID };
    const c = en.catalog.components;
    stubApi({
      [`GET /api/v1/admin/catalog/items/${ID}`]: () =>
        json(200, {
          item: { ...item({ name: "crm" }), packageName: null, deletedAt: null },
          versions: [version("1.0.0", { agents: [{ path: "./agents/reviewer.md" }] })],
          hasIcon: false,
        }),
      "GET /api/v1/admin/marketplaces": () => json(200, SOURCES),
      "GET /api/v1/admin/catalog/items": () => json(200, { items: [], nextOffset: null }),
    });
    await renderRouteWithCache(adminItemPath(), lastStubRoutes());
    const table = await screen.findByRole("table", {
      name: en.catalog.admin.detail.tabs.components,
    });
    const row = within(table).getByText("reviewer").closest("tr") as HTMLElement;
    expect(within(row).getByText(en.catalog.admin.detail.kind.agentTemplate)).toBeTruthy();
    void c;
  });

  it("item detail: the components table of the latest version, the permissions count, dependencies with catalog resolution", async () => {
    params.current = { itemId: ID };
    const c = en.catalog.components;
    stubApi({
      [`GET /api/v1/admin/catalog/items/${ID}`]: () =>
        json(200, {
          item: {
            ...item({ name: "crm", versions: ["1.0.0"], latestVersion: "1.0.0" }),
            packageName: "@acme/plugin-crm",
            deletedAt: null,
          },
          versions: [
            version("1.0.0", {
              skills: [{ path: "./skills/crm-notes" }],
              connectorTemplates: [{ path: "./connectors/docs.json" }],
              dependencies: [
                { name: "crm-core", version: "^1.0.0" },
                { name: "crm-extra", version: "^2.0.0" },
              ],
              extension: {
                entry: "./dist/index.mjs",
                manifest: {
                  name: "crm",
                  version: "1.0.0",
                  sdk: "^0.1.0-rc.0",
                  provides: [],
                  requires: [],
                  optional: [],
                  permissions: { tools: ["crm_search"], storage: true },
                  config: { deployment: [], org: [] },
                },
              },
            }),
          ],
          hasIcon: false,
        }),
      "GET /api/v1/admin/marketplaces": () => json(200, SOURCES),
      "GET /api/v1/admin/catalog/items": () =>
        json(200, {
          items: [item({ id: "core-id", name: "crm-core", versions: ["1.2.0", "1.0.0"] })],
          nextOffset: null,
        }),
    });
    await renderRouteWithCache(adminItemPath(), lastStubRoutes());
    // One table of the latest version's components: kind and version
    const d = en.catalog.admin.detail;
    const table = await screen.findByRole("table", { name: d.tabs.components });
    const kindOf = (name: string) =>
      within(within(table).getByText(name).closest("tr") as HTMLElement);
    expect(kindOf("crm").getByText(d.kind.extension)).toBeTruthy();
    expect(kindOf("crm").getByText("v1.0.0")).toBeTruthy();
    expect(kindOf("crm-notes").getByText(d.kind.skill)).toBeTruthy();
    expect(kindOf("docs").getByText(d.kind.connectorTemplate)).toBeTruthy();
    // the inspector counts the declared permissions (tools and storage), confirmed
    expect(screen.getByText(fill(d.permissions.confirmed, { n: 2 }))).toBeTruthy();
    const deps = screen.getByRole("region", { name: c.dependencies });
    const found = await within(deps).findByRole("link", {
      name: fill(c.dependencyInCatalog, {
        name: "crm-core",
        range: "^1.0.0",
        versions: "1.2.0, 1.0.0",
      }),
    });
    expect(found.getAttribute("href")).toBe("/admin/plugins/core-id");
    expect(
      within(deps).getByText(
        fill(c.dependencyNotInCatalog, { name: "crm-extra", range: "^2.0.0" }),
      ),
    ).toBeTruthy();
  });

  it("item detail: the icon is only an <img> pointing at the kernel route, never inline", async () => {
    params.current = { itemId: ID };
    stubApi({
      [`GET /api/v1/admin/catalog/items/${ID}`]: () =>
        json(200, {
          item: { ...item({ name: "gh" }), packageName: "@acme/gh", deletedAt: null },
          versions: [version("1.0.0", { name: "gh" })],
          hasIcon: true,
        }),
      "GET /api/v1/admin/marketplaces": () => json(200, SOURCES),
      "GET /api/v1/admin/catalog/items": () => json(200, { items: [], nextOffset: null }),
    });
    await renderRouteWithCache(adminItemPath(), lastStubRoutes());
    const img = (await screen.findByRole("img", {
      name: fill(en.catalog.iconAlt, { name: "gh" }),
    })) as HTMLImageElement;
    expect(img.src).toMatch(new RegExp(`/api/v1/admin/catalog/items/${ID}/icon$`));
    expect(document.querySelector("svg[data-directory-icon]")).toBeNull();
  });

  it("item detail: no icon (hasIcon false) renders no image; a plugin without an extension has no permissions", async () => {
    params.current = { itemId: ID };
    stubApi({
      [`GET /api/v1/admin/catalog/items/${ID}`]: () =>
        json(200, {
          item: { ...item({ name: "crm" }), packageName: "@acme/crm", deletedAt: null },
          versions: [version("1.0.0")],
          hasIcon: false,
        }),
      "GET /api/v1/admin/marketplaces": () => json(200, SOURCES),
      "GET /api/v1/admin/catalog/items": () => json(200, { items: [], nextOffset: null }),
    });
    await renderRouteWithCache(adminItemPath(), lastStubRoutes());
    expect(await screen.findByText("@acme/crm")).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText(en.catalog.admin.detail.permissions.none)).toBeTruthy();
  });

  it("entries: the marketplaces are tabs above the list only when there is more than one", async () => {
    const calls = stubApi({
      "GET /api/v1/admin/marketplaces": () => json(200, SOURCES),
      "GET /api/v1/admin/marketplaces/entries": () =>
        json(200, { items: [entry()], truncated: false }),
    });
    await renderRouteWithCache(entriesPath(), lastStubRoutes());
    const tabs = await screen.findByRole("tablist", { name: en.catalog.admin.filters.source });
    expect(within(tabs).getAllByRole("tab")).toHaveLength(3);
    await userEvent.setup().click(within(tabs).getAllByRole("tab")[2] as HTMLElement);
    await waitFor(() => expect(calls.some((c) => c.url.includes("sourceId=s2"))).toBe(true));
    cleanup();
    stubApi({
      "GET /api/v1/admin/marketplaces": () =>
        json(200, { ...SOURCES, items: SOURCES.items.slice(0, 1) }),
      "GET /api/v1/admin/marketplaces/entries": () =>
        json(200, { items: [entry()], truncated: false }),
    });
    await renderRouteWithCache(entriesPath(), lastStubRoutes());
    await screen.findByText(/@acme\/plugin-cat-a/);
    expect(screen.queryByRole("tablist", { name: en.catalog.admin.filters.source })).toBeNull();
  });

  it("entries search is debounced: typing sends one request with the keyword", async () => {
    const calls = stubApi({
      "GET /api/v1/admin/marketplaces": () => json(200, SOURCES),
      "GET /api/v1/admin/marketplaces/entries": () =>
        json(200, { items: [entry()], truncated: false }),
    });
    await renderRouteWithCache(entriesPath(), lastStubRoutes());
    await screen.findByText(/@acme\/plugin-cat-a/);
    await userEvent
      .setup()
      .type(screen.getByRole("searchbox", { name: en.catalog.admin.entries.search }), "cat-a");
    await waitFor(() => expect(calls.some((c) => c.url.includes("q=cat-a"))).toBe(true));
    expect(calls.filter((c) => c.url.includes("q=")).map((c) => c.url)).toEqual([
      "/api/v1/admin/marketplaces/entries?q=cat-a",
    ]);
  });
});

describe("inbox: catalog_request", () => {
  it("组织管理员批准成员的目录申请", async () => {
    const d = en.catalog.inbox;
    const request = {
      id: "r1",
      orgId: "o1",
      orgName: "Acme",
      kind: "enable",
      item: { id: ID, name: "pdf-tools", displayName: null },
      entry: null,
      status: "pending",
      note: "please",
      reason: null,
      requestedBy: "a2",
      requestedByName: "Mia",
      decidedBy: null,
      decidedAt: null,
      stagingId: null,
      createdAt: "2026-10-22T00:00:00.000Z",
    };
    let done = false;
    const routes = {
      [`GET ${ORG}/inbox`]: () =>
        json(200, {
          items: done
            ? []
            : [{ type: "catalog_request", id: "r1", createdAt: request.createdAt, request }],
          truncated: false,
        }),
      [`POST ${ORG}/catalog-requests/r1/decide`]: () => {
        done = true;
        return json(200, { request: { ...request, status: "approved" } });
      },
    };
    const calls = stubApi(routes);
    await renderRouteWithCache("/inbox", routes);
    expect(
      (await screen.findAllByText(fill(d.title, { name: "pdf-tools" }))).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText("please")).toBeTruthy();
    expect(screen.getByText("Mia")).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: d.approve }));
    expect(await screen.findByText(d.approved)).toBeTruthy();
    expect(bodyOf(calls.find((c) => c.method === "POST"))).toEqual({ approve: true });
  });
});

describe("/extensions: switching on refused by the plugin", () => {
  it.each(LOCALES)(
    "approval_required shows the translated reason and a link to 插件 (%s)",
    async (locale) => {
      const m = msgs[locale];
      stubApi({
        [`GET ${ORG}/file-previewers`]: () => json(200, { items: [] }),
        [`GET ${ORG}/extension-points`]: () => json(200, { points: [] }),
        [`GET ${ORG}/extensions`]: () =>
          json(200, {
            extensions: [
              {
                plugin: "crm-core",
                version: "1.0.0",
                enabled: false,
                configurable: false,
                config: null,
                secrets: [],
                permissions: [],
                orgConfigSchema: null,
              },
            ],
          }),
        [`PUT ${ORG}/extensions/crm-core`]: () =>
          json(403, { error: { code: "catalog.approval_required", message: "x" } }),
      });
      await renderRouteWithCache("/extensions", lastStubRoutes(), { locale });
      await userEvent.setup().click(
        await screen.findByRole("switch", {
          name: fill(m.extensions.enableLabel, { plugin: "crm-core" }),
        }),
      );
      expect(await screen.findByText(`${m.errors.catalog.approval_required}`)).toBeTruthy();
      expect(
        screen.getByRole("link", { name: m.extensions.openPlugins }).getAttribute("href"),
      ).toBe("/plugins");
    },
  );
});

describe("安装向导的默认 slug", () => {
  it("连接器模板条目按条目名推导（不是连接器种类）；应用里的模板按模板 id", () => {
    expect(defaultSlug({ id: "connector" }, "github-mcp")).toBe("github_mcp");
    expect(defaultSlug({ id: "connector" }, "9-docs")).toBe("docs");
    expect(defaultSlug({ id: "crm-mcp" }, "crm")).toBe("crm_mcp");
    expect(slugOf("中文")).toBe("");
    expect(slugOf("a".repeat(30))).toHaveLength(24);
  });

  it("单模板条目：向导里预填的 slug 来自条目名", async () => {
    params.current = { itemId: ID };
    stubApi({
      [`GET ${ORG}/catalog/${ID}`]: () =>
        json(200, {
          item: orgItem({ name: "github-mcp" }),
          hasIcon: false,
          extension: null,
          templates: [
            {
              id: "connector",
              displayName: null,
              description: "",
              plugin: "connector-mcp",
              connector: "mcp",
              endpoint: { url: "https://mcp.example.com" },
              editableEndpoint: [],
              auth: { type: "none" },
              ownership: null,
            },
          ],
          dependencies: [],
          skills: [],
        }),
      [`GET ${ORG}/extensions`]: () => json(200, { extensions: [] }),
    });
    await renderInstall();
    const slug = (await screen.findByLabelText(en.catalog.org.install.slug, {
      exact: false,
    })) as HTMLInputElement;
    expect(slug.value).toBe("github_mcp");
  });
});

describe("/admin/plugins/pending with nothing waiting", () => {
  it("one full-width empty state", async () => {
    stubApi({});
    await renderRouteWithCache("/admin/plugins/pending", lastStubRoutes());
    expect(await screen.findByText(en.catalog.admin.pending.empty)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(document.querySelector(".cb-body-rail")).toBeNull();
  });
});

describe("/admin/plugins/pending shows the requester", () => {
  it("a request row names its org, kind and requester; the tab 待确认 is active", async () => {
    stubApi({
      "GET /api/v1/admin/catalog/requests": () =>
        json(200, {
          requests: [
            {
              id: "r1",
              orgId: "o1",
              orgName: "Acme",
              kind: "access",
              item: { id: ID, name: "crm", displayName: null },
              entry: null,
              status: "pending",
              note: "",
              reason: null,
              requestedBy: "a2",
              requestedByName: "Mia",
              decidedBy: null,
              decidedAt: null,
              stagingId: null,
              createdAt: "2026-10-22T00:00:00.000Z",
            },
          ],
        }),
    });
    await renderRouteWithCache("/admin/plugins/pending", lastStubRoutes());
    const p = en.catalog.admin.pending;
    expect(await screen.findByText(new RegExp(fill(p.requester, { name: "Mia" })))).toBeTruthy();
    expect(screen.getByText(p.kind.access)).toBeTruthy();
    expect(screen.getByText("Acme · crm")).toBeTruthy();
    const tab = en.catalog.admin.tabs;
    expect(
      screen
        .getByRole("link", { name: new RegExp(`^${tab.pending}`) })
        .getAttribute("aria-current"),
    ).toBeTruthy();
  });
});

describe("phase A1: git marketplaces, source detail and provenance", () => {
  const GIT_SOURCE = {
    id: "g1",
    name: "Acme git",
    url: "https://git.acme.com/acme/marketplace.git",
    form: "git",
    ref: "release",
    lastCommit: "0123456789abcdef0123456789abcdef01234567",
    mirrors: [],
    builtin: false,
    enabled: true,
    disabledByConfig: false,
    hasToken: false,
    lastRefreshedAt: "2026-10-22T00:00:00.000Z",
    lastStatus: "ok",
    lastError: null,
    entryCount: 2,
  };

  it.each(LOCALES)(
    "adding a git repository sends form git and the ref; a git marketplace shows its ref and last commit (%s)",
    async (locale) => {
      const s = msgs[locale].catalog.admin.marketplaces;
      const calls = stubApi({
        "GET /api/v1/admin/marketplaces": () =>
          json(200, { offline: false, items: [SOURCES.items[0], GIT_SOURCE] }),
        "POST /api/v1/admin/marketplaces": () => json(201, { ...GIT_SOURCE, id: "g2" }),
      });
      await renderRouteWithCache("/admin/plugins/sources", lastStubRoutes(), { locale });
      expect(await screen.findByText(fill(s.gitInfo, { ref: "release" }))).toBeTruthy();
      expect(screen.getByText(fill(s.lastCommit, { commit: "0123456" }))).toBeTruthy();
      const user = userEvent.setup();
      const add = screen.getByRole("region", { name: s.add });
      await user.click(within(add).getByRole("radio", { name: s.formGit }));
      await user.type(within(add).getByRole("textbox", { name: s.name }), "Team");
      await user.type(within(add).getByRole("textbox", { name: s.url }), "acme/plugins");
      await user.type(within(add).getByRole("textbox", { name: startsWith(s.ref) }), "main");
      await user.click(within(add).getByRole("button", { name: s.add }));
      await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
      expect(bodyOf(calls.find((c) => c.method === "POST"))).toEqual({
        name: "Team",
        url: "acme/plugins",
        form: "git",
        ref: "main",
      });
    },
  );

  it("an http marketplace sends no form or ref", async () => {
    const s = en.catalog.admin.marketplaces;
    const calls = stubApi({
      "GET /api/v1/admin/marketplaces": () => json(200, { offline: false, items: [] }),
      "POST /api/v1/admin/marketplaces": () => json(201, { ...GIT_SOURCE, form: "http" }),
    });
    await renderRouteWithCache("/admin/plugins/sources", lastStubRoutes());
    const add = await screen.findByRole("region", { name: s.add });
    const user = userEvent.setup();
    expect(within(add).queryByRole("textbox", { name: startsWith(s.ref) })).toBeNull();
    await user.type(within(add).getByRole("textbox", { name: s.name }), "Http");
    await user.type(within(add).getByRole("textbox", { name: s.url }), "https://x.com/m.json");
    await user.click(within(add).getByRole("button", { name: s.add }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(bodyOf(calls.find((c) => c.method === "POST"))).toEqual({
      name: "Http",
      url: "https://x.com/m.json",
    });
  });

  const gitEntry = (over: Record<string, unknown>) => ({
    sourceId: "g1",
    sourceName: "Acme git",
    name: "x",
    version: "1.0.0",
    summary: { en: "X" },
    minKernel: null,
    homepage: null,
    permissions: null,
    source: { path: "./plugins/x" },
    compatible: true,
    importable: true,
    adopted: null,
    newerAvailable: false,
    contentChanged: false,
    ...over,
  });

  it("entries: git sources pinned or following a branch, a path entry, an http marketplace's path entry; content changed at the same version can be imported again", async () => {
    const c = en.catalog.admin.entries;
    const sha = "89abcdef0123456789abcdef0123456789abcdef";
    const calls = stubApi({
      "GET /api/v1/admin/marketplaces": () => json(200, { offline: false, items: [GIT_SOURCE] }),
      "GET /api/v1/admin/marketplaces/entries": () =>
        json(200, {
          items: [
            gitEntry({
              name: "pinned",
              source: { git: { url: "https://git.acme.com/a/pinned.git", commit: sha } },
            }),
            gitEntry({
              name: "follows",
              source: { git: { url: "https://git.acme.com/a/follows.git", ref: "main" } },
            }),
            gitEntry({
              name: "in-repo",
              adopted: { itemId: ID, versions: ["1.0.0"] },
              contentChanged: true,
            }),
            gitEntry({
              name: "http-path",
              sourceId: "s2",
              importable: false,
              reason: "path_needs_git_marketplace",
            }),
          ],
          truncated: false,
        }),
      "POST /api/v1/admin/marketplaces/g1/entries/in-repo/import": () =>
        json(200, { stagingId: "st7", review: REVIEW }),
    });
    await renderRouteWithCache(entriesPath(), lastStubRoutes());
    const list = await screen.findByRole("list", { name: c.title });
    const row = (name: string) => within(list).getByText(name).closest("li") as HTMLElement;
    const meta = (name: string) => row(name).querySelector(".cb-object-meta")?.textContent ?? "";
    expect(meta("pinned")).toContain(fill(c.gitPinned, { commit: "89abcde" }));
    expect(meta("follows")).toContain(fill(c.gitFollows, { ref: "main" }));
    expect(meta("in-repo")).toContain(fill(c.pathSource, { path: "./plugins/x" }));
    expect(within(row("in-repo")).getByText(en.catalog.contentChanged)).toBeTruthy();
    expect(within(row("http-path")).getByText(c.reason.path_needs_git_marketplace)).toBeTruthy();
    const user = userEvent.setup();
    await user.click(
      within(row("in-repo")).getByRole("button", {
        name: fill(c.importChanged, { version: "v1.0.0" }),
      }),
    );
    await waitFor(() =>
      expect(router.push).toHaveBeenCalledWith("/admin/plugins/import?staging=st7"),
    );
    expect(bodyOf(calls.find((x) => x.method === "POST"))).toEqual({ version: "1.0.0" });
  });

  it("an entry import refused by the network rules shows the copy and a localized line naming the host", async () => {
    const message =
      "Access to git.internal is refused: it resolves to a private or reserved address (add the hostname to marketplaces.allowPrivateHosts to allow an internal host).";
    stubApi({
      "GET /api/v1/admin/marketplaces": () => json(200, { offline: false, items: [GIT_SOURCE] }),
      "GET /api/v1/admin/marketplaces/entries": () =>
        json(200, { items: [gitEntry({})], truncated: false }),
      "POST /api/v1/admin/marketplaces/g1/entries/x/import": () =>
        json(422, {
          error: {
            code: "marketplace.private_address",
            message,
            details: [{ host: "git.internal" }],
          },
        }),
    });
    await renderRouteWithCache(entriesPath(), lastStubRoutes());
    const list = await screen.findByRole("list", { name: en.catalog.admin.entries.title });
    const user = userEvent.setup();
    await user.click(
      within(list).getByRole("button", {
        name: fill(en.catalog.admin.entries.importVersion, { version: "v1.0.0" }),
      }),
    );
    expect(await screen.findByText(`${en.errors.marketplace.private_address}`)).toBeTruthy();
    expect(
      screen.getByText(`${fill(en.catalog.errorDetail.host, { host: "git.internal" })}`),
    ).toBeTruthy();
    // The kernel's English message is for logs and API users, not shown
    expect(screen.queryByText(`${message}`)).toBeNull();
  });

  it("a git redirect from a URL without .git adds a localized line saying to use the .git URL", async () => {
    stubApi({
      "GET /api/v1/admin/marketplaces": () => json(200, { offline: false, items: [GIT_SOURCE] }),
      "GET /api/v1/admin/marketplaces/entries": () =>
        json(200, { items: [gitEntry({})], truncated: false }),
      "POST /api/v1/admin/marketplaces/g1/entries/x/import": () =>
        json(422, {
          error: {
            code: "marketplace.redirect",
            message: "gitlab.com responded with a redirect (301); redirects are not followed.",
            details: [{ host: "gitlab.com", repo: "acme/tools", hint: "git_suffix" }],
          },
        }),
    });
    await renderRouteWithCache(entriesPath(), lastStubRoutes());
    const list = await screen.findByRole("list", { name: en.catalog.admin.entries.title });
    const user = userEvent.setup();
    await user.click(
      within(list).getByRole("button", {
        name: fill(en.catalog.admin.entries.importVersion, { version: "v1.0.0" }),
      }),
    );
    expect(await screen.findByText(`${en.errors.marketplace.redirect}`)).toBeTruthy();
    expect(screen.getByText(`${en.catalog.errorDetail.gitSuffix}`)).toBeTruthy();
  });

  it.each(LOCALES)(
    "the review shows npm provenance and the git source; a build version and a repository mismatch are explained (%s)",
    async (locale) => {
      const r = msgs[locale].catalog.admin.review;
      const o = msgs[locale].catalog.origin;
      window.history.replaceState(null, "", "/admin/plugins/import?staging=st3");
      const commit = "fedcba9876543210fedcba9876543210fedcba98";
      stubApi({
        "GET /api/v1/admin/catalog/imports/st3": () =>
          json(200, {
            stagingId: "st3",
            review: {
              ...REVIEW,
              version: "1.0.0+git.fedcba987654",
              pluginVersion: "1.0.0",
              source: {
                kind: "marketplace",
                ref: "g1/crm",
                detail: {
                  host: "git.acme.com",
                  repo: "acme/marketplace",
                  path: "plugins/crm",
                  ref: "main",
                  commit,
                  followsBranch: true,
                },
              },
              provenance: {
                checked: true,
                repository: "https://github.com/acme/crm",
                commit,
                workflow: ".github/workflows/release.yml",
                buildType: "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
              },
              provenanceWarning: "repository_mismatch",
            },
          }),
      });
      await renderRouteWithCache(importPath(), lastStubRoutes(), { locale });
      expect(
        await screen.findByText(
          fill(r.provenance, {
            repository: "https://github.com/acme/crm",
            commit: "fedcba9",
            workflow: ".github/workflows/release.yml",
          }),
        ),
      ).toBeTruthy();
      expect(screen.getByText(r.provenanceMismatch)).toBeTruthy();
      const origin = `${fill(o.git, { location: "git.acme.com/acme/marketplace (plugins/crm)", commit: "fedcba9" })} · ${fill(o.followsBranch, { ref: "main" })}`;
      expect(screen.getByText(fill(r.origin, { origin }))).toBeTruthy();
      expect(
        screen.getByText(
          fill(r.buildVersion, { version: "v1.0.0+git.fedcba987654", pluginVersion: "v1.0.0" }),
        ),
      ).toBeTruthy();
    },
  );

  it("provenance not checked is shown only for npm sources", async () => {
    const r = en.catalog.admin.review;
    window.history.replaceState(null, "", "/admin/plugins/import?staging=st6");
    stubApi({
      "GET /api/v1/admin/catalog/imports/st6": () =>
        json(200, {
          stagingId: "st6",
          review: {
            ...REVIEW,
            source: { kind: "git", ref: "acme/crm" },
            provenance: { checked: false, reason: "not an npm package" },
          },
        }),
    });
    await renderRouteWithCache(importPath(), lastStubRoutes());
    await screen.findByRole("region", { name: en.catalog.components.extension });
    expect(
      screen.queryByText(fill(r.provenanceNotChecked, { reason: "not an npm package" })),
    ).toBeNull();
  });

  it("provenance not checked says why", async () => {
    const r = en.catalog.admin.review;
    window.history.replaceState(null, "", "/admin/plugins/import?staging=st4");
    stubApi({
      "GET /api/v1/admin/catalog/imports/st4": () =>
        json(200, { stagingId: "st4", review: REVIEW }),
    });
    await renderRouteWithCache(importPath(), lastStubRoutes());
    expect(
      await screen.findByText(
        fill(r.provenanceNotChecked, { reason: "the registry has no provenance for this version" }),
      ),
    ).toBeTruthy();
  });

  it.each(LOCALES)(
    "import from git: url, ref and path go to import/git; a git failure names the repository and ref in localized copy (%s)",
    async (locale) => {
      const r = msgs[locale].catalog.admin.review;
      const ed = msgs[locale].catalog.errorDetail;
      let fail = true;
      const calls = stubApi({
        "POST /api/v1/admin/catalog/import/git": () =>
          fail
            ? json(502, {
                error: {
                  code: "marketplace.git_failed",
                  message: "the server refused to serve commit abc; pin a branch or tag tip",
                  details: [{ host: "github.com", repo: "acme/crm", ref: "v1.0.0" }],
                },
              })
            : json(200, { stagingId: "st5", review: REVIEW }),
      });
      await renderRouteWithCache(importPath(), lastStubRoutes(), { locale });
      const user = userEvent.setup();
      await user.click(await screen.findByRole("radio", { name: new RegExp(`^${r.sourceGit}`) }));
      await user.type(screen.getByRole("textbox", { name: r.gitUrl }), "acme/crm");
      await user.type(screen.getByRole("textbox", { name: startsWith(r.gitRef) }), "v1.0.0");
      await user.type(screen.getByRole("textbox", { name: startsWith(r.gitPath) }), "plugins/crm");
      await user.click(screen.getByRole("button", { name: r.fetch }));
      expect(await screen.findByText(`${msgs[locale].errors.marketplace.git_failed}`)).toBeTruthy();
      expect(
        screen.getByText(
          `${fill(ed.repo, { location: "github.com/acme/crm" })} · ${fill(ed.ref, { ref: "v1.0.0" })}`,
        ),
      ).toBeTruthy();
      expect(screen.queryByText(/the server refused to serve commit/)).toBeNull();
      fail = false;
      await user.click(screen.getByRole("button", { name: r.fetch }));
      await waitFor(() =>
        expect(router.replace).toHaveBeenCalledWith("/admin/plugins/import?staging=st5"),
      );
      expect(bodyOf(calls.filter((c) => c.method === "POST").at(-1))).toEqual({
        url: "acme/crm",
        ref: "v1.0.0",
        path: "plugins/crm",
      });
    },
  );

  it("item detail: content changed at the same version, and each version's origin", async () => {
    params.current = { itemId: ID };
    const d = en.catalog.admin.detail;
    const o = en.catalog.origin;
    const v = (version: string, over: Record<string, unknown>) => ({
      version,
      source: "git",
      sourceRef: "acme/crm",
      integrity: null,
      contentDigest: "e".repeat(64),
      sourceDetail: null,
      manifest: { name: "crm", version, publisher: "Acme", description: "" },
      size: 10,
      extensionSha256: null,
      importedAt: "2026-10-22T00:00:00.000Z",
      ...over,
    });
    stubApi({
      [`GET /api/v1/admin/catalog/items/${ID}`]: () =>
        json(200, {
          item: {
            id: ID,
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
            versions: ["1.0.0", "0.9.0"],
            installs: 0,
            source: "git",
            marketplaceId: "g1",
            latestMarketplaceVersion: "1.0.0",
            newerInMarketplace: false,
            contentChanged: true,
            updatedAt: "2026-10-22T00:00:00.000Z",
            packageName: null,
            deletedAt: null,
          },
          versions: [
            v("1.0.0", {
              sourceDetail: {
                host: "github.com",
                repo: "acme/crm",
                path: ".",
                commit: "1111111222222233333334444444555555566666",
                followsBranch: false,
              },
            }),
            v("0.9.0", {
              source: "npm",
              sourceDetail: { registry: "https://registry.npmjs.org" },
            }),
          ],
          hasIcon: false,
        }),
      "GET /api/v1/admin/marketplaces": () => json(200, { offline: false, items: [GIT_SOURCE] }),
      "GET /api/v1/admin/catalog/items": () => json(200, { items: [], nextOffset: null }),
    });
    await renderRouteWithCache(adminItemPath(), lastStubRoutes());
    expect(await screen.findByText(d.contentChanged)).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("tab", { name: d.tabs.versions }));
    const table = screen.getByRole("table");
    expect(
      within(table).getByText(
        `${fill(o.git, { location: "github.com/acme/crm", commit: "1111111" })} · ${o.pinned}`,
      ),
    ).toBeTruthy();
    expect(
      within(table).getByText(fill(o.registry, { registry: "https://registry.npmjs.org" })),
    ).toBeTruthy();
    expect(within(table).getAllByText(en.catalog.versionSource.git).length).toBe(1);
  });

  it("catalog list: content changed is marked", async () => {
    stubApi({
      "GET /api/v1/admin/catalog/items": () =>
        json(200, {
          items: [
            {
              id: ID,
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
              installs: 0,
              source: "git",
              marketplaceId: "g1",
              latestMarketplaceVersion: "1.0.0",
              newerInMarketplace: false,
              contentChanged: true,
              componentCounts: {
                extension: 0,
                skills: 1,
                connectorTemplates: 0,
                agentTemplates: 0,
              },
              sourceFormat: "capybara",
              updatedAt: "2026-10-22T00:00:00.000Z",
            },
          ],
          nextOffset: null,
        }),
      "GET /api/v1/admin/marketplaces": () => json(200, { offline: false, items: [GIT_SOURCE] }),
    });
    await renderRouteWithCache("/admin/plugins", lastStubRoutes());
    const list = await screen.findByRole("list", { name: en.catalog.admin.title });
    expect(within(list).getByText(en.catalog.contentChanged)).toBeTruthy();
  });
});

// The org plugin upgrade (its dialog and routes) is retired (ruling F2): a platform plugin moves
// with the admin platform update (admin-components.test.tsx).
describe("phase A1: the org plugin page and skill conflicts", () => {
  const DETAIL = {
    item: orgItem({
      name: "crm",
      latestVersion: "1.1.0",
      installed: { pluginInstallId: "i1", version: "1.0.0", upgradeAvailable: null },
    }),
    hasIcon: false,
    extension: null,
    templates: [],
    dependencies: [],
    skills: ["skills/notes", "skills/extra"],
  };

  it("plugin page: members read no installs", async () => {
    params.current = { itemId: ID };
    const calls = stubApi({ [`GET ${ORG}/catalog/${ID}`]: () => json(200, DETAIL) });
    await renderItem({ me: MEMBER });
    await screen.findByText(en.catalog.components.skills);
    await settle();
    expect(calls.some((c) => c.url.endsWith("/plugin-installs"))).toBe(false);
  });

  it("plugin page: the plugin's agent templates are listed", async () => {
    params.current = { itemId: ID };
    stubApi({
      [`GET ${ORG}/catalog/${ID}`]: () =>
        json(200, { ...DETAIL, agents: ["agents/reviewer.md", "agents/tester.md"] }),
    });
    await renderItem({ me: MEMBER });
    expect(await screen.findByText("· reviewer")).toBeTruthy();
    expect(screen.getByText("· tester")).toBeTruthy();
    expect(screen.getByText(en.catalog.components.agentTemplates)).toBeTruthy();
  });

  it.each(LOCALES)(
    "install wizard: a skill conflict names each skill and where it comes from (%s)",
    async (locale) => {
      params.current = { itemId: ID };
      const m = msgs[locale];
      stubApi({
        [`GET ${ORG}/catalog/${ID}`]: () =>
          json(200, { ...DETAIL, item: orgItem({ name: "crm" }), templates: [] }),
        [`GET ${ORG}/extensions`]: () => json(200, { extensions: [] }),
        [`PUT ${ORG}/catalog/${ID}/switch`]: () =>
          json(409, {
            error: {
              code: "plugin.skill_conflict",
              message: "x",
              details: [
                { skill: "notes", source: { kind: "org" } },
                { skill: "extra", source: { kind: "plugin", name: "other", version: "2.0.0" } },
                { skill: "more", source: { kind: "plugin", name: "legacy", version: "" } },
              ],
            },
          }),
      });
      await renderInstall({ locale });
      await screen.findByText(m.catalog.org.install.summary);
      await userEvent
        .setup()
        .click(screen.getByRole("button", { name: m.catalog.org.install.submit }));
      expect(await screen.findByText(`${m.errors.plugin.skill_conflict}`)).toBeTruthy();
      expect(
        screen.getByText(`${fill(m.catalog.components.skillConflictOrg, { skill: "notes" })}`),
      ).toBeTruthy();
      expect(
        screen.getByText(
          `${fill(m.catalog.components.skillConflictPlugin, { skill: "extra", plugin: "other v2.0.0" })}`,
        ),
      ).toBeTruthy();
      expect(
        screen.getByText(
          `${fill(m.catalog.components.skillConflictPlugin, { skill: "more", plugin: "legacy" })}`,
        ),
      ).toBeTruthy();
    },
  );
});

const CLAUDE_REVIEW = {
  ...REVIEW,
  name: "superpowers",
  version: "7.0.1",
  packageName: null,
  publisher: "Jesse Vincent",
  description: "Skills for coding agents",
  license: "MIT",
  extension: undefined,
  sensitive: false,
  connectorTemplates: [],
  dependencies: [],
  source: { kind: "git", ref: "https://github.com/obra/superpowers.git" },
  provenance: { checked: false, reason: "not an npm package" },
  format: "claude-code",
  repository: "https://github.com/obra/superpowers",
  licenseText: "MIT License\n\nCopyright (c) 2025 Jesse Vincent",
  skills: [
    {
      name: "using-superpowers",
      description: "Use at the start of every conversation",
      body: "# Using superpowers",
      path: "skills/using-superpowers",
      files: 3,
      suggestPinned: true,
    },
    {
      name: "brainstorming",
      description: "Use before creative work",
      body: "# Brainstorming\n\nAsk questions first.",
      path: "skills/brainstorming",
      files: 1,
      suggestPinned: false,
    },
  ],
  translation: {
    format: "claude-code",
    manifestPath: ".claude-plugin/plugin.json",
    sessionStart: false,
    items: [
      {
        group: "imported",
        component: "skill",
        name: "brainstorming",
        path: "skills/brainstorming",
        code: "skill_imported",
      },
      {
        group: "converted",
        component: "mcpServer",
        name: "docs",
        code: "mcp_template",
        detail: { template: "docs", auth: "none" },
      },
      {
        group: "needsInput",
        component: "mcpServer",
        name: "github",
        code: "mcp_header_variable",
        detail: { header: "Authorization", variable: "GITHUB_TOKEN" },
      },
      {
        group: "ignored",
        component: "hook",
        name: "SessionStart",
        path: "hooks/hooks.json",
        code: "hooks_not_run",
        detail: { handlers: "command" },
      },
      {
        group: "ignored",
        component: "skill",
        name: "broken",
        path: "skills/broken",
        code: "skill_invalid",
        detail: { problem: "description is required" },
      },
      {
        group: "warnings",
        component: "skill",
        name: "brainstorming",
        path: "skills/brainstorming",
        code: "skill_ignored_restrictions",
        detail: { keys: "allowed-tools" },
      },
    ],
  },
};

/** The text of a report item line. */
const itemLine = (
  locale: (typeof LOCALES)[number],
  item: { component: string; name: string; code: string; detail?: Record<string, string> },
) => {
  const tr = msgs[locale].catalog.admin.review.translation;
  return fill(tr.item, {
    component: tr.components[item.component as keyof typeof tr.components],
    name: item.name,
    reason: fill(tr.codes[item.code as keyof typeof tr.codes], item.detail ?? {}),
  });
};

describe("phase B: Claude Code plugins on the import review", () => {
  const stage = (review: Record<string, unknown>) => {
    window.history.replaceState(null, "", "/admin/plugins/import?staging=st9");
    return stubApi({
      "GET /api/v1/admin/catalog/imports/st9": () => json(200, { stagingId: "st9", review }),
      "POST /api/v1/admin/catalog/imports/st9/confirm": () =>
        json(201, { item: { id: ID, name: "superpowers" }, deploy: null }),
    });
  };

  it.each(LOCALES)(
    "the review lists the five groups with localized reasons, the format and the repository (%s)",
    async (locale) => {
      const tr = msgs[locale].catalog.admin.review.translation;
      stage(CLAUDE_REVIEW);
      await renderRouteWithCache(importPath(), lastStubRoutes(), { locale });
      const report = await screen.findByRole("region", { name: tr.title });
      expect(screen.getByText(tr.formatClaude)).toBeTruthy();
      expect(
        screen.getByText(
          fill(tr.repository, { repository: "https://github.com/obra/superpowers" }),
        ),
      ).toBeTruthy();
      const count = (g: string) =>
        CLAUDE_REVIEW.translation.items.filter((i) => i.group === g).length;
      for (const g of TRANSLATION_GROUPS) {
        const region = within(report).getByRole("region", {
          name: fill(tr.groupTitle, { group: tr.groups[g], n: count(g) }),
        });
        for (const i of CLAUDE_REVIEW.translation.items.filter((x) => x.group === g)) {
          expect(within(region).getByText(itemLine(locale, i))).toBeTruthy();
        }
      }
      // detail the message does not name is an extra line
      expect(within(report).getByText(fill(tr.detail.handlers, { value: "command" }))).toBeTruthy();
      expect(
        within(report).getByText(fill(tr.detail.problem, { value: "description is required" })),
      ).toBeTruthy();
    },
  );

  it("an item in a group this web does not know (a newer kernel) is listed under Other, not dropped (batch-3 m7)", async () => {
    const tr = en.catalog.admin.review.translation;
    stage({
      ...CLAUDE_REVIEW,
      translation: {
        ...CLAUDE_REVIEW.translation,
        items: [
          ...CLAUDE_REVIEW.translation.items,
          { group: "future", component: "skill", name: "later", code: "future_code" },
        ],
      },
    });
    await renderRouteWithCache(importPath(), lastStubRoutes());
    const other = await screen.findByRole("region", {
      name: fill(tr.groupTitle, { group: tr.groups.other, n: 1 }),
    });
    expect(
      within(other).getByText(
        fill(tr.item, { component: tr.components.skill, name: "later", reason: "future_code" }),
      ),
    ).toBeTruthy();
  });

  it("a SKILL.md body, description or LICENSE with bidi or control characters carries a warning line (batch-3 m9)", async () => {
    const tr = en.catalog.admin.review.translation;
    const [using, brainstorming] = CLAUDE_REVIEW.skills;
    stage({
      ...CLAUDE_REVIEW,
      licenseText: "MIT License\u202e",
      skills: [
        { ...using, body: "# Using\u2066 superpowers" },
        { ...brainstorming, description: "Use\u0007 before" },
      ],
    });
    await renderRouteWithCache(importPath(), lastStubRoutes());
    await screen.findByRole("button", { name: tr.license });
    expect(screen.getAllByText(tr.bidiWarning)).toHaveLength(3);
    cleanup();
    vi.unstubAllGlobals();
    stage(CLAUDE_REVIEW);
    await renderRouteWithCache(importPath(), lastStubRoutes());
    await screen.findByRole("button", { name: tr.license });
    expect(screen.queryByText(tr.bidiWarning)).toBeNull();
  });

  it("an empty group says so", async () => {
    const tr = en.catalog.admin.review.translation;
    stage({
      ...CLAUDE_REVIEW,
      translation: {
        ...CLAUDE_REVIEW.translation,
        items: CLAUDE_REVIEW.translation.items.slice(0, 1),
      },
    });
    await renderRouteWithCache(importPath(), lastStubRoutes());
    const warnings = await screen.findByRole("region", {
      name: fill(tr.groupTitle, { group: tr.groups.warnings, n: 0 }),
    });
    expect(within(warnings).getByText(tr.groupNone)).toBeTruthy();
  });

  it("suggest pinned checkboxes are sent as pinnedSuggestions on confirm", async () => {
    const tr = en.catalog.admin.review.translation;
    const calls = stage(CLAUDE_REVIEW);
    await renderRouteWithCache(importPath(), lastStubRoutes());
    const user = userEvent.setup();
    // no SessionStart hook: the suggestion is collapsed
    const toggle = await screen.findByRole("button", {
      name: fill(tr.pinnedTitle, { n: 1, total: 2 }),
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await user.click(toggle);
    const using = screen.getByRole("checkbox", {
      name: fill(tr.suggestPinned, { name: "using-superpowers" }),
    }) as HTMLInputElement;
    expect(using.checked).toBe(true);
    await user.click(using);
    await user.click(
      screen.getByRole("checkbox", { name: fill(tr.suggestPinned, { name: "brainstorming" }) }),
    );
    await user.click(screen.getByRole("button", { name: en.admin.extensions.wizard.next }));
    await user.click(screen.getByRole("button", { name: en.catalog.admin.review.confirm }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith(`/admin/plugins/${ID}`));
    expect(bodyOf(calls.find((x) => x.url.endsWith("/confirm")))).toEqual({
      reviewHash: "h1",
      scope: "optional",
      pinnedSuggestions: ["brainstorming"],
    });
  });

  it("confirming the plugin's own suggestion unchanged omits pinnedSuggestions; unticking every suggested skill sends [] (batch-3 m1)", async () => {
    const tr = en.catalog.admin.review.translation;
    const confirmWith = async (untick: boolean) => {
      const calls = stage(CLAUDE_REVIEW);
      await renderRouteWithCache(importPath(), lastStubRoutes());
      const user = userEvent.setup();
      const toggle = await screen.findByRole("button", {
        name: fill(tr.pinnedTitle, { n: 1, total: 2 }),
      });
      if (untick) {
        await user.click(toggle);
        await user.click(
          screen.getByRole("checkbox", {
            name: fill(tr.suggestPinned, { name: "using-superpowers" }),
          }),
        );
      }
      await user.click(screen.getByRole("button", { name: en.admin.extensions.wizard.next }));
      await user.click(screen.getByRole("button", { name: en.catalog.admin.review.confirm }));
      await waitFor(() => expect(router.push).toHaveBeenCalledWith(`/admin/plugins/${ID}`));
      const body = bodyOf(calls.find((x) => x.url.endsWith("/confirm")));
      cleanup();
      vi.unstubAllGlobals();
      resetNavigation("/");
      return body;
    };
    expect(await confirmWith(false)).toEqual({ reviewHash: "h1", scope: "optional" });
    expect(await confirmWith(true)).toEqual({
      reviewHash: "h1",
      scope: "optional",
      pinnedSuggestions: [],
    });
  });

  it("with a SessionStart hook the pinned suggestion is open and shows the hint", async () => {
    const tr = en.catalog.admin.review.translation;
    stage({
      ...CLAUDE_REVIEW,
      translation: { ...CLAUDE_REVIEW.translation, sessionStart: true },
    });
    await renderRouteWithCache(importPath(), lastStubRoutes());
    const toggle = await screen.findByRole("button", {
      name: fill(tr.pinnedTitle, { n: 1, total: 2 }),
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText(tr.sessionStartHint)).toBeTruthy();
    expect(
      screen.getByRole("checkbox", { name: fill(tr.suggestPinned, { name: "brainstorming" }) }),
    ).toBeTruthy();
  });

  it("each skill's SKILL.md and the license are collapsed and expandable", async () => {
    const tr = en.catalog.admin.review.translation;
    stage(CLAUDE_REVIEW);
    await renderRouteWithCache(importPath(), lastStubRoutes());
    const user = userEvent.setup();
    const license = await screen.findByRole("button", { name: tr.license });
    expect(license.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText(/Copyright \(c\) 2025/)).toBeNull();
    await user.click(license);
    expect(screen.getByText(/Copyright \(c\) 2025/)).toBeTruthy();
    const body = screen.getByRole("button", {
      name: fill(tr.skillBody, { name: "brainstorming" }),
    });
    expect(screen.queryByText(/Ask questions first/)).toBeNull();
    await user.click(body);
    expect(screen.getByText(/Ask questions first/)).toBeTruthy();
  });

  it("a truncated license says so; both manifests say the Claude one was ignored", async () => {
    const tr = en.catalog.admin.review.translation;
    stage({
      ...REVIEW,
      extension: undefined,
      sensitive: false,
      format: "capybara",
      licenseTruncated: true,
      claudeManifestIgnored: true,
    });
    await renderRouteWithCache(importPath(), lastStubRoutes());
    expect(await screen.findByText(tr.licenseTruncated)).toBeTruthy();
    expect(screen.getByText(tr.claudeManifestIgnored)).toBeTruthy();
    expect(screen.queryByRole("button", { name: tr.license })).toBeNull();
  });

  it("a native plugin review shows no translation section but still offers the pinned suggestion", async () => {
    const tr = en.catalog.admin.review.translation;
    stage({ ...REVIEW, extension: undefined, sensitive: false, format: "capybara" });
    await renderRouteWithCache(importPath(), lastStubRoutes());
    await screen.findByRole("region", { name: en.catalog.components.skills });
    expect(screen.queryByRole("region", { name: tr.title })).toBeNull();
    expect(screen.queryByText(tr.formatClaude)).toBeNull();
    expect(
      screen.getByRole("button", { name: fill(tr.pinnedTitle, { n: 0, total: 1 }) }),
    ).toBeTruthy();
  });

  it("every TranslationCode, detail key and MarketplaceSkipReason has zh and en text with its placeholders", () => {
    const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const locale of LOCALES) {
      const tr = msgs[locale].catalog.admin.review.translation as unknown as {
        codes: Record<string, string>;
        detail: Record<string, string>;
        groups: Record<string, string>;
      };
      expect(Object.keys(tr.codes).sort()).toEqual([...TRANSLATION_CODES].sort());
      for (const code of TRANSLATION_CODES) {
        expect(vars(tr.codes[code] as string), `${locale} ${code}`).toEqual(
          [...TRANSLATION_CODE_PLACEHOLDERS[code]].sort(),
        );
      }
      for (const k of TRANSLATION_DETAIL_KEYS)
        expect(vars(tr.detail[k] as string)).toEqual(["value"]);
      for (const g of TRANSLATION_GROUPS) expect(tr.groups[g]).toBeTruthy();
      const reasons = msgs[locale].catalog.admin.marketplaces.skipped.reasons as Record<
        string,
        string
      >;
      expect(Object.keys(reasons).sort()).toEqual([...MARKETPLACE_SKIP_REASONS].sort());
    }
  });
});

describe("phase B: Claude Code plugins in the catalog and marketplaces", () => {
  const claudeItemDetail = (version: Record<string, unknown> = {}) =>
    json(200, {
      item: {
        id: ID,
        name: "superpowers",
        publisher: "Jesse Vincent",
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
        latestVersion: "7.0.1",
        versions: ["7.0.1"],
        installs: 0,
        source: "git",
        marketplaceId: null,
        latestMarketplaceVersion: null,
        newerInMarketplace: false,
        contentChanged: false,
        componentCounts: { extension: 0, skills: 1, connectorTemplates: 0, agentTemplates: 0 },
        sourceFormat: "capybara",
        updatedAt: "2026-10-22T00:00:00.000Z",
        packageName: null,
        deletedAt: null,
      },
      versions: [
        {
          version: "7.0.1",
          source: "git",
          sourceRef: "obra/superpowers",
          integrity: null,
          contentDigest: "e".repeat(64),
          sourceDetail: null,
          manifest: {
            name: "superpowers",
            version: "7.0.1",
            publisher: "Jesse Vincent",
            description: "",
            skills: [{ path: "./skills/brainstorming" }],
          },
          size: 10,
          extensionSha256: null,
          importedAt: "2026-10-22T00:00:00.000Z",
          sourceFormat: "claude-code",
          translation: CLAUDE_REVIEW.translation,
          licenseText: "MIT License",
          ...version,
        },
      ],
      hasIcon: false,
    });

  it("item detail: a Claude Code version shows its format, report and license; the versions table has a format column", async () => {
    params.current = { itemId: ID };
    const tr = en.catalog.admin.review.translation;
    const d = en.catalog.admin.detail;
    stubApi({
      [`GET /api/v1/admin/catalog/items/${ID}`]: () => claudeItemDetail(),
      "GET /api/v1/admin/marketplaces": () => json(200, SOURCES),
      "GET /api/v1/admin/catalog/items": () => json(200, { items: [], nextOffset: null }),
    });
    await renderRouteWithCache(adminItemPath(), lastStubRoutes());
    const report = await screen.findByRole("region", { name: tr.title });
    expect(
      within(report).getByText(itemLine("en", CLAUDE_REVIEW.translation.items[0] as never)),
    ).toBeTruthy();
    // the head's Claude Code chip
    expect(screen.getByText(en.catalog.admin.chips.claudeCode)).toBeTruthy();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: tr.license }));
    expect(screen.getByText("MIT License")).toBeTruthy();
    await user.click(screen.getByRole("tab", { name: d.tabs.versions }));
    const table = screen.getByRole("table", { name: d.versionColumns.version });
    expect(within(table).getByText(d.versionColumns.format)).toBeTruthy();
    expect(within(table).getByText(d.format.claudeCode)).toBeTruthy();
  });

  it("item detail: a version whose LICENSE was too long to store says so (batch-3 m6)", async () => {
    params.current = { itemId: ID };
    const tr = en.catalog.admin.review.translation;
    stubApi({
      [`GET /api/v1/admin/catalog/items/${ID}`]: () =>
        claudeItemDetail({ licenseText: null, licenseTruncated: true }),
      "GET /api/v1/admin/marketplaces": () => json(200, SOURCES),
      "GET /api/v1/admin/catalog/items": () => json(200, { items: [], nextOffset: null }),
    });
    await renderRouteWithCache(adminItemPath(), lastStubRoutes());
    expect(await screen.findByText(tr.licenseTruncated)).toBeTruthy();
    expect(screen.queryByRole("button", { name: tr.license })).toBeNull();
  });

  it.each(LOCALES)(
    "marketplaces: entries the last refresh skipped are listed with the reason (%s)",
    async (locale) => {
      const s = msgs[locale].catalog.admin.marketplaces;
      const acme = SOURCES.items[1] as (typeof SOURCES.items)[number];
      stubApi({
        "GET /api/v1/admin/marketplaces": () =>
          json(200, {
            offline: false,
            items: [
              {
                ...acme,
                lastStatus: "ok",
                lastError: null,
                skipped: [
                  { name: "npm-thing", reason: "claude_npm_unpinned" },
                  { name: "Bad Name", reason: "invalid_name" },
                ],
              },
            ],
          }),
      });
      await renderRouteWithCache("/admin/plugins/sources", lastStubRoutes(), { locale });
      const title = {
        en: "2 entries were skipped by the last refresh",
        zh: fill(s.skipped.title, { n: 2 }),
      };
      expect(await screen.findByText(title[locale])).toBeTruthy();
      expect(
        screen.getByText(
          fill(s.skipped.line, {
            name: "npm-thing",
            reason: s.skipped.reasons.claude_npm_unpinned,
          }),
        ),
      ).toBeTruthy();
      expect(
        screen.getByText(
          fill(s.skipped.line, { name: "Bad Name", reason: s.skipped.reasons.invalid_name }),
        ),
      ).toBeTruthy();
    },
  );
  it("marketplaces: one skipped entry reads in the singular; a long list shows 20 and how many more, duplicate names included (batch-3 m2, m3)", async () => {
    const s = en.catalog.admin.marketplaces;
    const acme = SOURCES.items[1] as (typeof SOURCES.items)[number];
    const routes = (skipped: { name: string; reason: string }[]) => ({
      "GET /api/v1/admin/marketplaces": () =>
        json(200, {
          offline: false,
          items: [{ ...acme, lastStatus: "ok", lastError: null, skipped }],
        }),
    });
    stubApi(routes([{ name: "npm-thing", reason: "claude_npm_unpinned" }]));
    await renderRouteWithCache("/admin/plugins/sources", lastStubRoutes());
    expect(await screen.findByText("1 entry was skipped by the last refresh")).toBeTruthy();
    cleanup();
    vi.unstubAllGlobals();

    const many = Array.from({ length: 25 }, () => ({ name: "dup", reason: "invalid_entry" }));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    stubApi(routes(many));
    await renderRouteWithCache("/admin/plugins/sources", lastStubRoutes());
    expect(await screen.findByText("25 entries were skipped by the last refresh")).toBeTruthy();
    const line = fill(s.skipped.line, { name: "dup", reason: s.skipped.reasons.invalid_entry });
    expect(screen.getAllByText(line)).toHaveLength(20);
    expect(screen.getByText(fill(s.skipped.more, { n: 5 }))).toBeTruthy();
    // no duplicate React keys
    expect(errors.mock.calls.some((c) => String(c[0]).includes("same key"))).toBe(false);
  });
});

describe("/plugins/[itemId]/enable renders on the server (web-SSR spec §6)", () => {
  const detail = {
    item: orgItem({ name: "crm" }),
    hasIcon: false,
    extension: null,
    templates: [],
    dependencies: [],
    skills: ["skills/notes"],
  };
  const routes = {
    [`GET ${ORG}/catalog/${ID}`]: () => json(200, detail),
    [`GET ${ORG}/extensions`]: () => json(200, { extensions: [] }),
  };
  const as = (role: "member" | "admin"): Me => ({
    ...ME,
    account: { ...ME.account, isSuperAdmin: false },
    memberships: [{ ...ME.memberships[0], role } as Me["memberships"][number]],
  });

  const path = `/plugins/${ID}/enable`;

  it("a first render from the hydrated cache makes no browser read; it is a setup step", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRouteWithCache(path, routes, { readiness: NOT_READY });
    expect(screen.getByText(en.catalog.org.install.summarySkills.replace("{n}", "1"))).toBeTruthy();
    await settle();
    expect(browser).toEqual([]);
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("an empty cache shows the template's loading state, then the data", async () => {
    const { release } = await renderHeld(path, routes, `GET ${ORG}/catalog/${ID}`);
    await vi.waitFor(() => {
      if (template("WizardPage") === null) throw new Error("no page");
    });
    expect(document.querySelector("[aria-busy='true']")).not.toBeNull();
    await release();
    expect(
      await screen.findByText(en.catalog.org.install.summarySkills.replace("{n}", "1")),
    ).toBeTruthy();
    await vi.waitFor(() => expect(document.querySelector("[aria-busy='true']")).toBeNull());
  });

  it("the org extensions failing still renders the wizard; a missing item is the not-found state", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRouteWithCache(path, {
      ...routes,
      [`GET ${ORG}/extensions`]: () => json(503, { error: { code: "internal" } }),
    });
    expect(template("WizardPage")).not.toBeNull();
    await settle();
    // a section that failed on the first load is not read again on mount
    expect(browser).toEqual([]);
    cleanup();
    await renderRouteWithCache(path, {
      [`GET ${ORG}/catalog/${ID}`]: () => json(404, { error: { code: "catalog.not_found" } }),
      [`GET ${ORG}/extensions`]: () => json(200, { extensions: [] }),
    });
    expect(screen.getByRole("heading", { level: 1, name: en.notFound.title })).toBeTruthy();
  });

  it("a member gets no access and nothing is read; no org renders nothing", async () => {
    const member = await renderRouteWithCache(path, routes, { me: as("member") });
    expect(new Set(member.calls.map((c) => c.url))).toEqual(
      new Set(["/api/v1/me", `${ORG}/readiness`]),
    );
    expect(template("StatusPage")?.getAttribute("data-kind")).toBe("no-access");
    cleanup();
    const none = await renderRouteWithCache(path, routes, { me: { ...ME, currentOrgId: null } });
    expect(none.calls.map((c) => c.url)).toEqual(["/api/v1/me"]);
  });
});

describe("/plugins and /plugins/[itemId] render on the server (web-SSR spec §6)", () => {
  const detail = {
    item: orgItem({ name: "crm" }),
    hasIcon: false,
    extension: "crm",
    templates: [],
    dependencies: [],
    skills: [],
  };
  const routes = {
    [`GET ${ORG}/catalog`]: () => json(200, { items: [orgItem()] }),
    [`GET ${ORG}/catalog/${ID}`]: () => json(200, detail),
    // org admins also read the extensions, the marketplace entries and the installs
    [`GET ${ORG}/extensions`]: () => json(200, { extensions: [] }),
    [`GET ${ORG}/marketplaces/entries`]: () => json(200, { items: [] }),
    [`GET ${ORG}/plugin-installs`]: () => json(200, { installs: [] }),
  };
  const GUEST: Me = {
    ...ME,
    account: { ...ME.account, isSuperAdmin: false },
    memberships: [{ ...ME.memberships[0], role: "guest" } as Me["memberships"][number]],
  };

  it("/plugins: a first render from the hydrated cache makes no browser read; it is a setup step", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRouteWithCache("/plugins", routes, { readiness: NOT_READY });
    expect(within(screen.getByRole("list", { name: en.plugins.title })).getByText("pdf-tools"));
    await settle();
    expect(browser).toEqual([]);
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("/plugins: an empty cache shows the template's loading state, then the data", async () => {
    const { release } = await renderHeld("/plugins", routes, `GET ${ORG}/catalog`);
    await vi.waitFor(() => {
      if (template("ListPage") === null) throw new Error("no page");
    });
    expect(document.querySelector("[aria-busy='true']")).not.toBeNull();
    expect(screen.queryByText("pdf-tools")).toBeNull();
    await release();
    expect(await screen.findByText("pdf-tools")).toBeTruthy();
    await vi.waitFor(() => expect(document.querySelector("[aria-busy='true']")).toBeNull());
  });

  it("/plugins: a guest gets no access and nothing is read; no org renders nothing", async () => {
    const guest = await renderRouteWithCache("/plugins", routes, { me: GUEST });
    expect(new Set(guest.calls.map((c) => c.url))).toEqual(
      new Set(["/api/v1/me", `${ORG}/readiness`]),
    );
    expect(template("StatusPage")?.getAttribute("data-kind")).toBe("no-access");
    cleanup();
    const none = await renderRouteWithCache("/plugins", routes, {
      me: { ...ME, currentOrgId: null },
    });
    expect(none.calls.map((c) => c.url)).toEqual(["/api/v1/me"]);
    expect(document.body.textContent).toBe("");
  });

  it("/plugins/<id>: a first render from the hydrated cache makes no browser read; it is a setup step", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRouteWithCache(`/plugins/${ID}`, routes, { readiness: NOT_READY });
    expect(screen.getByRole("heading", { level: 1, name: "crm" })).toBeTruthy();
    expect(screen.getByText("· crm")).toBeTruthy();
    await settle();
    expect(browser).toEqual([]);
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("/plugins/<id>: an empty cache shows the template's loading state, then the data", async () => {
    const { release } = await renderHeld(`/plugins/${ID}`, routes, `GET ${ORG}/catalog/${ID}`);
    await vi.waitFor(() => {
      if (template("DetailPage") === null) throw new Error("no page");
    });
    expect(document.querySelector("[aria-busy='true']")).not.toBeNull();
    expect(screen.queryByRole("heading", { level: 1, name: "crm" })).toBeNull();
    // the overview's static parts: the install action's button and the five component sections;
    // the inspector's three facts; no generic cards
    const page = template("DetailPage") as HTMLElement;
    expect(page.querySelectorAll('[data-part="loading-card"]')).toHaveLength(0);
    expect(page.querySelectorAll('[data-part="loading-buttons"]')).toHaveLength(1);
    const stack = page.querySelector('[data-part="loading-buttons"]')?.closest(".cb-stack")
      ?.parentElement as HTMLElement;
    expect(stack.children).toHaveLength(7);
    expect(page.querySelectorAll('[data-part="loading-inspector-row"]')).toHaveLength(3);
    await release();
    expect(await screen.findByRole("heading", { level: 1, name: "crm" })).toBeTruthy();
    await vi.waitFor(() => expect(document.querySelector("[aria-busy='true']")).toBeNull());
  });

  it("/plugins/<id>: an item the kernel does not find is the not-found state in the shell", async () => {
    expectNoFirstPaintFetch();
    await renderRouteWithCache(`/plugins/${ID}`, {
      ...routes,
      [`GET ${ORG}/catalog/${ID}`]: () =>
        json(404, { error: { code: "catalog.item_not_found", message: "x" } }),
    });
    expect(screen.getByRole("heading", { level: 1, name: en.notFound.title })).toBeTruthy();
  });

  it("/plugins/<id>: a guest gets no access and nothing is read; no org renders nothing", async () => {
    const guest = await renderRouteWithCache(`/plugins/${ID}`, routes, { me: GUEST });
    expect(new Set(guest.calls.map((c) => c.url))).toEqual(
      new Set(["/api/v1/me", `${ORG}/readiness`]),
    );
    expect(template("StatusPage")?.getAttribute("data-kind")).toBe("no-access");
    cleanup();
    const none = await renderRouteWithCache(`/plugins/${ID}`, routes, {
      me: { ...ME, currentOrgId: null },
    });
    expect(none.calls.map((c) => c.url)).toEqual(["/api/v1/me"]);
    expect(document.body.textContent).toBe("");
  });

  it("a member asking to turn it on invalidates the catalog and the item: the item is read again", async () => {
    params.current = { itemId: ID };
    const calls = stubApi({
      [`GET ${ORG}/catalog/${ID}`]: () =>
        json(200, { ...detail, extension: null, item: orgItem({ name: "crm" }) }),
      [`POST ${ORG}/catalog/${ID}/requests`]: () =>
        json(201, { request: { id: "r1" }, created: true }),
    });
    const { client } = await renderItem({ me: MEMBER });
    client.setQueryData(["org", "o1", "catalog"], { items: [orgItem()] });
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: en.plugins.action.requestEnable }));
    await vi.waitFor(() =>
      expect(calls.filter((c) => c.method === "GET").map((c) => c.url)).toEqual([
        `${ORG}/catalog/${ID}`,
      ]),
    );
    expect(client.getQueryState(["org", "o1", "catalog"])?.isInvalidated).toBe(true);
  });
});

describe("/admin/plugins: installed, detail with scope, pending", () => {
  const P = en.catalog.admin;
  const item = (over: Record<string, unknown> = {}) => ({
    id: ID,
    name: "jina",
    publisher: "Jina AI",
    displayName: null,
    description: "Web tools",
    scope: "optional",
    scopeOrgs: [],
    builtin: false,
    disabled: false,
    shownToOthers: true,
    enabledOrgs: 3,
    pending: false,
    permissionsHash: null,
    latestVersion: "1.2.0",
    versions: ["1.2.0"],
    installs: 3,
    source: "marketplace",
    marketplaceId: "official",
    latestMarketplaceVersion: "1.3.0",
    newerInMarketplace: true,
    contentChanged: false,
    componentCounts: { extension: 0, skills: 1, connectorTemplates: 0, agentTemplates: 0 },
    sourceFormat: "capybara",
    updatedAt: "2026-10-22T00:00:00.000Z",
    ...over,
  });
  const BUILTIN = item({
    id: "22222222-2222-4222-8222-222222222222",
    name: "openai-compatible",
    scope: "all",
    builtin: true,
    newerInMarketplace: false,
    latestMarketplaceVersion: null,
  });
  const PENDING = item({
    id: "33333333-3333-4333-8333-333333333333",
    name: "object-store-s3",
    scope: "all",
    builtin: true,
    pending: true,
    permissionsHash: "ph1",
    newerInMarketplace: false,
  });
  const REQUEST = {
    id: "r1",
    orgId: "o2",
    orgName: "Beta",
    kind: "access",
    item: { id: ID, name: "jina", displayName: null },
    entry: null,
    status: "pending",
    note: "We need it",
    reason: null,
    requestedBy: "a2",
    requestedByName: "Mia",
    decidedBy: null,
    decidedAt: null,
    stagingId: null,
    createdAt: "2026-10-22T00:00:00.000Z",
  };
  const ORGS = {
    orgs: [
      { id: "o1", slug: "acme", name: "Acme", memberCount: 3, createdAt: "2026-10-01T00:00:00Z" },
      { id: "o2", slug: "beta", name: "Beta", memberCount: 4, createdAt: "2026-10-01T00:00:00Z" },
    ],
  };
  const detail = (i: ReturnType<typeof item>) => ({
    item: { ...i, packageName: "@jina-ai/capybara-plugin", deletedAt: null },
    versions: [
      {
        version: i.latestVersion,
        source: "marketplace",
        sourceRef: "official",
        integrity: null,
        contentDigest: null,
        sourceDetail: null,
        manifest: {
          name: i.name,
          version: i.latestVersion,
          publisher: "Jina AI",
          description: "",
          extension: {
            entry: "dist/index.js",
            manifest: {
              name: "jina-web",
              version: "1.2.0",
              sdk: "^0.1.0",
              provides: [],
              requires: [],
              optional: [],
              permissions: { tools: ["search"] },
            },
          },
          skills: [{ path: "./skills/web-research" }],
        },
        size: 1024,
        extensionSha256: "a".repeat(64),
        importedAt: "2026-10-22T00:00:00.000Z",
      },
    ],
    hasIcon: false,
  });
  const listRoutes = {
    "GET /api/v1/admin/catalog/items": () =>
      json(200, {
        items: [
          item({
            componentCounts: { extension: 1, skills: 2, connectorTemplates: 0, agentTemplates: 1 },
          }),
          BUILTIN,
          PENDING,
          item({
            id: "44444444-4444-4444-8444-444444444444",
            name: "superpowers",
            sourceFormat: "claude-code",
            newerInMarketplace: false,
          }),
        ],
        nextOffset: null,
      }),
    "GET /api/v1/admin/catalog/items?pending=true": () =>
      json(200, { items: [PENDING], nextOffset: null }),
    "GET /api/v1/admin/catalog/requests": () => json(200, { requests: [REQUEST] }),
    "GET /api/v1/admin/marketplaces": () => json(200, SOURCES),
    "GET /api/v1/admin/orgs": () => json(200, ORGS),
  };

  it("list: the tabs 已安装 / 市场 / 待确认 with counts, the actions, the 内置 chip and the states", async () => {
    stubApi(listRoutes);
    await renderRouteWithCache("/admin/plugins", lastStubRoutes());
    const list = await screen.findByRole("list", { name: P.title });
    const tab = (name: string) =>
      screen.getByRole("link", { name: new RegExp(`^${escapeRe(name)}`) });
    expect(tab(P.tabs.installed).getAttribute("href")).toBe("/admin/plugins");
    expect(tab(P.tabs.installed).getAttribute("aria-current")).toBeTruthy();
    expect(tab(P.tabs.installed).textContent).toMatch(/4/);
    expect(tab(P.tabs.market).getAttribute("href")).toBe("/admin/plugins/market");
    // pending items + pending requests
    expect(tab(P.tabs.pending).getAttribute("href")).toBe("/admin/plugins/pending");
    expect(tab(P.tabs.pending).textContent).toMatch(/2/);
    expect(screen.getByRole("link", { name: P.actions.addSource }).getAttribute("href")).toBe(
      "/admin/plugins/sources",
    );
    expect(screen.getByRole("link", { name: P.actions.upload }).getAttribute("href")).toBe(
      "/admin/plugins/import",
    );
    const row = (name: string) => within(list).getByText(name).closest("li") as HTMLElement;
    expect(within(row("openai-compatible")).getByText(P.chips.builtin)).toBeTruthy();
    expect(within(row("jina")).queryByText(P.chips.builtin)).toBeNull();
    expect(within(row("openai-compatible")).getByText(P.state.running)).toBeTruthy();
    expect(within(row("jina")).getByText(fill(P.state.update, { version: "v1.3.0" }))).toBeTruthy();
    expect(within(row("jina")).getByText(/3 orgs using it/)).toBeTruthy();
    // meta: version · source · components · scope · orgs using it
    expect(
      within(row("jina")).getByText(
        /^v1\.2\.0 · .+ · 1 extension · 2 skills · 1 agent template · Organizations choose · 3 orgs using it$/,
      ),
    ).toBeTruthy();
    expect(within(row("superpowers")).getByText(P.chips.claudeCode)).toBeTruthy();
    expect(within(row("jina")).queryByText(P.chips.claudeCode)).toBeNull();
    expect(within(row("object-store-s3")).getByText(P.state.pending)).toBeTruthy();
    expect(
      within(row("object-store-s3")).getByRole("link", { name: P.rowConfirm }).getAttribute("href"),
    ).toBe("/admin/plugins/pending");
  });

  it("detail: 设置范围 previews the affected orgs and agents, then confirms with the scopeHash", async () => {
    params.current = { itemId: ID };
    const calls = stubApi({
      ...listRoutes,
      [`GET /api/v1/admin/catalog/items/${ID}`]: () => json(200, detail(item())),
      [`POST /api/v1/admin/catalog/items/${ID}/scope/preview`]: () =>
        json(200, {
          affected: [{ orgId: "o1", orgName: "Acme", agents: [{ id: "ag1", name: "Researcher" }] }],
          needsConfig: [],
          scopeHash: "sh1",
        }),
      [`PUT /api/v1/admin/catalog/items/${ID}/scope`]: () =>
        json(200, item({ scope: "named", scopeOrgs: ["o2"] })),
    });
    await renderRouteWithCache(adminItemPath(), lastStubRoutes());
    const user = userEvent.setup();
    // the tabs 组件 / 组织 / 版本; the components table lists the extension and the skill
    expect(
      await screen.findByRole("tab", { name: new RegExp(P.detail.tabs.components) }),
    ).toBeTruthy();
    expect(screen.getByRole("tab", { name: new RegExp(P.detail.tabs.orgs) })).toBeTruthy();
    expect(screen.getByRole("tab", { name: new RegExp(P.detail.tabs.versions) })).toBeTruthy();
    const table = screen.getByRole("table", { name: P.detail.tabs.components });
    expect(within(table).getByText("jina-web")).toBeTruthy();
    expect(within(table).getByText("web-research")).toBeTruthy();
    // a newer marketplace version is imported first (the platform update comes after the import)
    expect(
      screen.getByRole("button", { name: fill(P.detail.actions.import, { version: "v1.3.0" }) }),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: P.detail.actions.scope }));
    const dialog = await screen.findByRole("dialog");
    await user.click(
      within(dialog).getByRole("radio", { name: new RegExp(en.catalog.scope.named) }),
    );
    await user.click(await within(dialog).findByRole("checkbox", { name: "Beta" }));
    await user.click(within(dialog).getByRole("button", { name: P.scopeDialog.next }));
    expect(await within(dialog).findByText("Acme")).toBeTruthy();
    expect(within(dialog).getByText(/Researcher/)).toBeTruthy();
    const preview = calls.find((c) => c.url.endsWith("/scope/preview"));
    expect(bodyOf(preview)).toEqual({ scope: "named", orgs: ["o2"] });
    await user.click(within(dialog).getByRole("button", { name: P.scopeDialog.confirm }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === "PUT" && c.url.endsWith("/scope"))).toBe(true),
    );
    const put = calls.find((c) => c.method === "PUT" && c.url.endsWith("/scope"));
    expect(bodyOf(put)).toEqual({ scope: "named", orgs: ["o2"], scopeHash: "sh1" });
  });

  it("detail: a builtin plugin has the 内置 chip and no 设置范围 or 停用", async () => {
    params.current = { itemId: BUILTIN.id };
    stubApi({
      ...listRoutes,
      [`GET /api/v1/admin/catalog/items/${BUILTIN.id}`]: () => json(200, detail(BUILTIN)),
    });
    await renderRouteWithCache(adminItemPath(), lastStubRoutes());
    expect(await screen.findByText(P.chips.builtin)).toBeTruthy();
    expect(screen.queryByRole("button", { name: P.detail.actions.scope })).toBeNull();
    expect(screen.queryByRole("button", { name: P.detail.actions.disable })).toBeNull();
  });

  it("detail: 停用 previews what it takes away and sends the hash", async () => {
    params.current = { itemId: ID };
    const calls = stubApi({
      ...listRoutes,
      [`GET /api/v1/admin/catalog/items/${ID}`]: () => json(200, detail(item())),
      [`POST /api/v1/admin/catalog/items/${ID}/scope/preview`]: () =>
        json(200, {
          affected: [{ orgId: "o1", orgName: "Acme", agents: [] }],
          needsConfig: [],
          scopeHash: "dh1",
        }),
      [`PUT /api/v1/admin/catalog/items/${ID}/disabled`]: () => json(200, item({ disabled: true })),
    });
    await renderRouteWithCache(adminItemPath(), lastStubRoutes());
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: P.detail.actions.disable }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("Acme")).toBeTruthy();
    expect(bodyOf(calls.find((c) => c.url.endsWith("/scope/preview")))).toEqual({
      disabled: true,
    });
    await user.click(within(dialog).getByRole("button", { name: P.disableDialog.confirm }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === "PUT" && c.url.endsWith("/disabled"))).toBe(true),
    );
    expect(bodyOf(calls.find((c) => c.url.endsWith("/disabled")))).toEqual({
      disabled: true,
      scopeHash: "dh1",
    });
  });

  it("detail: a stale 设置范围 (409 plugin.scope_stale) previews again and the second confirm sends the new hash", async () => {
    params.current = { itemId: ID };
    let n = 0;
    const calls = stubApi({
      ...listRoutes,
      [`GET /api/v1/admin/catalog/items/${ID}`]: () => json(200, detail(item())),
      [`POST /api/v1/admin/catalog/items/${ID}/scope/preview`]: () => {
        n += 1;
        return json(200, {
          affected: n === 1 ? [] : [{ orgId: "o1", orgName: "Acme", agents: [] }],
          needsConfig: [],
          scopeHash: `sh${n}`,
        });
      },
      [`PUT /api/v1/admin/catalog/items/${ID}/scope`]: (c) =>
        (bodyOf(c) as { scopeHash: string }).scopeHash === "sh1"
          ? json(409, { error: { code: "plugin.scope_stale", message: "stale" } })
          : json(200, item({ scope: "all" })),
    });
    await renderRouteWithCache(adminItemPath(), lastStubRoutes());
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: P.detail.actions.scope }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("radio", { name: new RegExp(en.catalog.scope.all) }));
    await user.click(within(dialog).getByRole("button", { name: P.scopeDialog.next }));
    await user.click(await within(dialog).findByRole("button", { name: P.scopeDialog.confirm }));
    expect(await within(dialog).findByText(P.scopeDialog.stale)).toBeTruthy();
    expect(await within(dialog).findByText("Acme")).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: P.scopeDialog.confirm }));
    await waitFor(() =>
      expect(
        calls.filter((c) => c.method === "PUT").map((c) => bodyOf(c) as { scopeHash: string }),
      ).toEqual([
        { scope: "all", scopeHash: "sh1" },
        { scope: "all", scopeHash: "sh2" },
      ]),
    );
  });

  it("detail: a stale 停用 (409 plugin.scope_stale) previews again and the second confirm sends the new hash", async () => {
    params.current = { itemId: ID };
    let n = 0;
    const calls = stubApi({
      ...listRoutes,
      [`GET /api/v1/admin/catalog/items/${ID}`]: () => json(200, detail(item())),
      [`POST /api/v1/admin/catalog/items/${ID}/scope/preview`]: () => {
        n += 1;
        return json(200, {
          affected: n === 1 ? [] : [{ orgId: "o1", orgName: "Acme", agents: [] }],
          needsConfig: [],
          scopeHash: `dh${n}`,
        });
      },
      [`PUT /api/v1/admin/catalog/items/${ID}/disabled`]: (c) =>
        (bodyOf(c) as { scopeHash: string }).scopeHash === "dh1"
          ? json(409, { error: { code: "plugin.scope_stale", message: "stale" } })
          : json(200, item({ disabled: true })),
    });
    await renderRouteWithCache(adminItemPath(), lastStubRoutes());
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: P.detail.actions.disable }));
    const dialog = await screen.findByRole("dialog");
    const confirm = () => within(dialog).getByRole("button", { name: P.disableDialog.confirm });
    await waitFor(() => expect((confirm() as HTMLButtonElement).disabled).toBe(false));
    await user.click(confirm());
    expect(await within(dialog).findByText(P.scopeDialog.stale)).toBeTruthy();
    expect(await within(dialog).findByText("Acme")).toBeTruthy();
    await user.click(confirm());
    await waitFor(() =>
      expect(
        calls.filter((c) => c.method === "PUT").map((c) => bodyOf(c) as { scopeHash: string }),
      ).toEqual([
        { disabled: true, scopeHash: "dh1" },
        { disabled: true, scopeHash: "dh2" },
      ]),
    );
  });

  it("detail: when only 对其他组织显示 changes the scope is not sent again", async () => {
    params.current = { itemId: ID };
    const named = item({ scope: "named", scopeOrgs: ["o2"], shownToOthers: true });
    const calls = stubApi({
      ...listRoutes,
      [`GET /api/v1/admin/catalog/items/${ID}`]: () => json(200, detail(named)),
      [`POST /api/v1/admin/catalog/items/${ID}/scope/preview`]: () =>
        json(200, { affected: [], needsConfig: [], scopeHash: "s0" }),
      [`PUT /api/v1/admin/catalog/items/${ID}/shown`]: () =>
        json(200, { ...named, shownToOthers: false }),
    });
    await renderRouteWithCache(adminItemPath(), lastStubRoutes());
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: P.detail.actions.scope }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("switch", { name: P.scopeDialog.shown }));
    await user.click(within(dialog).getByRole("button", { name: P.scopeDialog.next }));
    await user.click(await within(dialog).findByRole("button", { name: P.scopeDialog.confirm }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/shown"))).toBe(true));
    expect(calls.some((c) => c.method === "PUT" && c.url.endsWith("/scope"))).toBe(false);
    expect(bodyOf(calls.find((c) => c.url.endsWith("/shown")))).toEqual({ shownToOthers: false });
  });

  it("pending: confirming permissions sends the permissionsHash; rejecting a request sends the reason", async () => {
    const calls = stubApi({
      ...listRoutes,
      [`GET /api/v1/admin/catalog/items/${PENDING.id}`]: () => json(200, detail(PENDING)),
      [`POST /api/v1/admin/catalog/items/${PENDING.id}/confirm`]: () =>
        json(200, { ...PENDING, pending: false }),
      "POST /api/v1/admin/catalog/requests/r1/decide": () =>
        json(200, { request: { ...REQUEST, status: "rejected" } }),
    });
    await renderRouteWithCache("/admin/plugins/pending", lastStubRoutes());
    const user = userEvent.setup();
    const list = await screen.findByRole("list", { name: P.pending.listLabel });
    const s3 = within(list).getByText("object-store-s3").closest("li") as HTMLElement;
    await user.click(within(s3).getByRole("button", { name: P.pending.review }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText(/search/)).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: P.pending.confirm }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/confirm"))).toBe(true));
    expect(bodyOf(calls.find((c) => c.url.endsWith("/confirm")))).toEqual({
      permissionsHash: "ph1",
    });
    const req = within(list).getByText(/Beta/).closest("li") as HTMLElement;
    await user.click(within(req).getByRole("button", { name: P.pending.reject }));
    const reject = await screen.findByRole("dialog");
    await user.type(within(reject).getByRole("textbox"), "Not now");
    await user.click(within(reject).getByRole("button", { name: P.pending.reject }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/decide"))).toBe(true));
    expect(bodyOf(calls.find((c) => c.url.endsWith("/decide")))).toEqual({
      approve: false,
      reason: "Not now",
    });
  });

  it("import review: a staging prepared for an org's request defaults to 指定组织 = that org; a lower version says it only joins the catalog", async () => {
    window.history.replaceState(null, "", "/admin/plugins/import?staging=st8");
    const calls = stubApi({
      ...listRoutes,
      "GET /api/v1/admin/catalog/requests": () =>
        json(200, {
          requests: [
            {
              ...REQUEST,
              kind: "import",
              item: null,
              entry: { marketplaceId: "official", name: "crm", version: "1.0.0" },
              stagingId: "st8",
            },
          ],
        }),
      "GET /api/v1/admin/catalog/imports/st8": () =>
        json(200, {
          stagingId: "st8",
          review: {
            ...REVIEW,
            sensitive: false,
            extension: extension({
              action: "keep",
              olderThanDeployed: true,
              sensitive: false,
              permissions: [],
            }),
          },
        }),
      "POST /api/v1/admin/catalog/imports/st8/confirm": () =>
        json(200, { item: item({ name: "crm" }), deploy: null }),
    });
    const { client } = await renderRouteWithCache(importPath(), lastStubRoutes());
    // the head's pending list as the nav would have it
    await client.prefetchQuery({
      queryKey: ["deployment", "catalogPending"],
      queryFn: () => ({ items: [], nextOffset: null }),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: en.admin.extensions.wizard.next }));
    expect(screen.getByText(P.review.olderThanDeployed)).toBeTruthy();
    expect(screen.getByText(fill(P.review.requestDefault, { org: "Beta" }))).toBeTruthy();
    const named = screen.getByRole("radio", { name: new RegExp(en.catalog.scope.named) });
    expect((named as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: "Beta" }) as HTMLInputElement).checked).toBe(true);
    await user.click(screen.getByRole("button", { name: P.review.confirm }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/st8/confirm"))).toBe(true));
    expect(bodyOf(calls.find((c) => c.url.endsWith("/st8/confirm")))).toMatchObject({
      scope: "named",
      orgs: ["o2"],
    });
    // the request it answered leaves 待确认 (and the nav count): both lists are invalidated
    await waitFor(() => {
      const after = calls.slice(calls.findIndex((c) => c.url.endsWith("/st8/confirm")));
      // read on this page: read again
      expect(after.map((c) => c.url)).toContain("/api/v1/admin/catalog/requests?status=pending");
      // not shown here: marked stale
      expect(client.getQueryState(["deployment", "catalogPending"])?.isInvalidated).toBe(true);
    });
  });

  it("pending: approving an import request opens the import review of its staging", async () => {
    const importRequest = {
      ...REQUEST,
      kind: "import",
      item: null,
      entry: { marketplaceId: "official", name: "slack", version: "0.4.0" },
    };
    stubApi({
      ...listRoutes,
      "GET /api/v1/admin/catalog/requests": () => json(200, { requests: [importRequest] }),
      "POST /api/v1/admin/catalog/requests/r1/decide": () =>
        json(200, {
          request: importRequest,
          import: { stagingId: "st7", review: REVIEW, permissionsMismatch: null },
        }),
    });
    await renderRouteWithCache("/admin/plugins/pending", lastStubRoutes());
    const list = await screen.findByRole("list", { name: P.pending.listLabel });
    const req = within(list).getByText(/slack/).closest("li") as HTMLElement;
    await userEvent.setup().click(within(req).getByRole("button", { name: P.pending.approve }));
    await waitFor(() =>
      expect(router.push).toHaveBeenCalledWith("/admin/plugins/import?staging=st7"),
    );
  });
});
