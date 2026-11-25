import { describeNestedBox, findNestedBoxes } from "@capybara-hq/design/reference";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import { validateTenantId } from "../src/lib/login-sources";
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
 * The login methods in the admin console (login extensions spec §3): an identity source's sign-in
 * section on its extension page (the switch, unlinked accounts, trusted tenants checked by the
 * source's tenant declaration, the callback URL) and the login methods on `/admin/settings` (the
 * enabled methods reordered, each move saving the whole order; the others listed without reorder).
 */

const S = en.loginSources.section;
const M = en.loginSources.methods;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const fill = (s: string, vars: Record<string, string>) =>
  s.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? "");

type Source = Record<string, unknown> & { plugin: string };

const SLACK_TENANT = {
  label: { zh: "Slack 工作区 ID", en: "Slack workspace ID" },
  pattern: "^T[A-Z0-9]+$",
  placeholder: "T0123ABCD",
};

function source(plugin: string, over: Partial<Source> = {}): Source {
  return {
    plugin,
    label: { zh: plugin, en: plugin[0]?.toUpperCase() + plugin.slice(1) },
    enabled: false,
    signUp: "link",
    trustedTenants: [],
    available: true,
    needsConfig: false,
    callbackUrl: `https://cap.example.com/api/v1/auth/sso/${plugin}/callback`,
    ...over,
  };
}

const SHA = "a".repeat(64);
const group = (category: string, items: string[]) => ({
  category,
  sensitive: false,
  items,
  entries: items.map((value) => ({ value, sensitive: false })),
});

/** An installed identity source extension as `/api/v1/admin/extensions` lists it. */
const extension = (name: string, over: Record<string, unknown> = {}) => ({
  name,
  version: "1.0.0",
  source: "install",
  sha256: SHA,
  status: "enabled",
  desired: { version: "1.0.0", sha256: SHA, state: "enabled" },
  replicas: [],
  permissions: [group("provides", ["identity-source@1"])],
  added: [],
  addedItems: [],
  warnings: [],
  removed: [],
  reviewHash: "0123456789abcdef",
  sensitive: false,
  snapshot: { version: "1.0.0", approvedAt: "2026-10-21T00:00:00.000Z", approvedBy: "a1" },
  configurable: true,
  configValid: true,
  removable: true,
  required: false,
  installSource: "file",
  ...over,
});

