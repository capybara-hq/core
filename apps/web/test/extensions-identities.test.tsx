import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import type { Me } from "../src/lib/session";
import { bodyOf, json, lastStubRoutes, noContent, stubApi } from "./support/api";
import { resetNavigation } from "./support/navigation";
import { renderRouteWithCache } from "./support/query";
import { ME } from "./support/render";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
const navigateBrowser = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/browser", () => ({ navigateBrowser }));

const msgs = { zh, en } as const;
const BASE = "/api/v1/orgs/o1";

/** The page's server reads that a test does not care about answer empty (the previewers, the login plugins). */
const api = (routes: Parameters<typeof stubApi>[0]) =>
  stubApi({
    [`GET ${BASE}/file-previewers`]: () => json(200, { items: [] }),
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

beforeEach(() => resetNavigation("/settings/extensions"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("组织插件（SettingsPage）", () => {
  it.each(["zh", "en"] as const)(
    "the permission list is read-only, a sensitive group carries the mark; enable PUTs enabled (%s)",
    async (locale) => {
      const m = msgs[locale].extensions;
      const calls = api({
        [`GET ${BASE}/extensions`]: () => json(200, { extensions: [FAKE_IM, CORE] }),
        [`PUT ${BASE}/extensions/fake-im`]: (c) =>
          json(200, { extension: { ...FAKE_IM, ...(bodyOf(c) as object) } }),
      });
      const { container } = await renderRouteWithCache("/settings/extensions", lastStubRoutes(), {
        locale,
      });
      expect(container.querySelector('[data-template="SettingsPage"]')).not.toBeNull();
      const perms = await screen.findByRole("region", {
        name: m.permissionsLabel.replace("{plugin}", "fake-im"),
      });
      expect(within(perms).getAllByText(m.sensitive)).toHaveLength(2);
      expect(within(perms).getByText(m.category.tools)).toBeTruthy();
      // Only the 「敏感」 mark is yellow; a sensitive item is the plain muted list colour.
      expect(within(perms).getByText("· post_announcement").getAttribute("data-tone")).toBe(
        "muted",
      );
      for (const mark of within(perms).getAllByText(m.sensitive)) {
        expect(mark.getAttribute("data-tone")).toBe("warn");
      }
      expect(within(perms).getByText("· channel@1").getAttribute("data-tone")).toBe("muted");
      const user = userEvent.setup();
      await user.click(
        screen.getByRole("switch", { name: m.enableLabel.replace("{plugin}", "fake-im") }),
      );
      await vi.waitFor(() =>
        expect(bodyOf(calls.find((c) => c.method === "PUT"))).toEqual({ enabled: true }),
      );
      // 未启用时不显示「立即同步」，启用后出现
      expect(
        await screen.findByRole("button", { name: m.syncLabel.replace("{plugin}", "fake-im") }),
      ).toBeTruthy();
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
      await renderRouteWithCache("/settings/extensions", lastStubRoutes(), { locale });
      const toggle = await screen.findByRole("switch", {
        name: m.enableLabel.replace("{plugin}", "fake-im"),
      });
      expect(
        toggle.hasAttribute("disabled") || toggle.getAttribute("aria-disabled") === "true",
      ).toBe(true);
      // A state, not a badge: attention text (warn), never orange.
      const state = screen.getByText(m.unavailable);
      expect(state.closest(".cb-badge")).toBeNull();
      expect(state.getAttribute("data-tone")).toBe("warn");
      expect(screen.getByText(m.unavailableHint)).toBeTruthy();
      expect(screen.getByText(m.enabled)).toBeTruthy();
      expect(
        screen.queryByRole("button", { name: m.syncLabel.replace("{plugin}", "fake-im") }),
      ).toBeNull();
      await userEvent.setup().click(toggle);
      expect(calls.some((c) => c.method === "PUT")).toBe(false);
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
      await renderRouteWithCache("/settings/extensions", lastStubRoutes(), { locale });
      const toggle = await screen.findByRole("switch", {
        name: m.enableLabel.replace("{plugin}", "fake-im"),
      });
      expect(
        toggle.hasAttribute("disabled") || toggle.getAttribute("aria-disabled") === "true",
      ).toBe(true);
      // Plain metadata: muted text, no badge.
      const req = screen.getByText(m.required);
      expect(req.closest(".cb-badge")).toBeNull();
      expect(req.getAttribute("data-tone")).toBe("muted");
      expect(screen.getByText(m.requiredHint)).toBeTruthy();
      expect(screen.getByText(m.enabled)).toBeTruthy();
      await userEvent.setup().click(toggle);
      expect(calls.some((c) => c.method === "PUT")).toBe(false);
    },
  );

  it("missing dependency (extension.dependency_missing) lists the missing extension points", async () => {
    api({
      [`GET ${BASE}/extensions`]: () => json(200, { extensions: [FAKE_IM] }),
      [`PUT ${BASE}/extensions/fake-im`]: () =>
        json(409, {
          error: {
            code: "extension.dependency_missing",
            message: "x",
            details: [{ extensionPoint: "knowledge@1" }],
          },
        }),
    });
    await renderRouteWithCache("/settings/extensions", lastStubRoutes());
    await userEvent.setup().click(await screen.findByRole("switch", { name: "Enable fake-im" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(en.extensions.dependencyMissing);
    expect(alert.textContent).toContain("knowledge@1");
  });

  it("still has dependents (extension.has_dependents): lists them and offers a forced disable", async () => {
    const calls = api({
      [`GET ${BASE}/extensions`]: () => json(200, { extensions: [CORE] }),
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
    await renderRouteWithCache("/settings/extensions", lastStubRoutes(), { locale: "zh" });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("switch", { name: "启用 core-dir" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(zh.extensions.hasDependents);
    expect(alert.textContent).toContain("fake-im");
    expect(alert.textContent).toContain("lark");
    await user.click(screen.getByRole("button", { name: zh.extensions.forceDisable }));
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
    await renderRouteWithCache("/settings/extensions", lastStubRoutes());
    const user = userEvent.setup();
    const save = await screen.findByRole("button", { name: "Save config of fake-im" });
    expect(save).toHaveProperty("disabled", true);
    await user.type(screen.getByRole("textbox", { name: /^url/ }), "http://dir.test");
    await user.click(save);
    await vi.waitFor(() =>
      expect(bodyOf(calls.find((c) => c.method === "PUT"))).toEqual({
        config: { url: "http://dir.test" },
      }),
    );
  });

  it("通讯录插件已启用：立即同步 → POST directory/sync", async () => {
    const calls = api({
      [`GET ${BASE}/extensions`]: () => json(200, { extensions: [{ ...FAKE_IM, enabled: true }] }),
      [`POST ${BASE}/extensions/fake-im/directory/sync`]: () => json(202, { jobId: "j1" }),
    });
    await renderRouteWithCache("/settings/extensions", lastStubRoutes());
    await userEvent
      .setup()
      .click(await screen.findByRole("button", { name: "Sync directory of fake-im now" }));
    expect(await screen.findByText(en.extensions.syncStarted)).toBeTruthy();
    expect(calls.some((c) => c.method === "POST")).toBe(true);
  });

  it("二级导航：管理员才有「插件」", async () => {
    api({ [`GET ${BASE}/settings`]: () => json(200, { settings: { toolSearch: "on" } }) });
    await renderRouteWithCache("/settings/organization", lastStubRoutes(), { me: MEMBER });
    await screen.findByText(en.orgSettings.readonly);
    expect(screen.queryByRole("link", { name: en.connections.nav.extensions })).toBeNull();
    expect(screen.getByRole("link", { name: en.connections.nav.sandbox })).toBeTruthy();
  });
});

describe("组织设置：IM 语言", () => {
  it.each(["zh", "en"] as const)("改 IM 语言 → PATCH { locale }（%s）", async (locale) => {
    const o = msgs[locale].orgSettings;
    const calls = api({
      [`GET ${BASE}/settings`]: () => json(200, { settings: { toolSearch: "on", locale: "en" } }),
      [`PATCH ${BASE}/settings`]: (c) =>
        json(200, { settings: { toolSearch: "on", locale: "en", ...(bodyOf(c) as object) } }),
    });
    await renderRouteWithCache("/settings/organization", lastStubRoutes(), { locale });
    const select = await screen.findByRole("combobox", { name: o.locale.label });
    expect(select).toHaveProperty("value", "en");
    const user = userEvent.setup();
    await user.selectOptions(select, "zh");
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
