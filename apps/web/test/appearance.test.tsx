// Themes (spec docs/superpowers/specs/2026-11-08-themes-design.md §7, §10): the three 外观
// levels (组织设置 › 外观, 偏好设置 › 外观, 部署设置 › 外观) and the admin 主题 pages.
import { act, cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { PlatformUpdatePreviewBody } from "../src/components/PlatformUpdateDialog";
import { orgThemesQuery, platformThemeQuery } from "../src/lib/query/themes";
import { bodyOf, json, stubApi } from "./support/api";
import { resetNavigation } from "./support/navigation";
import { renderRouteEmptyCache, renderRouteWithCache } from "./support/query";
import { ME, renderPage } from "./support/render";
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

const A = zh.appearance;
const O = "/api/v1/orgs/o1";
const T = "2026-11-08T00:00:00.000Z";
const settle = () => act(() => new Promise((r) => setTimeout(r, 20)));
const template = (name: string) => document.querySelector(`[data-template="${name}"]`);
const member = {
  ...ME,
  account: { ...ME.account, isSuperAdmin: false },
  memberships: [{ orgId: "o1", slug: "acme", name: "Acme", role: "member" as const }],
};

const ref = (id: string, en: string, zhName: string, schemes: ("dark" | "light")[]) => ({
  id,
  version: "1",
  name: { en, zh: zhName },
  schemes,
  singleScheme: schemes.length === 1 ? schemes[0] : null,
  logo: null,
  cssUrl: `/api/v1/themes/${id}/1/r2/theme.css`,
});
const sw = (bg: string) => ({ bg, panel: "#111", ink: "#eee", accent: "#f60" });
const NIGHT = {
  ...ref("t-night", "Night City", "夜之城", ["dark"]),
  swatches: { dark: sw("#05070d") },
};
const PAPER = {
  ...ref("t-paper", "Paper", "纸", ["dark", "light"]),
  swatches: { dark: sw("#1a1a1a"), light: sw("#fafafa") },
};

const themesOf = (org: { id: string | null; personal: "allowed" | "locked" }) => ({
  themes: [NIGHT, PAPER],
  resolved: null,
  org,
});

const orgComp = (over: Record<string, unknown>) => ({
  kind: "theme",
  id: "t-night",
  name: "night-city",
  description: null,
  plugin: "fake-theme",
  itemId: "11111111-1111-4111-8111-111111111111",
  version: "1",
  scopeMode: "follow",
  switch: null,
  on: true,
  locked: false,
  pluginOn: true,
  switchable: true,
  platformDefault: true,
  ...over,
});
const ORG_COMPONENTS = {
  components: [
    orgComp({ locked: true, switchable: false }),
    orgComp({ id: "t-paper", name: "paper" }),
  ],
};

const orgRoutes = (
  org: { id: string | null; personal: "allowed" | "locked" } = { id: null, personal: "allowed" },
  // the platform default (public read); the fixture's is Night City, locked on in the org
  platformDefault: unknown = NIGHT,
  components: unknown = ORG_COMPONENTS,
): Routes => ({
  [`GET ${O}/themes`]: () => json(200, themesOf(org)),
  [`GET ${O}/components?kind=theme`]: () => json(200, components),
  "GET /api/v1/platform/theme": () => json(200, platformDefault),
  [`GET ${O}/settings`]: () => json(200, { settings: { toolSearch: "on", locale: "zh" } }),
});

beforeEach(() => resetNavigation("/"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("/settings/appearance (组织设置 › 外观)", () => {
  it("a first render from the hydrated cache makes no browser read; the themes with their switches, the platform default locked", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRouteWithCache("/settings/appearance", orgRoutes(), { locale: "zh" });
    expect(await screen.findByRole("heading", { name: A.themes.title })).toBeTruthy();
    const list = screen.getByRole("list", { name: A.themes.label });
    const night = within(list).getByRole("switch", { name: "夜之城" });
    expect(night.getAttribute("aria-checked")).toBe("true");
    expect((night as HTMLButtonElement).disabled).toBe(true);
    expect(within(list).getByText(A.themes.lockedDefault)).toBeTruthy();
    expect((within(list).getByRole("switch", { name: "纸" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    const picker = screen.getByRole("radiogroup", { name: A.org.label });
    const radios = within(picker).getAllByRole("radio");
    expect(radios.map((r) => r.textContent)).toEqual([A.followPlatform, "夜之城", "纸"]);
    expect(radios[0]?.getAttribute("aria-checked")).toBe("true");
    await settle();
    expect(browser).toEqual([]);
  });

  it("an empty cache shows the template's loading state, then the data", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const routes = orgRoutes();
    const answer = routes[`GET ${O}/themes`] as NonNullable<Routes[string]>;
    await renderRouteEmptyCache(
      "/settings/appearance",
      {
        ...routes,
        [`GET ${O}/themes`]: async (c) => {
          await gate;
          return answer(c);
        },
      },
      { locale: "zh" },
    );
    await vi.waitFor(() => expect(template("SettingsPage")).not.toBeNull());
    expect(document.querySelector("[aria-busy='true']")).not.toBeNull();
    expect(screen.queryByRole("radiogroup")).toBeNull();
    await act(async () => release());
    expect(await screen.findByRole("radiogroup", { name: A.org.label })).toBeTruthy();
  });

  it("an org admin sets night-city with 允许成员自选 off; the save invalidates the org's themes", async () => {
    let org: { id: string | null; personal: "allowed" | "locked" } = {
      id: null,
      personal: "allowed",
    };
    const routes: Routes = {
      ...orgRoutes(),
      [`GET ${O}/themes`]: () => json(200, themesOf(org)),
      [`PATCH ${O}/settings`]: (c) => {
        org = (JSON.parse(String(c.body)) as { theme: typeof org }).theme;
        return json(200, { settings: { toolSearch: "on", locale: "zh", theme: org } });
      },
    };
    const calls = stubApi(routes);
    await renderRouteWithCache("/settings/appearance", routes, { locale: "zh" });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("radio", { name: /夜之城/ }));
    await user.click(screen.getByRole("switch", { name: A.org.personal }));
    await user.click(screen.getByRole("button", { name: A.save }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(bodyOf(calls.find((c) => c.method === "PATCH"))).toEqual({
      theme: { id: "t-night", personal: "locked" },
    });
    await vi.waitFor(() =>
      expect(calls.filter((c) => c.method === "GET" && c.url.endsWith(`${O}/themes`))).toHaveLength(
        1,
      ),
    );
  });

  it("an unavailable default is named and the org follows the platform", async () => {
    await renderRouteWithCache(
      "/settings/appearance",
      orgRoutes({ id: "t-gone", personal: "allowed" }),
      {
        locale: "zh",
      },
    );
    expect(await screen.findByText(A.org.unavailable.replace("{name}", "t-gone"))).toBeTruthy();
    const picker = screen.getByRole("radiogroup", { name: A.org.label });
    expect(within(picker).getAllByRole("radio")[0]?.getAttribute("aria-checked")).toBe("true");
  });

  it("a member reads it: every control disabled, the read-only line, no action row", async () => {
    const routes = orgRoutes({ id: "t-paper", personal: "locked" });
    stubApi(routes);
    await renderRouteWithCache("/settings/appearance", routes, { locale: "zh", me: member });
    const picker = await screen.findByRole("radiogroup", { name: A.org.label });
    for (const r of within(picker).getAllByRole("radio")) {
      expect((r as HTMLButtonElement).disabled).toBe(true);
    }
    expect(within(picker).getByRole("radio", { name: /纸/ }).getAttribute("aria-checked")).toBe(
      "true",
    );
    for (const s of screen.getAllByRole("switch"))
      expect((s as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(zh.orgSettings.readonly)).toBeTruthy();
    expect(screen.queryByRole("button", { name: A.save })).toBeNull();
  });
});

describe("/account/preferences › 外观", () => {
  const PREFS = "/api/v1/me/preferences";

  it("the cards: 默认 and the org's themes; a pick is saved with PUT { theme } and every cached org's themes read again", async () => {
    let theme: string | null = null;
    const routes: Routes = {
      ...orgRoutes(),
      [`GET ${PREFS}`]: () => json(200, { timeZone: null, theme }),
      [`PUT ${PREFS}`]: (c) => {
        theme = (JSON.parse(String(c.body)) as { theme: string | null }).theme;
        return json(200, { timeZone: null, theme });
      },
    };
    const calls = stubApi(routes);
    const { client } = await renderRouteWithCache("/account/preferences", routes, {
      locale: "zh",
    });
    // another org this tab viewed: the pick holds there too
    client.setQueryData(orgThemesQuery("o2").queryKey, themesOf({ id: null, personal: "allowed" }));
    const picker = await screen.findByRole("radiogroup", { name: A.personal.label });
    const radios = within(picker).getAllByRole("radio");
    expect(radios.map((r) => r.textContent)).toEqual([A.personal.default, "夜之城", "纸"]);
    // above the time zone
    const headings = screen.getAllByRole("heading").map((h) => h.textContent);
    expect(headings.indexOf(A.personal.title)).toBeLessThan(
      headings.indexOf(zh.preferences.timeZone.title),
    );
    const user = userEvent.setup();
    await user.click(within(picker).getByRole("radio", { name: /纸/ }));
    await user.click(screen.getByRole("button", { name: zh.preferences.save }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(bodyOf(calls.find((c) => c.method === "PUT"))).toEqual({ theme: "t-paper" });
    await vi.waitFor(() =>
      expect(calls.some((c) => c.method === "GET" && c.url.endsWith(`${O}/themes`))).toBe(true),
    );
    // the other org's themes read is stale, so it refetches when that org is viewed
    expect(client.getQueryState(orgThemesQuery("o2").queryKey)?.isInvalidated).toBe(true);
  });

  it("an org that locks it: one line instead of the cards", async () => {
    const routes: Routes = {
      ...orgRoutes({ id: "t-night", personal: "locked" }),
      [`GET ${PREFS}`]: () => json(200, { timeZone: null, theme: "t-paper" }),
    };
    await renderRouteWithCache("/account/preferences", routes, { locale: "zh" });
    expect(await screen.findByText(A.personal.locked)).toBeTruthy();
    expect(screen.queryByRole("radiogroup", { name: A.personal.label })).toBeNull();
  });
});

describe("/admin/settings › 外观 (平台默认主题)", () => {
  const comp = (over: Record<string, unknown>) => ({
    kind: "theme",
    id: "t-night",
    name: "night-city",
    description: null,
    plugin: "fake-theme",
    itemId: "11111111-1111-4111-8111-111111111111",
    owner: { kind: "platform" },
    shareable: false,
    promoted: false,
    builtin: false,
    scopeMode: "follow",
    scope: "all",
    orgs: [],
    disabled: false,
    pluginStopped: false,
    shownToOthers: true,
    version: "1",
    onIn: ["o1"],
    theme: { name: { en: "Night City", zh: "夜之城" }, swatches: { dark: sw("#05070d") } },
    ...over,
  });
  const PAPER_THEME = { name: { en: "Paper", zh: "纸" }, swatches: PAPER.swatches };
  const THEMES = {
    components: [
      comp({}),
      comp({ id: "t-paper", name: "paper", theme: PAPER_THEME }),
      comp({ id: "t-opt", name: "optional-one", scope: "optional" }),
      comp({ id: "t-off", name: "disabled-one", disabled: true }),
      comp({ id: "t-org", name: "org-one", owner: { kind: "org", orgId: "o1", name: "Acme" } }),
    ],
  };
  const SETTINGS = {
    orgCreation: "anyone",
    runConcurrencyOverrides: {},
    priceCurrency: "USD",
    sandboxLimitOverrides: {},
    customConnectors: "allow",
    customSkills: "allow",
    uiTheme: { id: null },
  };
  const routes = (put: Routes[string]): Routes => ({
    ...orgRoutes(),
    // 插件界面代码 lists the extensions with client code
    "GET /api/v1/admin/extensions": () => json(200, { extensions: [], drainSeconds: 30 }),
    "GET /api/v1/admin/settings": () => json(200, SETTINGS),
    "GET /api/v1/admin/ui/arrangement": () => json(200, { slots: [] }),
    "GET /api/v1/admin/components?kind=theme": () => json(200, THEMES),
    "PUT /api/v1/admin/settings": put,
    "GET /api/v1/platform/theme": () => json(200, null),
  });

  it("offers 内置主题 and only platform-owned, `all`, enabled themes, by their own names; a save sends { uiTheme } and invalidates the org themes and the platform default", async () => {
    const r = routes((c) =>
      json(200, {
        ...SETTINGS,
        uiTheme: (JSON.parse(String(c.body)) as { uiTheme: unknown }).uiTheme,
      }),
    );
    const calls = stubApi(r);
    const { client } = await renderRouteWithCache("/admin/settings", r, { locale: "zh" });
    // what the workspace frame holds: the org's themes and the platform default
    client.setQueryData(orgThemesQuery("o1").queryKey, themesOf({ id: null, personal: "allowed" }));
    client.setQueryData(platformThemeQuery().queryKey, null);
    const picker = await screen.findByRole("radiogroup", { name: A.platform.label });
    expect(
      within(picker)
        .getAllByRole("radio")
        .map((x) => x.textContent),
    ).toEqual([A.builtin, "夜之城", "纸"]);
    const user = userEvent.setup();
    await user.click(within(picker).getByRole("radio", { name: /夜之城/ }));
    await user.click(screen.getByRole("button", { name: zh.admin.settings.save }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(bodyOf(calls.find((c) => c.method === "PUT"))).toEqual({ uiTheme: { id: "t-night" } });
    // every org's themes and the platform default are stale now (each org falls back to it)
    await vi.waitFor(() =>
      expect(client.getQueryState(orgThemesQuery("o1").queryKey)?.isInvalidated).toBe(true),
    );
    expect(client.getQueryState(platformThemeQuery().queryKey)?.isInvalidated).toBe(true);
  });

  it("a theme off in some org: the refusal names those orgs", async () => {
    const r = routes(() =>
      json(400, {
        error: {
          code: "theme.not_available",
          message: "off",
          details: [{ theme: "t-paper", orgs: [{ orgId: "o2", orgName: "Beta" }] }],
        },
      }),
    );
    stubApi(r);
    await renderRouteWithCache("/admin/settings", r, { locale: "zh" });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("radio", { name: /纸/ }));
    await user.click(screen.getByRole("button", { name: zh.admin.settings.save }));
    expect(await screen.findByText(A.platform.notAvailable.replace("{orgs}", "Beta"))).toBeTruthy();
  });
});

describe("/admin/themes", () => {
  const comp = (over: Record<string, unknown>) => ({
    kind: "theme",
    id: "t-night",
    name: "night-city",
    description: null,
    plugin: "fake-theme",
    itemId: "11111111-1111-4111-8111-111111111111",
    owner: { kind: "platform" },
    shareable: false,
    promoted: false,
    builtin: false,
    scopeMode: "follow",
    scope: "all",
    orgs: [],
    disabled: false,
    pluginStopped: false,
    shownToOthers: true,
    version: "1",
    onIn: ["o1"],
    theme: { name: { en: "Night City", zh: "夜之城" }, swatches: { dark: sw("#05070d") } },
    ...over,
  });
  const versions = () =>
    json(200, {
      versions: [{ version: "1", catalogVersion: "0.1.0", updatedOnOwn: false, createdAt: T }],
    });
  const routes: Routes = {
    "GET /api/v1/admin/components?kind=theme": () =>
      json(200, {
        components: [
          comp({}),
          comp({
            id: "t-paper",
            name: "paper",
            theme: { name: { en: "Paper", zh: "纸" }, swatches: PAPER.swatches },
          }),
        ],
      }),
    "GET /api/v1/admin/orgs": () => json(200, { orgs: [], limitDefaults: {} }),
    // 插件界面代码 lists the extensions with client code
    "GET /api/v1/admin/extensions": () => json(200, { extensions: [], drainSeconds: 30 }),
    "GET /api/v1/admin/settings": () => json(200, { uiTheme: { id: "t-night" } }),
    "GET /api/v1/admin/components/theme/t-night/versions": versions,
    "GET /api/v1/admin/components/theme/t-paper/versions": versions,
  };
  const D = en.adminComponents.detail;

  it("lists the themes by their own names with the platform default marked; a first render makes no browser read", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRouteWithCache("/admin/themes", routes);
    const table = await screen.findByRole("table", { name: en.adminComponents.titles.theme });
    const night = within(table).getByRole("link", { name: "Night City" });
    expect(night.getAttribute("href")).toBe("/admin/themes/t-night");
    expect(
      within(night.closest("tr") as HTMLElement).getByText(
        en.adminComponents.state.platformDefault,
      ),
    ).toBeTruthy();
    const paper = within(table).getByRole("link", { name: "Paper" }).closest("tr") as HTMLElement;
    expect(within(paper).queryByText(en.adminComponents.state.platformDefault)).toBeNull();
    expect(within(table).queryByText("night-city")).toBeNull();
    await settle();
    expect(browser).toEqual([]);
  });

  it("the platform default's detail: its name, the note why, and neither 设置范围 nor 停用 (nor an upload)", async () => {
    stubApi(routes);
    await renderRouteWithCache("/admin/themes/t-night", routes);
    expect(await screen.findByRole("heading", { name: "Night City" })).toBeTruthy();
    expect(screen.getByText(D.platformDefaultNote)).toBeTruthy();
    for (const label of [D.actions.scope, D.actions.disable, D.actions.upload]) {
      expect(screen.queryByRole("button", { name: label })).toBeNull();
    }
  });

  it("another theme: 停用's preview lists the orgs whose default it is and how many people picked it", async () => {
    const all: Routes = {
      ...routes,
      "POST /api/v1/admin/components/theme/t-paper/scope/preview": () =>
        json(200, {
          affected: [],
          conflicts: [],
          themes: [{ id: "t-paper", orgDefaults: [{ orgId: "o2", orgName: "Beta" }], pickedBy: 3 }],
          scopeHash: "h",
        }),
    };
    stubApi(all);
    await renderRouteWithCache("/admin/themes/t-paper", all);
    expect(await screen.findByRole("heading", { name: "Paper" })).toBeTruthy();
    expect(screen.getByRole("button", { name: D.actions.scope })).toBeTruthy();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: D.actions.disable }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText(en.themeImpact.title)).toBeTruthy();
    expect(within(dialog).getByText("Paper")).toBeTruthy();
    expect(
      within(dialog).getByText(en.themeImpact.orgDefaults.replace("{orgs}", "Beta")),
    ).toBeTruthy();
    expect(within(dialog).getByText(/3 people picked it/)).toBeTruthy();
  });
});

describe("the 跟随平台 / 默认 cards draw the platform default (themes spec §7)", () => {
  /** The `--cb-swatch-bg` of a picker card. */
  const bgOf = (radio: HTMLElement) =>
    (
      radio.querySelector('[data-part="theme-swatch-preview"]') as HTMLElement
    ).style.getPropertyValue("--cb-swatch-bg");
  // Paper comes from a builtin plugin: locked on in the org although it is not the default
  const builtinPaper = {
    components: [
      orgComp({ platformDefault: false }),
      orgComp({ id: "t-paper", name: "paper", locked: true, switchable: false }),
    ],
  };

  it("no platform default and a builtin plugin's locked theme: 跟随平台 is the built-in theme", async () => {
    await renderRouteWithCache(
      "/settings/appearance",
      orgRoutes({ id: null, personal: "allowed" }, null, builtinPaper),
      { locale: "zh" },
    );
    const picker = await screen.findByRole("radiogroup", { name: A.org.label });
    expect(bgOf(within(picker).getAllByRole("radio")[0] as HTMLElement)).toMatch(/--cb-builtin-/);
  });

  it("a platform default beside a builtin plugin's locked theme: 跟随平台 is the default's swatches", async () => {
    await renderRouteWithCache(
      "/settings/appearance",
      orgRoutes({ id: null, personal: "allowed" }, NIGHT, {
        components: [orgComp({ locked: true }), builtinPaper.components[1]],
      }),
      { locale: "zh" },
    );
    const picker = await screen.findByRole("radiogroup", { name: A.org.label });
    expect(bgOf(within(picker).getAllByRole("radio")[0] as HTMLElement)).toBe("#05070d");
  });

  it("偏好设置's 默认 with an org that follows the platform: the platform default's swatches, else built-in", async () => {
    const prefs = {
      "GET /api/v1/me/preferences": () => json(200, { timeZone: null, theme: null }),
    };
    await renderRouteWithCache(
      "/account/preferences",
      { ...orgRoutes({ id: null, personal: "allowed" }, NIGHT), ...prefs },
      { locale: "zh" },
    );
    let picker = await screen.findByRole("radiogroup", { name: A.personal.label });
    expect(bgOf(within(picker).getAllByRole("radio")[0] as HTMLElement)).toBe("#05070d");
    cleanup();
    await renderRouteWithCache(
      "/account/preferences",
      { ...orgRoutes({ id: null, personal: "allowed" }, null, builtinPaper), ...prefs },
      { locale: "zh" },
    );
    picker = await screen.findByRole("radiogroup", { name: A.personal.label });
    expect(bgOf(within(picker).getAllByRole("radio")[0] as HTMLElement)).toMatch(/--cb-builtin-/);
  });
});

describe("组织设置 › 外观: switching a theme off previews who uses it", () => {
  it("the dialog lists the org as using it as its default and the people who picked it", async () => {
    const routes: Routes = {
      ...orgRoutes({ id: "t-paper", personal: "allowed" }),
      [`PUT ${O}/components/theme/t-paper/switch`]: () =>
        json(200, {
          preview: {
            agents: [],
            connectorsKept: 0,
            themes: [
              { id: "t-paper", orgDefaults: [{ orgId: "o1", orgName: "Acme" }], pickedBy: 2 },
            ],
          },
          confirm: "c",
        }),
    };
    stubApi(routes);
    await renderRouteWithCache("/settings/appearance", routes, { locale: "zh" });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("switch", { name: "纸" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(zh.themeImpact.title)).toBeTruthy();
    expect(
      within(dialog).getByText(zh.themeImpact.orgDefaults.replace("{orgs}", "Acme")),
    ).toBeTruthy();
    expect(within(dialog).getByText(zh.themeImpact.pickedBy.replace("{n}", "2"))).toBeTruthy();
    // the dialog names the theme as the list does
    expect(within(dialog).getAllByText(/纸/).length).toBeGreaterThan(0);
  });
});

describe("an owner's update preview: the theme group follows the owner naming rules (P3-14, P3-19)", () => {
  it("names only the orgs the kernel named, counts the others, never shows a name it did not disclose", () => {
    renderPage(
      <PlatformUpdatePreviewBody
        hideUnknown
        orgName={() => undefined}
        themeName={() => "Paper"}
        preview={{
          itemId: "i1",
          name: "neon",
          from: "1.0.0",
          to: "2.0.0",
          components: [],
          extension: null,
          connectorOrgs: [],
          orgNames: { o3: "Named" },
          themes: [
            {
              id: "t-paper",
              orgDefaults: [
                { orgId: "o2", orgName: "Undisclosed" },
                { orgId: "o3", orgName: "Named" },
              ],
              pickedBy: 1,
            },
          ],
          diffHash: "h",
        }}
      />,
    );
    const orgs = "Named, 1 other organization";
    expect(screen.getByText(en.themeImpact.orgDefaults.replace("{orgs}", orgs))).toBeTruthy();
    expect(screen.queryByText(/Undisclosed/)).toBeNull();
    expect(screen.getByText("Paper")).toBeTruthy();
  });
});