beforeEach(() => window.history.replaceState(null, "", "/"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("validateTenantId (the SDK rule, mirrored)", () => {
  it("checks blanks, the pattern and the tenants never trusted", () => {
    expect(validateTenantId(SLACK_TENANT, "T0123ABCD")).toBe("ok");
    expect(validateTenantId(SLACK_TENANT, "E0123")).toBe("pattern");
    expect(
      validateTenantId({ label: SLACK_TENANT.label, neverTrusted: ["consumer"] }, "consumer"),
    ).toBe("never_trusted");
    expect(validateTenantId(undefined, "anything")).toBe("ok");
    expect(validateTenantId(undefined, " ")).toBe("empty");
    // an invalid pattern counts as none
    expect(validateTenantId({ label: SLACK_TENANT.label, pattern: "(" }, "x")).toBe("ok");
  });
});

describe("登录 on an identity source's extension page", () => {
  /** The extension page's routes with the given login method; PUTs answer `answer`. */
  function routes(item: Source | null, ext = extension("slack"), answer?: (c: Call) => Response) {
    return stubApi({
      "GET /api/v1/admin/extensions": () => json(200, { extensions: [ext], drainSeconds: 30 }),
      [`GET /api/v1/admin/extensions/${ext.name}/guides`]: () => json(200, { guides: [] }),
      [`GET /api/v1/admin/extensions/${ext.name}/config`]: () =>
        json(200, {
          plugin: ext.name,
          version: "1.0.0",
          configurable: false,
          schema: null,
          fields: [],
          valid: true,
          validated: true,
          issues: [],
        }),
      "GET /api/v1/admin/login-sources": () => json(200, { items: item === null ? [] : [item] }),
      [`PUT /api/v1/admin/login-sources/${ext.name}`]:
        answer ??
        ((c: Call) => json(200, { ...item, ...(bodyOf(c) as Record<string, unknown>) } as Source)),
    });
  }

  async function openConfig(name = "slack") {
    resetNavigation(`/admin/extensions/${name}`);
    const r = await renderRouteWithCache(`/admin/extensions/${name}`, lastStubRoutes(), {
      locale: "en",
    });
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("tab", { name: en.admin.extensions.detail.tabs.config }),
    );
    const section = (await screen.findByRole("heading", { name: S.title })).closest(
      "section",
    ) as HTMLElement;
    return { ...r, user, section };
  }

  it("toggling 在登录页显示 calls update and refreshes the methods and the login page's sources", async () => {
    const calls = routes(source("slack", { tenant: SLACK_TENANT }));
    const { user, section, client } = await openConfig();
    client.setQueryData(keys.deployment().authSources(), { sources: [] });
    const toggle = within(section).getByRole("switch", { name: S.show });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await user.click(toggle);
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.url).toBe("/api/v1/admin/login-sources/slack");
    expect(bodyOf(put)).toEqual({ enabled: true });
    // the methods are read again, and the login page's cached sources are stale
    await waitFor(() =>
      expect(
        calls.filter((c) => c.method === "GET" && c.url === "/api/v1/admin/login-sources"),
      ).toHaveLength(1),
    );
    expect(client.getQueryState(keys.deployment().authSources())?.isInvalidated).toBe(true);
    // the section shows the callback URL to copy, and draws no box inside its card
    expect(within(section).getByText(S.callback.label)).toBeTruthy();
    expect(
      within(section).getByText("https://cap.example.com/api/v1/auth/sso/slack/callback"),
    ).toBeTruthy();
    expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
  });

  it("needsConfig disables the switch with the hint", async () => {
    routes(source("slack", { needsConfig: true }));
    const { section } = await openConfig();
    const toggle = within(section).getByRole("switch", { name: S.show }) as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    expect(within(section).getByText(S.needsConfig)).toBeTruthy();
  });

  it("an extension that is not running disables turning it on, with the hint", async () => {
    routes(source("slack", { available: false }));
    const { section } = await openConfig();
    const toggle = within(section).getByRole("switch", { name: S.show }) as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    expect(within(section).getByText(S.unavailable)).toBeTruthy();
  });

  it("an extension waiting for config that the methods do not list yet shows the switch off, with the hint", async () => {
    routes(null, extension("slack", { status: "pending_config", configValid: false }));
    const { section } = await openConfig();
    const toggle = within(section).getByRole("switch", { name: S.show }) as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    expect(within(section).getByText(S.needsConfig)).toBeTruthy();
    expect(within(section).queryByRole("radiogroup")).toBeNull();
  });

  it("a tenant failing the pattern shows the field error and cannot be saved", async () => {
    const calls = routes(source("slack", { tenant: SLACK_TENANT }));
    const { user, section } = await openConfig();
    const field = within(section).getByRole("textbox", {
      name: fill(S.tenants.label, { tenant: "Slack workspace ID" }),
    });
    expect(field.getAttribute("placeholder")).toBe("T0123ABCD");
    // the trust warning sits with the field
    expect(within(section).getByText(S.tenants.warning)).toBeTruthy();
    await user.type(field, "T0123ABCD{Enter}E0123");
    expect(
      await within(section).findByText(
        fill(S.tenants.invalidPattern, { tenant: "E0123", label: "Slack workspace ID" }),
      ),
    ).toBeTruthy();
    const save = within(section).getByRole("button", { name: S.tenants.save }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    // fixed, it saves the whole list
    await user.clear(field);
    await user.type(field, "T0123ABCD{Enter}T0456EFGH");
    expect(save.disabled).toBe(false);
    await user.click(save);
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(bodyOf(calls.find((c) => c.method === "PUT"))).toEqual({
      trustedTenants: ["T0123ABCD", "T0456EFGH"],
    });
  });

  it("choosing 自动注册新账号 saves signUp at once", async () => {
    const calls = routes(source("slack"));
    const { user, section } = await openConfig();
    expect(
      (
        within(section).getByRole("radio", {
          name: new RegExp(`^${escapeRe(S.signUp.link)}`),
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
    await user.click(
      within(section).getByRole("radio", { name: new RegExp(`^${escapeRe(S.signUp.create)}`) }),
    );
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(bodyOf(calls.find((c) => c.method === "PUT"))).toEqual({ signUp: "create" });
  });

  it("an extension that is no identity source has no 登录 section and reads no methods", async () => {
    const calls = routes(null, extension("demo", { permissions: [group("tools", ["echo"])] }));
    resetNavigation("/admin/extensions/demo");
    await renderRouteWithCache("/admin/extensions/demo", lastStubRoutes(), { locale: "en" });
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("tab", { name: en.admin.extensions.detail.tabs.config }),
    );
    expect(screen.queryByRole("heading", { name: S.title })).toBeNull();
    expect(calls.filter((c) => c.url === "/api/v1/admin/login-sources")).toEqual([]);
  });
});

describe("登录方式 on /admin/settings", () => {
  const SETTINGS = {
    orgCreation: "anyone",
    runConcurrencyOverrides: {},
    priceCurrency: "USD",
    sandboxLimitOverrides: {},
    customConnectors: "allow",
    customSkills: "allow",
    clientExtensions: { enabled: true, disabled: [] as string[] },
  };
  const ITEMS = [
    source("slack", { enabled: true }),
    source("lark", { enabled: true }),
    source("google", { enabled: true }),
    source("github"),
    source("okta", { needsConfig: true }),
  ];

  /** The settings page's routes; the order route reorders what the list answers next. */
  function routes(initial: Source[] = ITEMS) {
    let items = initial;
    return stubApi({
      "GET /api/v1/admin/platform/icons": () => json(200, { icons: [] }),
      "GET /api/v1/platform/theme": () => json(200, null),
      "GET /api/v1/admin/settings": () => json(200, SETTINGS),
      "GET /api/v1/admin/components?kind=theme": () => json(200, { components: [] }),
      "GET /api/v1/admin/ui/arrangement": () => json(200, { slots: [] }),
      "GET /api/v1/admin/extensions": () => json(200, { extensions: [], drainSeconds: 30 }),
      "GET /api/v1/admin/login-sources": () => json(200, { items }),
      "PUT /api/v1/admin/login-sources/order": (c: Call) => {
        const { plugins } = bodyOf(c) as { plugins: string[] };
        const by = new Map(items.map((s) => [s.plugin, s]));
        items = [...plugins.map((p) => by.get(p) as Source), ...items.filter((s) => !s.enabled)];
        return json(200, { items });
      },
    });
  }

  async function render() {
    resetNavigation("/admin/settings");
    const r = await renderRouteWithCache("/admin/settings", lastStubRoutes(), { locale: "en" });
    const section = (await screen.findByRole("heading", { name: M.title })).closest(
      "section",
    ) as HTMLElement;
    return { ...r, section, user: userEvent.setup() };
  }

  const ordered = (section: HTMLElement) =>
    within(within(section).getByRole("group", { name: M.orderLabel }))
      .getAllByRole("group")
      .map((g) => g.getAttribute("aria-label"));

  it("lists the enabled methods in order, each linking to its extension page", async () => {
    routes();
    const { section } = await render();
    expect(ordered(section)).toEqual(["Slack", "Lark", "Google"]);
    expect(within(section).getByRole("link", { name: "Lark" }).getAttribute("href")).toBe(
      "/admin/extensions/lark",
    );
    expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
  });

  it("reorder by move button saves the new order", async () => {
    const calls = routes();
    const { section, user } = await render();
    await user.click(within(section).getByRole("button", { name: "Move Google up" }));
    expect(ordered(section)).toEqual(["Slack", "Google", "Lark"]);
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    // the methods are read again after the save, in the saved order
    await waitFor(() =>
      expect(
        calls.filter((c) => c.method === "GET" && c.url === "/api/v1/admin/login-sources"),
      ).toHaveLength(1),
    );
    expect(ordered(section)).toEqual(["Slack", "Google", "Lark"]);
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.url).toBe("/api/v1/admin/login-sources/order");
    expect(bodyOf(put)).toEqual({ plugins: ["slack", "google", "lark"] });
  });

  it("disabled sources are listed below with their state and are not reorderable", async () => {
    routes();
    const { section } = await render();
    const others = within(section).getByRole("list", { name: M.others });
    expect(within(others).getByRole("link", { name: "Github" }).getAttribute("href")).toBe(
      "/admin/extensions/github",
    );
    expect(within(others).getByText(M.off)).toBeTruthy();
    expect(within(others).getByText(M.needsConfig)).toBeTruthy();
    expect(within(others).queryByRole("button")).toBeNull();
    expect(screen.queryByRole("button", { name: /Move Github/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Move Okta/ })).toBeNull();
  });

  it("without login methods it says so", async () => {
    routes([]);
    const { section } = await render();
    expect(within(section).getByText(M.empty)).toBeTruthy();
  });
});
