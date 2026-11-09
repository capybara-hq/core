import { describeNestedBox, findNestedBoxes } from "@capybara-hq/design/reference";
import { act, cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import type { Me } from "../src/lib/session";
import { bodyOf, json, lastStubRoutes, noContent, stubApi } from "./support/api";
import { resetNavigation } from "./support/navigation";
import { renderRouteWithCache } from "./support/query";
import { ME } from "./support/render";
import { pickOption } from "./support/select";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
const navigateBrowser = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/browser", () => ({ navigateBrowser }));

const msgs = { zh, en } as const;
/** A message with `{plugin}` filled in with fake-im. */
const fill = (s: string, plugin = "fake-im") => s.replace("{plugin}", plugin);
const BASE = "/api/v1/orgs/o1";

/**
 * The page's server reads that a test does not care about answer empty (the previewers, the
 * default providers, the login plugins).
 */
const api = (routes: Parameters<typeof stubApi>[0]) =>
  stubApi({
    [`GET ${BASE}/file-previewers`]: () => json(200, { items: [] }),
    [`GET ${BASE}/ui/arrangement`]: () => json(200, { slots: [] }),
    [`GET ${BASE}/extension-points`]: () => json(200, { points: [] }),
    "GET /api/v1/auth/sources": () => json(200, { sources: [] }),
    ...routes,
  });
const MEMBER: Me = {
  ...ME,
  memberships: [{ orgId: "o1", slug: "acme", name: "Acme", role: "member" }],
};

const FAKE_IM = {
  plugin: "fake-im",
  version: "0.1.0",
  enabled: false,
  configurable: true,
  config: null,
  secrets: [{ path: "token", set: true }],
  permissions: [
    {
      category: "provides",
      sensitive: false,
      items: ["channel@1", "directory@1"],
      entries: [
        { value: "channel@1", sensitive: false },
        { value: "directory@1", sensitive: false },
      ],
    },
    {
      category: "secrets",
      sensitive: true,
      items: ["org:token"],
      entries: [{ value: "org:token", sensitive: true, reason: "secrets" }],
    },
    {
      category: "tools",
      sensitive: true,
      items: ["post_announcement"],
      entries: [{ value: "post_announcement", sensitive: true, reason: "tools" }],
    },
  ],
  orgConfigSchema: {
    type: "object",
    properties: {
      url: { type: "string", format: "uri" },
      token: { type: "string", "x-secret": true },
    },
    required: ["url"],
  },
};
/** fake-im with its required org config saved: switchable. */
const FAKE_IM_SET = { ...FAKE_IM, config: { url: "http://dir.test" } };
const CORE = {
  plugin: "core-dir",
  version: "1.0.0",
  enabled: true,
  configurable: false,
  config: null,
  secrets: [],
  permissions: [
    {
      category: "provides",
      sensitive: false,
      items: ["directory-core@1"],
      entries: [{ value: "directory-core@1", sensitive: false }],
    },
  ],
  orgConfigSchema: null,
};

beforeEach(() => {
  resetNavigation("/extensions");
  // The tab is written to the URL (`?tab=`): every test starts on a clean one.
  window.history.replaceState(null, "", "/");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** A web extension providing both web points: in 网页 once. */
const JINA = {
  ...CORE,
  plugin: "jina",
  displayName: { zh: "Jina", en: "Jina" },
  enabled: false,
  permissions: [
    {
      category: "provides",
      sensitive: false,
      items: ["web-search@1", "web-fetch@1"],
      entries: [
        { value: "web-search@1", sensitive: false },
        { value: "web-fetch@1", sensitive: false },
      ],
    },
  ],
};
/** Spans two tabs: a model provider and a sandbox, plus agent tools. */
const DUO = {
  ...CORE,
  plugin: "duo",
  enabled: true,
  permissions: [
    {
      category: "provides",
      sensitive: false,
      items: ["model-provider@2", "sandbox@1"],
      entries: [
        { value: "model-provider@2", sensitive: false },
        { value: "sandbox@1", sensitive: false },
      ],
    },
    {
      category: "tools",
      sensitive: true,
      items: ["run"],
      entries: [{ value: "run", sensitive: true, reason: "tools" }],
    },
  ],
};

const isDisabled = (el: HTMLElement) =>
  el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true";
/** The table's rows (the header row left out), as their first cell's name. */
const rowNames = () =>
  screen
    .getAllByRole("row")
    .slice(1)
    .map((r) => r.querySelector(".cb-cell-title-name")?.textContent);
/** Opens an extension's Sheet by clicking its row (its name). */
async function openSheet(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(await screen.findByText(name, { selector: ".cb-cell-title-name" }));
  return screen.findByRole("dialog", { name });
}

describe("/extensions (ListPage + DataTable by capability, details in a Sheet)", () => {
  it.each(["zh", "en"] as const)(
    "tabs carry counts; an extension spanning two tabs is in both and once in 全部; Jina once in 网页 (%s)",
    async (locale) => {
      const m = msgs[locale].extensions;
      api({
        [`GET ${BASE}/extensions`]: () => json(200, { extensions: [FAKE_IM_SET, CORE, JINA, DUO] }),
      });
      const { container } = await renderRouteWithCache("/extensions", lastStubRoutes(), {
        locale,
      });
      expect(container.querySelector('[data-template="ListPage"]')).not.toBeNull();
      const tabs = screen.getByRole("tablist");
      const tab = (id: keyof typeof m.tabs) =>
        within(tabs).getByRole("tab", { name: new RegExp(`^${m.tabs[id]}`) });
      for (const [id, n] of [
        ["all", 4],
        ["model", 1],
        ["web", 1],
        ["connector", 0],
        ["sandbox", 1],
        ["storage", 0],
        // fake-im (channel, directory, tools) and core-dir (an unknown point) fall to the catch-all
        ["tools", 2],
      ] as const) {
        expect(tab(id).textContent).toContain(String(n));
      }
      expect(rowNames()).toHaveLength(4);
      // In 全部 duo shows everything it can do
      const duo = screen.getByRole("row", { name: /duo/ });
      expect(duo.textContent).toContain(m.capability.model);
      expect(duo.textContent).toContain(m.capability.sandbox);
      expect(duo.textContent).toContain(m.capability.tools);
      const user = userEvent.setup();
      // Under 沙箱 its row shows only what it provides there
      await user.click(tab("sandbox"));
      expect(rowNames()).toEqual(["duo"]);
      const sandboxRow = screen.getByRole("row", { name: /duo/ });
      expect(sandboxRow.textContent).toContain(m.capability.sandbox);
      expect(sandboxRow.textContent).not.toContain(m.capability.model);
      expect(window.location.search).toBe("?tab=sandbox");
      await user.click(tab("model"));
      expect(rowNames()).toEqual(["duo"]);
      await user.click(tab("web"));
      expect(rowNames()).toEqual(["Jina"]);
      const jina = screen.getByRole("row", { name: /Jina/ });
      expect(jina.textContent).toContain(m.capability.webSearch);
      expect(jina.textContent).toContain(m.capability.webFetch);
      await user.click(tab("connector"));
      expect(screen.getByText(m.emptyTab)).toBeTruthy();
      await user.click(tab("all"));
      expect(window.location.search).toBe("");
    },
  );

  it("?tab= opens that tab; search filters by name and id", async () => {
    api({
      [`GET ${BASE}/extensions`]: () => json(200, { extensions: [FAKE_IM_SET, CORE, JINA, DUO] }),
    });
    resetNavigation("/extensions?tab=tools");
    await renderRouteWithCache("/extensions?tab=tools", lastStubRoutes());
    expect(screen.getByRole("tab", { selected: true }).textContent).toContain(
      en.extensions.tabs.tools,
    );
    expect(rowNames().sort()).toEqual(["core-dir", "fake-im"]);
    const user = userEvent.setup();
    await user.type(screen.getByRole("searchbox", { name: en.extensions.search }), "core");
    expect(rowNames()).toEqual(["core-dir"]);
  });

  it("the tab follows the address: a link to the bare page while 工具与界面 is open goes back to 全部", async () => {
    api({
      [`GET ${BASE}/extensions`]: () => json(200, { extensions: [FAKE_IM_SET, CORE, JINA, DUO] }),
    });
    resetNavigation("/extensions");
    window.history.replaceState(null, "", "/extensions");
    const { navigate } = await renderRouteWithCache("/extensions", lastStubRoutes());
    await userEvent
      .setup()
      .click(screen.getByRole("tab", { name: new RegExp(`^${en.extensions.tabs.tools}`) }));
    expect(window.location.search).toBe("?tab=tools");
    expect(rowNames().sort()).toEqual(["core-dir", "fake-im"]);
    // the sidebar's 扩展: Next moves the address to the bare page and renders it again
    window.history.replaceState(null, "", "/extensions");
    await act(async () => navigate("/extensions"));
    expect(screen.getByRole("tab", { selected: true }).textContent).toContain(
      en.extensions.tabs.all,
    );
    expect(rowNames()).toHaveLength(4);
  });

  it("sorting: needs attention (待配置) first, then on, then off or unavailable, by name", async () => {
    const m = zh.extensions;
    api({
      [`GET ${BASE}/extensions`]: () =>
        json(200, {
          extensions: [
            { ...CORE, plugin: "zeta-off", enabled: false },
            { ...CORE, plugin: "beta-on" },
            { ...CORE, plugin: "gone", available: false },
            FAKE_IM,
            { ...CORE, plugin: "alpha-on" },
            { ...CORE, plugin: "alpha-off", enabled: false },
          ],
        }),
    });
    await renderRouteWithCache("/extensions", lastStubRoutes(), { locale: "zh" });
    expect(rowNames()).toEqual(["fake-im", "alpha-on", "beta-on", "alpha-off", "gone", "zeta-off"]);
    const fakeIm = screen.getByRole("row", { name: /fake-im/ });
    expect(within(fakeIm).getByText(m.needsConfig).getAttribute("data-tone")).toBe("warn");
  });

  it.each(["zh", "en"] as const)(
    "a row opens its Sheet: the config form on top, the state, the permissions folded into one line (%s)",
    async (locale) => {
      const m = msgs[locale].extensions;
      api({
        [`GET ${BASE}/extensions`]: () => json(200, { extensions: [FAKE_IM_SET, CORE] }),
      });
      await renderRouteWithCache("/extensions", lastStubRoutes(), { locale });
      const user = userEvent.setup();
      const sheet = await openSheet(user, "fake-im");
      expect(within(sheet).getByText(m.configTitle)).toBeTruthy();
      expect(within(sheet).getByRole("textbox", { name: /^url/ })).toBeTruthy();
      expect(within(sheet).getByRole("button", { name: fill(m.saveLabel) })).toBeTruthy();
      // The regions in order (spec §6.7): 组织配置, 状态, 权限; no status line on a saved config
      expect(
        within(sheet)
          .getAllByRole("heading", { level: 3 })
          .map((h) => h.textContent),
      ).toEqual([m.configTitle, m.stateTitle, m.permissions]);
      expect(sheet.querySelector('[data-part="callout"]')).toBeNull();
      // Folded: one line with the categories' counts and the 「敏感」 mark
      const summary = within(sheet).getByRole("button", { expanded: false });
      expect(summary.textContent).toContain(`${m.category.secrets} 1`);
      expect(summary.textContent).toContain(`${m.category.tools} 1`);
      expect(summary.textContent).toContain(m.sensitive);
      // neither region repeats its heading: no 状态 key, no 权限 word in the folded line
      expect(within(sheet).queryByText(m.stateTitle, { selector: "dt" })).toBeNull();
      expect(summary.textContent?.includes(m.permissions)).toBe(false);
      expect(within(sheet).queryByRole("region", { name: fill(m.permissionsLabel) })).toBeNull();
      await user.click(summary);
      const perms = within(sheet).getByRole("region", { name: fill(m.permissionsLabel) });
      expect(within(perms).getAllByText(m.sensitive)).toHaveLength(2);
      // Only the 「敏感」 mark is yellow; a sensitive item is the plain muted list colour.
      expect(within(perms).getByText("· post_announcement").getAttribute("data-tone")).toBe(
        "muted",
      );
      for (const mark of within(perms).getAllByText(m.sensitive)) {
        expect(mark.getAttribute("data-tone")).toBe("warn");
      }
      expect(within(perms).getByText("· channel@1").getAttribute("data-tone")).toBe("muted");
      // One box (acceptance item AB): a row per category in the Sheet, never a card
      expect(within(perms).getByRole("group", { name: m.category.tools })).toBeTruthy();
      expect(sheet.querySelector('[data-part="card"]')).toBeNull();
      expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
    },
  );

  it.each(["zh", "en"] as const)(
    "the row's switch PUTs enabled without opening the Sheet; then 立即同步 is in the Sheet (%s)",
    async (locale) => {
      const m = msgs[locale].extensions;
      const calls = api({
        [`GET ${BASE}/extensions`]: () => json(200, { extensions: [FAKE_IM_SET, CORE] }),
        [`PUT ${BASE}/extensions/fake-im`]: (c) =>
          json(200, { extension: { ...FAKE_IM_SET, ...(bodyOf(c) as object) } }),
        [`POST ${BASE}/extensions/fake-im/directory/sync`]: () => json(202, { jobId: "j1" }),
      });
      await renderRouteWithCache("/extensions", lastStubRoutes(), { locale });
      const user = userEvent.setup();
      await user.click(screen.getByRole("switch", { name: fill(m.enableLabel) }));
      await vi.waitFor(() =>
        expect(bodyOf(calls.find((c) => c.method === "PUT"))).toEqual({ enabled: true }),
      );
      expect(await screen.findByText(fill(m.enabledToast))).toBeTruthy();
      expect(screen.queryByRole("dialog")).toBeNull();
      const sheet = await openSheet(user, "fake-im");
      await user.click(within(sheet).getByRole("button", { name: fill(m.syncLabel) }));
      expect(await screen.findByText(m.syncStarted)).toBeTruthy();
      expect(calls.some((c) => c.method === "POST")).toBe(true);
    },
  );

  it.each(["zh", "en"] as const)(
    "a member reads the same list: tabs and chips from `provides`, states, no switch; the Sheet has no config or permissions (%s)",
    async (locale) => {
      const m = msgs[locale].extensions;
      const member = ({
        config: _c,
        secrets: _s,
        orgConfigSchema: _o,
        permissions: _p,
        ...rest
      }: typeof FAKE_IM) => rest;
      const calls = api({
        [`GET ${BASE}/extensions`]: () =>
          json(200, {
            extensions: [
              { ...member(FAKE_IM), provides: ["channel@1", "directory@1"] },
              {
                ...member(FAKE_IM),
                plugin: "jina",
                enabled: true,
                provides: ["web-search@1", "web-fetch@1"],
              },
            ],
          }),
      });
      await renderRouteWithCache("/extensions", lastStubRoutes(), { locale, me: MEMBER });
      expect(await screen.findByText(m.disabled)).toBeTruthy();
      expect(screen.getByText(m.enabled)).toBeTruthy();
      expect(screen.queryByRole("switch")).toBeNull();
      const tabs = screen.getByRole("tablist");
      const tab = (id: keyof typeof m.tabs) =>
        within(tabs).getByRole("tab", { name: new RegExp(`^${m.tabs[id]}`) });
      expect(tab("all").textContent).toContain("2");
      expect(tab("web").textContent).toContain("1");
      expect(tab("tools").textContent).toContain("1");
      const jina = screen.getByRole("row", { name: /jina/ });
      expect(jina.textContent).toContain(m.capability.webSearch);
      expect(jina.textContent).toContain(m.capability.webFetch);
      expect(screen.getByRole("row", { name: /fake-im/ }).textContent).toContain(
        m.capability.channel,
      );
      const user = userEvent.setup();
      await user.click(tab("web"));
      expect(rowNames()).toEqual(["jina"]);
      await user.click(tab("all"));
      const sheet = await openSheet(user, "fake-im");
      // A member's Sheet: the 状态 region only (no config, no permissions)
      expect(
        within(sheet)
          .getAllByRole("heading", { level: 3 })
          .map((h) => h.textContent),
      ).toEqual([m.stateTitle]);
      expect(within(sheet).getByText(m.capabilitiesTitle)).toBeTruthy();
      expect(within(sheet).getByText(new RegExp(m.capability.directory))).toBeTruthy();
      expect(within(sheet).queryByText(m.configTitle)).toBeNull();
      expect(within(sheet).queryByText(m.permissions)).toBeNull();
      expect(within(sheet).queryByRole("textbox")).toBeNull();
      expect(within(sheet).queryByRole("button", { name: fill(m.saveLabel) })).toBeNull();
      expect(calls.some((c) => String(c.url).includes("file-previewers"))).toBe(false);
    },
  );

  it.each(["zh", "en"] as const)(
    "部署上停用的插件：显示「不可用」，开关只读、保留组织的启用设置，没有配置与同步（%s）",
    async (locale) => {
      const m = msgs[locale].extensions;
      const calls = api({
        [`GET ${BASE}/extensions`]: () =>
          json(200, {
            extensions: [
              {
                ...FAKE_IM,
                enabled: true,
                configurable: false,
                secrets: [],
                permissions: [],
                orgConfigSchema: null,
                available: false,
              },
            ],
          }),
      });
      await renderRouteWithCache("/extensions", lastStubRoutes(), { locale });
      const toggle = await screen.findByRole("switch", { name: fill(m.enableLabel) });
      expect(isDisabled(toggle)).toBe(true);
      // A state, not a badge: attention text (warn), never orange.
      const state = screen.getByText(m.unavailable);
      expect(state.closest(".cb-badge")).toBeNull();
      expect(state.getAttribute("data-tone")).toBe("warn");
      const user = userEvent.setup();
      await user.click(toggle);
      expect(calls.some((c) => c.method === "PUT")).toBe(false);
      const sheet = await openSheet(user, "fake-im");
      expect(within(sheet).getByText(m.unavailableHint)).toBeTruthy();
      expect(within(sheet).queryByRole("button", { name: fill(m.syncLabel) })).toBeNull();
    },
  );

  it.each(["zh", "en"] as const)(
    "a required bootstrap plugin: the switch is read-only (always on) with a note, no PUT (%s)",
    async (locale) => {
      const m = msgs[locale].extensions;
      const calls = api({
        [`GET ${BASE}/extensions`]: () =>
          json(200, {
            extensions: [
              {
                ...FAKE_IM,
                enabled: true,
                configurable: false,
                secrets: [],
                permissions: [],
                orgConfigSchema: null,
                required: true,
              },
            ],
          }),
      });
      await renderRouteWithCache("/extensions", lastStubRoutes(), { locale });
      const toggle = await screen.findByRole("switch", { name: fill(m.enableLabel) });
      expect(isDisabled(toggle)).toBe(true);
      // On in every org: 已启用 · 平台统一 with the hint, no badge
      const state = screen.getByText(msgs[locale].plugins.state.platform);
      expect(state.closest(".cb-badge")).toBeNull();
      const user = userEvent.setup();
      await user.click(toggle);
      expect(calls.some((c) => c.method === "PUT")).toBe(false);
      const sheet = await openSheet(user, "fake-im");
      expect(within(sheet).getByText(m.platformHint)).toBeTruthy();
    },
  );

  it("missing dependency (extension.dependency_missing): the Sheet opens with the missing points", async () => {
    api({
      [`GET ${BASE}/extensions`]: () => json(200, { extensions: [FAKE_IM_SET] }),
      [`PUT ${BASE}/extensions/fake-im`]: () =>
        json(409, {
          error: {
            code: "extension.dependency_missing",
            message: "x",
            details: [{ extensionPoint: "knowledge@1" }],
          },
        }),
    });
    await renderRouteWithCache("/extensions", lastStubRoutes());
    await userEvent.setup().click(await screen.findByRole("switch", { name: "Enable fake-im" }));
    const sheet = await screen.findByRole("dialog", { name: "fake-im" });
    const alert = await within(sheet).findByRole("alert");
    expect(alert.textContent).toContain(en.extensions.dependencyMissing);
    expect(alert.textContent).toContain("knowledge@1");
    // The refused switch needs attention: its row says so and sorts first
    const row = screen.getByRole("row", { name: /fake-im/ });
    expect(within(row).getByText(en.extensions.enableFailed).getAttribute("data-tone")).toBe(
      "fail",
    );
  });

  it("still has dependents (extension.has_dependents): lists them and offers a forced disable", async () => {
    const calls = api({
      [`GET ${BASE}/extensions`]: () => json(200, { extensions: [CORE] }),
      [`GET ${BASE}/extensions/core-dir/tools`]: () => json(200, { tools: [] }),
      [`PUT ${BASE}/extensions/core-dir`]: (c) =>
        (bodyOf(c) as { force?: boolean }).force
          ? json(200, { extension: { ...CORE, enabled: false } })
          : json(409, {
              error: {
                code: "extension.has_dependents",
                message: "x",
                details: [
                  { plugin: "fake-im", extensionPoint: "directory-core@1" },
                  { plugin: "lark", extensionPoint: "directory-core@1" },
                ],
              },
            }),
    });
    await renderRouteWithCache("/extensions", lastStubRoutes(), { locale: "zh" });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("switch", { name: "启用 core-dir" }));
    const sheet = await screen.findByRole("dialog", { name: "core-dir" });
    const alert = await within(sheet).findByRole("alert");
    expect(alert.textContent).toContain(zh.extensions.hasDependents);
    expect(alert.textContent).toContain("fake-im");
    expect(alert.textContent).toContain("lark");
    await user.click(within(sheet).getByRole("button", { name: zh.extensions.forceDisable }));
    await vi.waitFor(() =>
      expect(bodyOf(calls.filter((c) => c.method === "PUT")[1])).toEqual({
        enabled: false,
        force: true,
      }),
    );
  });

  it("组织级配置：密钥不动则省略 → PUT config", async () => {
    const calls = api({
      [`GET ${BASE}/extensions`]: () => json(200, { extensions: [FAKE_IM] }),
      [`PUT ${BASE}/extensions/fake-im`]: () =>
        json(200, { extension: { ...FAKE_IM, config: { url: "http://dir.test" } } }),
    });
    await renderRouteWithCache("/extensions", lastStubRoutes());
    const user = userEvent.setup();
    const sheet = await openSheet(user, "fake-im");
    const save = within(sheet).getByRole("button", { name: "Save config of fake-im" });
    expect(save).toHaveProperty("disabled", true);
    await user.type(within(sheet).getByRole("textbox", { name: /^url/ }), "http://dir.test");
    await user.click(save);
    await vi.waitFor(() =>
      expect(bodyOf(calls.find((c) => c.method === "PUT"))).toEqual({
        config: { url: "http://dir.test" },
      }),
    );
    expect(await screen.findByText(fill(en.extensions.configSaved))).toBeTruthy();
  });

  it.each(["zh", "en"] as const)(
    "off with a required org field unset: 待配置, the switch waits for the config; 保存并启用 sends both in one PUT (%s)",
    async (locale) => {
      const m = msgs[locale].extensions;
      const calls = api({
        [`GET ${BASE}/extensions`]: () => json(200, { extensions: [FAKE_IM] }),
        [`PUT ${BASE}/extensions/fake-im`]: () =>
          json(200, { extension: { ...FAKE_IM_SET, enabled: true } }),
      });
      await renderRouteWithCache("/extensions", lastStubRoutes(), { locale });
      const toggle = await screen.findByRole("switch", { name: fill(m.enableLabel) });
      expect(isDisabled(toggle)).toBe(true);
      expect(screen.getByText(m.needsConfig)).toBeTruthy();
      const user = userEvent.setup();
      await user.click(toggle);
      expect(calls.some((c) => c.method === "PUT")).toBe(false);
      const sheet = await openSheet(user, "fake-im");
      // One warn line names what is missing; no red error on the pristine form
      const notice = within(sheet).getByText(m.missingRequired.replace("{fields}", "url"));
      expect(notice.closest('[data-part="callout"]')?.getAttribute("data-tone")).toBe("warn");
      expect(within(sheet).queryByText(msgs[locale].configForm.errors.required)).toBeNull();
      const saveEnable = within(sheet).getByRole("button", {
        name: fill(m.saveAndEnableLabel),
      });
      expect(saveEnable.textContent).toBe(m.saveAndEnable);
      expect(within(sheet).getByRole("button", { name: fill(m.saveLabel) })).toBeTruthy();
      await user.type(within(sheet).getByRole("textbox", { name: /^url/ }), "http://dir.test");
      await user.click(saveEnable);
      await vi.waitFor(() =>
        expect(bodyOf(calls.find((c) => c.method === "PUT"))).toEqual({
          enabled: true,
          config: { url: "http://dir.test" },
        }),
      );
      expect(await screen.findByText(fill(m.enabledToast))).toBeTruthy();
      expect(screen.queryByText(m.missingRequired.replace("{fields}", "url"))).toBeNull();
      expect(isDisabled(screen.getByRole("switch", { name: fill(m.enableLabel) }))).toBe(false);
    },
  );

  it("a saved config with its required fields: the switch is on offer, no hint", async () => {
    api({ [`GET ${BASE}/extensions`]: () => json(200, { extensions: [FAKE_IM_SET] }) });
    await renderRouteWithCache("/extensions", lastStubRoutes());
    const toggle = await screen.findByRole("switch", { name: "Enable fake-im" });
    expect(isDisabled(toggle)).toBe(false);
    expect(screen.queryByText(en.extensions.needsConfig)).toBeNull();
    const sheet = await openSheet(userEvent.setup(), "fake-im");
    expect(
      within(sheet).getByRole("button", { name: "Save config of fake-im and enable" }),
    ).toBeTruthy();
    expect(within(sheet).queryByText(en.extensions.configFirstHint)).toBeNull();
  });

  it.each(["switch", "saveAndEnable"] as const)(
    "extension.config_invalid on enabling (%s) marks the form's fields, not the install callout",
    async (via) => {
      const calls = api({
        [`GET ${BASE}/extensions`]: () => json(200, { extensions: [FAKE_IM_SET] }),
        [`PUT ${BASE}/extensions/fake-im`]: () =>
          json(400, {
            error: {
              code: "extension.config_invalid",
              message: "Invalid organization config for extension fake-im",
              details: [{ path: "url", segments: ["url"], message: "url is not reachable" }],
            },
          }),
      });
      await renderRouteWithCache("/extensions", lastStubRoutes());
      const user = userEvent.setup();
      if (via === "switch") {
        await user.click(await screen.findByRole("switch", { name: "Enable fake-im" }));
      } else {
        const sheet = await openSheet(user, "fake-im");
        await user.click(
          within(sheet).getByRole("button", { name: "Save config of fake-im and enable" }),
        );
      }
      await vi.waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
      // The switch's refusal opens the Sheet by itself
      const sheet = await screen.findByRole("dialog", { name: "fake-im" });
      // the kernel's text stays out: the field says it in the page's words
      expect(await within(sheet).findByText(en.configForm.errors.invalid)).toBeTruthy();
      expect(within(sheet).queryByText("url is not reachable")).toBeNull();
      expect(screen.queryByText(en.errors.plugin.install_failed)).toBeNull();
      expect(
        within(sheet).getByRole("textbox", { name: /^url/ }).getAttribute("aria-invalid"),
      ).toBe("true");
    },
  );

  it("the org settings nav has no 扩展 (it is the workspace page)", async () => {
    api({ [`GET ${BASE}/settings`]: () => json(200, { settings: { toolSearch: "on" } }) });
    await renderRouteWithCache("/settings/organization", lastStubRoutes(), { me: MEMBER });
    await screen.findByText(en.orgSettings.readonly);
    expect(screen.queryByRole("link", { name: en.extensions.title })).toBeNull();
    expect(screen.getByRole("link", { name: en.connections.nav.sandbox })).toBeTruthy();
  });
});

describe("组织设置：IM 语言", () => {
  it.each(["zh", "en"] as const)("改 IM 语言 → PATCH { locale }（%s）", async (locale) => {
    const o = msgs[locale].orgSettings;
    const calls = api({
      [`GET ${BASE}/settings`]: () => json(200, { settings: { toolSearch: "on", locale: "en" } }),
      [`GET ${BASE}/ui/contributions`]: () => json(200, { items: [] }),
      [`PATCH ${BASE}/settings`]: (c) =>
        json(200, { settings: { toolSearch: "on", locale: "en", ...(bodyOf(c) as object) } }),
    });
    await renderRouteWithCache("/settings/organization", lastStubRoutes(), { locale });
    const select = await screen.findByRole("combobox", { name: o.locale.label });
    expect(select).toHaveProperty("value", "en");
    const user = userEvent.setup();
    await pickOption(select, "zh", user);
    const row = screen.getByRole("region", {
      name: locale === "zh" ? "待提交改动" : "Pending changes",
    });
    await user.click(within(row).getByRole("button", { name: o.save }));
    await vi.waitFor(() =>
      expect(bodyOf(calls.find((c) => c.method === "PATCH"))).toEqual({ locale: "zh" }),
    );
  });

  it("普通成员只读", async () => {
    api({
      [`GET ${BASE}/settings`]: () => json(200, { settings: { toolSearch: "on", locale: "zh" } }),
    });
    await renderRouteWithCache("/settings/organization", lastStubRoutes(), { me: MEMBER });
    const select = await screen.findByRole("combobox", { name: en.orgSettings.locale.label });
    expect(select).toHaveProperty("value", "zh");
    expect(select).toHaveProperty("disabled", true);
  });
});

const IDENTITY = {
  source: "fake-im:t1",
  externalId: "u-alice",
  email: "alice@corp.example",
  emailVerified: true,
  displayName: "Alice Wong",
  avatarUrl: null,
  linkedVia: "sso",
  createdAt: "2026-10-01T00:00:00Z",
};

/** 经 IM 绑定链接建立、还不能用来登录的身份（Ruling A18）。 */
const BOUND = {
  ...IDENTITY,
  externalId: "u-bound",
  email: null,
  displayName: "Bound Bob",
  linkedVia: "bind",
};

describe("已绑定的 IM 身份（SettingsPage）", () => {
  beforeEach(() => resetNavigation("/account/identities"));

  it.each(["zh", "en"] as const)("列出身份（来源、租户）；解绑 → DELETE（%s）", async (locale) => {
    const m = msgs[locale].identities;
    let identities = [IDENTITY];
    const calls = api({
      "GET /api/v1/me/identities": () => json(200, { identities }),
      "DELETE /api/v1/me/identities/fake-im%3At1/u-alice": () => {
        identities = [];
        return noContent();
      },
    });
    const { container } = await renderRouteWithCache("/account/identities", lastStubRoutes(), {
      locale,
    });
    expect(container.querySelector('[data-template="SettingsPage"]')).not.toBeNull();
    const row = await screen.findByRole("row", { name: /Alice Wong/ });
    expect(within(row).getByText("fake-im")).toBeTruthy();
    expect(within(row).getByText("t1")).toBeTruthy();
    const user = userEvent.setup();
    await user.click(
      within(row).getByRole("button", { name: locale === "zh" ? "行操作" : "Row actions" }),
    );
    await user.click(await screen.findByRole("menuitem", { name: m.unlink }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: m.unlink }));
    expect(await screen.findByText(m.empty)).toBeTruthy();
    expect(calls.some((c) => c.method === "DELETE")).toBe(true);
    // unlinking invalidates the identities: they are read again in the browser
    expect(calls.filter((c) => c.method === "GET").map((c) => c.url)).toEqual([
      "/api/v1/me/identities",
    ]);
  });

  it.each(["zh", "en"] as const)(
    "经 IM 绑定的身份标为「未验证」并提供「验证」：整页跳到该插件的第三方登录，回到本页（%s）",
    async (locale) => {
      const m = msgs[locale].identities;
      navigateBrowser.mockReset();
      api({
        "GET /api/v1/me/identities": () => json(200, { identities: [IDENTITY, BOUND] }),
        "GET /api/v1/auth/sources": () =>
          json(200, { sources: [{ plugin: "fake-im", label: { zh: "假 IM", en: "Fake IM" } }] }),
      });
      await renderRouteWithCache("/account/identities", lastStubRoutes(), { locale });
      const bound = await screen.findByRole("row", { name: /Bound Bob/ });
      expect(within(bound).getByText(m.unverified)).toBeTruthy();
      const verified = screen.getByRole("row", { name: /Alice Wong/ });
      expect(within(verified).queryByText(m.unverified)).toBeNull();
      const user = userEvent.setup();
      const rowActions = locale === "zh" ? "行操作" : "Row actions";
      // 已能登录的身份没有「验证」
      await user.click(within(verified).getByRole("button", { name: rowActions }));
      expect(screen.queryByRole("menuitem", { name: m.verify })).toBeNull();
      await user.keyboard("{Escape}");
      await user.click(within(bound).getByRole("button", { name: rowActions }));
      await user.click(await screen.findByRole("menuitem", { name: m.verify }));
      expect(navigateBrowser).toHaveBeenCalledWith(
        "/api/v1/auth/sso/fake-im/start?returnTo=%2Faccount%2Fidentities",
      );
    },
  );

  it("该插件不是可用的登录方式（不在 GET /auth/sources 里）→ 仍标「未验证」，但不提供「验证」", async () => {
    api({
      "GET /api/v1/me/identities": () => json(200, { identities: [BOUND] }),
      "GET /api/v1/auth/sources": () => json(200, { sources: [] }),
    });
    await renderRouteWithCache("/account/identities", lastStubRoutes());
    const bound = await screen.findByRole("row", { name: /Bound Bob/ });
    expect(within(bound).getByText(en.identities.unverified)).toBeTruthy();
    const user = userEvent.setup();
    await user.click(within(bound).getByRole("button", { name: "Row actions" }));
    expect(await screen.findByRole("menuitem", { name: en.identities.unlink })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: en.identities.verify })).toBeNull();
  });

  it("最后一个登录方式（identity.last_login_method）：对话框里显示原因", async () => {
    api({
      "GET /api/v1/me/identities": () => json(200, { identities: [IDENTITY] }),
      "DELETE /api/v1/me/identities/fake-im%3At1/u-alice": () =>
        json(409, { error: { code: "identity.last_login_method", message: "x" } }),
    });
    await renderRouteWithCache("/account/identities", lastStubRoutes());
    const user = userEvent.setup();
    const row = await screen.findByRole("row", { name: /Alice Wong/ });
    await user.click(within(row).getByRole("button", { name: "Row actions" }));
    await user.click(await screen.findByRole("menuitem", { name: en.identities.unlink }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: en.identities.unlink }));
    expect(await within(dialog).findByText(`${en.errors.identity.last_login_method}`)).toBeTruthy();
  });
});
