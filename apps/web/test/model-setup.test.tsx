import { cleanup, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import OrgModelsView from "../src/app/(app)/settings/models/view";
import type { OrgReadiness } from "../src/lib/agents";
import type { Me } from "../src/lib/session";
import { bodyOf, type Call, json, lastStubRoutes, stubApi } from "./support/api";
import { resetNavigation, router } from "./support/navigation";
import { renderRouteWithCache } from "./support/query";
import { ME } from "./support/render";
import { renderFrame, shellOf } from "./support/shell";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));

// Task 14 of the 2026-11-16 design review: one place to set up a model. The setup checklist, the
// run row's fix entry and the models pages lead to /admin/models (super admins: deploy and configure
// a model service) and /settings/models (org admins: turn a deployed one on in the org). Model
// providers are opt-in per org: readiness `not_enabled` while the platform has one this org has not
// switched on.

const NOT_ENABLED: OrgReadiness = {
  modelProvider: "not_enabled",
  notEnabledProviders: ["anthropic"],
  agents: 0,
};
const MODEL_READY: OrgReadiness = { modelProvider: "ready", notEnabledProviders: [], agents: 0 };

const orgAdmin: Me = {
  ...ME,
  account: { ...ME.account, isSuperAdmin: false },
  memberships: [{ orgId: "o1", slug: "acme", name: "Acme", role: "admin" }],
};
const member: Me = {
  ...orgAdmin,
  memberships: [{ orgId: "o1", slug: "acme", name: "Acme", role: "member" }],
};

const provides = (point: string) => ({
  category: "provides",
  sensitive: false,
  items: [point],
  entries: [{ value: point, sensitive: false }],
});

/** A model service the platform deployed and offers this org, off here until the org enables it. */
const anthropic = (over: Record<string, unknown> = {}) => ({
  plugin: "anthropic",
  displayName: { zh: "Anthropic 模型", en: "Anthropic models" },
  icon: null,
  version: "0.1.0",
  enabled: false,
  configurable: false,
  config: null,
  secrets: [],
  permissions: [provides("model-provider@2")],
  orgConfigSchema: null,
  available: true,
  required: false,
  catalogItem: { itemId: "i1", scope: "optional" },
  switchable: true,
  provides: ["model-provider@2"],
  overrideState: "none",
  needsConfig: false,
  ...over,
});

/** An extension that provides no models: never a row of Model services. */
const SEARCH = {
  ...anthropic(),
  plugin: "web-search-x",
  displayName: null,
  permissions: [provides("web-search@1")],
  provides: ["web-search@1"],
};

const CHAT = {
  id: "claude-x",
  displayName: "Claude X",
  contextWindow: 1000,
  maxOutputTokens: 100,
  capabilities: { tools: true, vision: false, reasoning: false, caching: false },
  parameters: [],
};

/**
 * The org's kernel for /settings/models: the extension list holds `exts`; turning one on answers it
 * enabled and from then on the org's readiness, models and catalog have it.
 */
function orgKernel(exts: Record<string, unknown>[], start: OrgReadiness = NOT_ENABLED) {
  const state = { on: false, readiness: start };
  const list = () =>
    exts.map((e) => (e.plugin === "anthropic" && state.on ? { ...e, enabled: true } : e));
  const calls = stubApi({
    "GET /api/v1/orgs/o1/readiness": () => json(200, state.readiness),
    "GET /api/v1/orgs/o1/model-purposes": () => json(200, { purposes: [] }),
    "GET /api/v1/orgs/o1/models": () =>
      json(200, { providers: state.on ? [{ provider: "anthropic", models: [CHAT] }] : [] }),
    "GET /api/v1/orgs/o1/models/catalog": () =>
      json(200, {
        providers: state.on
          ? [
              {
                provider: "anthropic",
                plugin: "anthropic",
                status: "ok",
                displayName: { zh: "Anthropic 模型", en: "Anthropic models" },
                models: [CHAT],
              },
            ]
          : [],
      }),
    "GET /api/v1/orgs/o1/extensions": () => json(200, { extensions: list() }),
    // what the shell reads again when an extension changes (its UI contributions)
    "GET /api/v1/orgs/o1/ui/contributions": () => json(200, { items: [] }),
    "PUT /api/v1/orgs/o1/extensions/anthropic": (c) => {
      const body = bodyOf(c) as { enabled?: boolean };
      if (body.enabled === true) {
        state.on = true;
        state.readiness = MODEL_READY;
      }
      return json(200, { extension: list().find((e) => e.plugin === "anthropic") });
    },
  });
  return { calls, state };
}

const gets = (calls: Call[], url: string) =>
  calls.filter((c) => c.method === "GET" && c.url === url).length;

beforeEach(() => {
  resetNavigation("/settings/models");
  window.history.replaceState(null, "", "/");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the opt-in provider case, end to end in the web app", () => {
  it("fresh org, a platform provider not on here: the org admin's setup step leads to /settings/models, 启用 there makes the model ready", async () => {
    const { calls } = orgKernel([anthropic(), SEARCH]);
    // the setup home: the model step is the org admin's to do, with the not-enabled copy
    resetNavigation("/");
    const home = renderFrame(shellOf(orgAdmin, { readiness: NOT_ENABLED }));
    const main = within(screen.getByRole("main"));
    const step = main.getByText(zh.setupLayout.steps.model).closest("li") as HTMLElement;
    expect(step.getAttribute("data-state")).toBe("todo");
    expect(within(step).getByText(zh.chat.setup.model.enableDescription)).toBeTruthy();
    const go = within(step).getByRole("link", { name: zh.chat.setup.model.enableAction });
    expect(go.getAttribute("href")).toBe("/settings/models");
    // never the misleading "a super admin must set up a model service"
    expect(screen.queryByText(zh.setupLayout.model.needsDeploymentAdmin)).toBeNull();
    expect(screen.queryByText(zh.setupLayout.waitingDeployment)).toBeNull();
    home.unmount();

    // the step page in the setup frame: the warn line and the service with "Turn on"
    resetNavigation("/settings/models");
    renderFrame(shellOf(orgAdmin, { readiness: NOT_ENABLED }), <OrgModelsView />);
    expect(await screen.findByText(zh.models.org.providers.notEnabled)).toBeTruthy();
    const services = await screen.findByRole("list", { name: zh.models.org.providers.title });
    // only the model services: the search extension is not a row
    expect(within(services).queryByText("web-search-x")).toBeNull();
    const row = within(services).getByText("Anthropic 模型").closest("li") as HTMLElement;
    expect(within(row).getByText(zh.extensions.disabled)).toBeTruthy();
    const sidebarModel = () =>
      [...document.querySelectorAll<HTMLElement>('[data-part="step-item"]')].find((el) =>
        el.textContent?.includes(zh.setupLayout.steps.model),
      );
    expect(sidebarModel()?.getAttribute("data-state")).not.toBe("done");

    const user = userEvent.setup();
    await user.click(
      within(row).getByRole("button", {
        name: zh.models.org.providers.enableLabel.replace("{plugin}", "Anthropic 模型"),
      }),
    );
    await vi.waitFor(() =>
      expect(bodyOf(calls.find((c) => c.method === "PUT"))).toEqual({ enabled: true }),
    );
    // readiness is read again: the frame's model step is done, the warn line gone, the row on and
    // the catalog below lists the provider's models
    await vi.waitFor(() => expect(sidebarModel()?.getAttribute("data-state")).toBe("done"));
    expect(gets(calls, "/api/v1/orgs/o1/readiness")).toBeGreaterThan(0);
    await vi.waitFor(() =>
      expect(screen.queryByText(zh.models.org.providers.notEnabled)).toBeNull(),
    );
    const onRow = within(
      within(screen.getByRole("list", { name: zh.models.org.providers.title }))
        .getByText("Anthropic 模型")
        .closest("li") as HTMLElement,
    );
    await vi.waitFor(() => expect(onRow.getByText(zh.extensions.enabled)).toBeTruthy());
    expect(onRow.queryByRole("button", { name: /启用/ })).toBeNull();
    expect(await screen.findByRole("switch", { name: "Claude X" })).toBeTruthy();
  });

  it("启用 invalidates the org's readiness, models, catalog and purposes", async () => {
    const { calls } = orgKernel([anthropic()]);
    await renderRouteWithCache("/settings/models", lastStubRoutes(), {
      me: orgAdmin,
      readiness: NOT_ENABLED,
    });
    const before = calls.length;
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", {
        name: en.models.org.providers.enableLabel.replace("{plugin}", "Anthropic models"),
      }),
    );
    const after = () => calls.slice(before).map((c) => `${c.method} ${c.url}`);
    await vi.waitFor(() =>
      expect(after()).toEqual(
        expect.arrayContaining([
          "PUT /api/v1/orgs/o1/extensions/anthropic",
          "GET /api/v1/orgs/o1/models",
          "GET /api/v1/orgs/o1/models/catalog",
          "GET /api/v1/orgs/o1/model-purposes",
        ]),
      ),
    );
    expect(
      await screen.findByText(en.extensions.enabledToast.replace("{plugin}", "Anthropic models")),
    ).toBeTruthy();
  });
});

describe("setup steps for the model by role", () => {
  beforeEach(() => resetNavigation("/"));
  const modelStep = () =>
    within(screen.getByRole("main"))
      .getByText(zh.setupLayout.steps.model)
      .closest("li") as HTMLElement;

  it("not_enabled: a member waits for an org admin, with no link", () => {
    renderFrame(shellOf(member, { readiness: NOT_ENABLED }));
    const step = modelStep();
    expect(within(step).queryByRole("link")).toBeNull();
    expect(within(step).getByText(zh.setupLayout.model.waitingForOrgAdmin)).toBeTruthy();
    expect(within(step).getByText(zh.chat.setup.model.askOrgAdmin)).toBeTruthy();
  });

  it("not_enabled: a super admin who owns the org turns it on in the org, not in the admin console", () => {
    renderFrame(shellOf(ME, { readiness: NOT_ENABLED }));
    const link = within(modelStep()).getByRole("link", { name: zh.chat.setup.model.enableAction });
    expect(link.getAttribute("href")).toBe("/settings/models");
  });

  it("not_enabled: a super admin who is a plain member waits like a member", () => {
    renderFrame(
      shellOf(
        { ...member, account: { ...member.account, isSuperAdmin: true } },
        {
          readiness: NOT_ENABLED,
        },
      ),
    );
    expect(within(modelStep()).queryByRole("link")).toBeNull();
    expect(within(modelStep()).getByText(zh.setupLayout.model.waitingForOrgAdmin)).toBeTruthy();
  });

  it("none: the super admin deploys one on /admin/models; an org admin waits for a super admin", () => {
    renderFrame(
      shellOf(ME, { readiness: { modelProvider: "none", notEnabledProviders: [], agents: 0 } }),
    );
    const link = within(modelStep()).getByRole("link", { name: zh.chat.setup.model.action });
    expect(link.getAttribute("href")).toBe("/admin/models");
    expect(within(modelStep()).getByText(zh.chat.setup.model.description)).toBeTruthy();
    cleanup();
    renderFrame(
      shellOf(orgAdmin, {
        readiness: { modelProvider: "none", notEnabledProviders: [], agents: 0 },
      }),
    );
    expect(within(modelStep()).queryByRole("link")).toBeNull();
    expect(within(modelStep()).getByText(zh.setupLayout.model.needsDeploymentAdmin)).toBeTruthy();
    expect(within(modelStep()).getByText(zh.chat.setup.model.askAdmin)).toBeTruthy();
  });
});

describe("/settings/models: 模型服务", () => {
  it("a service that needs org config: 配置 opens its Sheet, 保存并启用 sends the config with the switch", async () => {
    const schema = {
      type: "object",
      properties: { apiKey: { type: "string", title: "API key" } },
      required: ["apiKey"],
    };
    const { calls } = orgKernel([
      anthropic({ configurable: true, orgConfigSchema: schema, needsConfig: true }),
    ]);
    await renderRouteWithCache("/settings/models", lastStubRoutes(), {
      me: orgAdmin,
      readiness: NOT_ENABLED,
    });
    const services = await screen.findByRole("list", { name: en.models.org.providers.title });
    const row = within(services).getByText("Anthropic models").closest("li") as HTMLElement;
    expect(within(row).getByText(en.extensions.needsConfig)).toBeTruthy();
    // no "Turn on" while it waits for config: configuring comes first
    expect(within(row).queryByRole("button", { name: /Turn on/ })).toBeNull();
    const user = userEvent.setup();
    await user.click(
      within(row).getByRole("button", {
        name: en.models.org.providers.configureLabel.replace("{plugin}", "Anthropic models"),
      }),
    );
    const sheet = await screen.findByRole("dialog", { name: "Anthropic models" });
    await user.type(within(sheet).getByRole("textbox", { name: /API key/ }), "sk-1");
    await user.click(
      within(sheet).getByRole("button", {
        name: en.extensions.saveAndEnableLabel.replace("{plugin}", "Anthropic models"),
      }),
    );
    await vi.waitFor(() =>
      expect(bodyOf(calls.find((c) => c.method === "PUT"))).toEqual({
        enabled: true,
        config: { apiKey: "sk-1" },
      }),
    );
  });

  it("a service the platform cannot run: its state, no action for an org admin", async () => {
    orgKernel([anthropic({ available: false, reason: "needs_deployment_config" })], {
      modelProvider: "none",
      notEnabledProviders: [],
      agents: 0,
    });
    await renderRouteWithCache("/settings/models", lastStubRoutes(), {
      me: orgAdmin,
      readiness: { modelProvider: "none", notEnabledProviders: [], agents: 0 },
    });
    const services = await screen.findByRole("list", { name: en.models.org.providers.title });
    const row = within(services).getByText("Anthropic models").closest("li") as HTMLElement;
    expect(
      within(row).getByText(
        en.extensions.unavailableWith.replace(
          "{reason}",
          en.extensions.reasons.needs_deployment_config,
        ),
      ),
    ).toBeTruthy();
    expect(within(row).queryByRole("button")).toBeNull();
    // the warn line is for not_enabled only
    expect(screen.queryByText(en.models.org.providers.notEnabled)).toBeNull();
  });

  it.each([
    ["a super admin", ME, true],
    ["an org admin", orgAdmin, false],
  ] as const)(
    "no model service on the platform: %s gets the deploy link: %s",
    async (_who, me, link) => {
      orgKernel([SEARCH], { modelProvider: "none", notEnabledProviders: [], agents: 0 });
      await renderRouteWithCache("/settings/models", lastStubRoutes(), {
        me,
        readiness: { modelProvider: "none", notEnabledProviders: [], agents: 0 },
      });
      expect(await screen.findByText(en.models.org.noProviders)).toBeTruthy();
      const to = screen.queryByRole("link", { name: en.models.org.toAdminModels });
      expect(to?.getAttribute("href") ?? null).toBe(link ? "/admin/models" : null);
      expect(screen.queryByRole("list", { name: en.models.org.providers.title })).toBeNull();
    },
  );
});

describe("/admin/models: 模型服务", () => {
  const SHA = "a".repeat(64);
  const deployed = (over: Record<string, unknown> = {}) => ({
    name: "anthropic",
    displayName: { zh: "Anthropic 模型", en: "Anthropic models" },
    icon: null,
    version: "0.1.0",
    source: "install",
    installSource: "file",
    sha256: SHA,
    status: "pending_config",
    desired: null,
    replicas: [],
    permissions: [provides("model-provider@2")],
    added: [],
    addedItems: [],
    removed: [],
    warnings: [],
    reviewHash: "0123",
    sensitive: false,
    snapshot: null,
    configurable: true,
    configValid: false,
    removable: true,
    required: false,
    ...over,
  });
  const entry = (name: string, keys: string[], over: Record<string, unknown> = {}) => ({
    sourceId: "official",
    sourceName: "Official",
    name,
    version: "1.0.0",
    summary: { en: `${name} summary` },
    displayName: null,
    minKernel: null,
    homepage: null,
    permissions: { keys, sensitive: [] },
    source: { npm: { package: `@capybara-hq/plugin-${name}`, version: "1.0.0" } },
    compatible: true,
    importable: true,
    adopted: null,
    newerAvailable: false,
    contentChanged: false,
    ...over,
  });

  function adminKernel(extensions: unknown[], items: unknown[]) {
    return stubApi({
      "GET /api/v1/admin/models": () => json(200, { providers: [], prices: [], currency: "EUR" }),
      "GET /api/v1/admin/model-purposes": () => json(200, { purposes: [] }),
      "GET /api/v1/admin/extensions": () => json(200, { extensions, drainSeconds: 30 }),
      "GET /api/v1/admin/marketplaces/entries": () => json(200, { items }),
      "GET /api/v1/admin/extensions/anthropic/config": () =>
        json(200, {
          plugin: "anthropic",
          version: "0.1.0",
          configurable: true,
          schema: {
            type: "object",
            properties: { baseUrl: { type: "string", title: "Base URL" } },
          },
          fields: [{ path: "baseUrl", secret: false, hot: true, source: "unset", readonly: false }],
          valid: true,
          validated: true,
          issues: [],
        }),
      "GET /api/v1/admin/extensions/anthropic/org-overrides": () => json(200, { overrides: [] }),
      "POST /api/v1/admin/marketplaces/official/entries/openai/import": () =>
        json(200, { stagingId: "st1" }),
    });
  }

  beforeEach(() => resetNavigation("/admin/models"));

  it("lists the deployed services with 配置 (their deployment config in a Sheet) and the marketplace's model services not installed yet with 安装", async () => {
    const calls = adminKernel(
      [deployed(), { ...deployed(), name: "search", displayName: null, permissions: [] }],
      [
        entry("openai", ["provides:model-provider@2"]),
        // already installed, not a model service, or not importable: not offered
        entry("anthropic", ["provides:model-provider@2"], {
          adopted: { itemId: "i1", versions: ["1.0.0"] },
        }),
        entry("lark", ["provides:channel@1"]),
        entry("old", ["provides:model-provider@1"], { compatible: false }),
      ],
    );
    await renderRouteWithCache("/admin/models", lastStubRoutes());
    const list = await screen.findByRole("list", { name: en.models.admin.setup.title });
    const titles = [...list.querySelectorAll(".cb-item-list-title")].map((e) => e.textContent);
    expect(titles).toEqual(["Anthropic models", "openai"]);
    const anthropicRow = within(list).getByText("Anthropic models").closest("li") as HTMLElement;
    expect(
      within(anthropicRow).getByRole("link", { name: "Anthropic models" }).getAttribute("href"),
    ).toBe("/admin/extensions/anthropic");
    expect(within(anthropicRow).getByText(en.admin.extensions.status.pending_config)).toBeTruthy();
    const user = userEvent.setup();
    await user.click(
      within(anthropicRow).getByRole("button", {
        name: en.models.admin.setup.configureLabel.replace("{plugin}", "Anthropic models"),
      }),
    );
    const sheet = await screen.findByRole("dialog", { name: "Anthropic models" });
    expect(await within(sheet).findByRole("textbox", { name: /Base URL/ })).toBeTruthy();
    await user.keyboard("{Escape}");

    const openaiRow = within(list).getByText("openai").closest("li") as HTMLElement;
    expect(within(openaiRow).getByText(en.models.admin.setup.notInstalled)).toBeTruthy();
    await user.click(
      within(openaiRow).getByRole("button", {
        name: en.models.admin.setup.installLabel.replace("{plugin}", "openai"),
      }),
    );
    await vi.waitFor(() =>
      expect(router.push).toHaveBeenCalledWith("/admin/plugins/import?staging=st1"),
    );
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/openai/import"))).toBe(true);
    // the whole marketplace is one link away
    expect(screen.getByRole("link", { name: en.models.admin.toMarket }).getAttribute("href")).toBe(
      "/admin/plugins/market",
    );
  });

  it("no model service anywhere: the list's empty state links to the marketplace", async () => {
    adminKernel([], [entry("lark", ["provides:channel@1"])]);
    await renderRouteWithCache("/admin/models", lastStubRoutes());
    expect(await screen.findByText(en.models.admin.noProviders)).toBeTruthy();
    const links = screen.getAllByRole("link", { name: en.models.admin.toMarket });
    expect(links.map((l) => l.getAttribute("href"))).toEqual(["/admin/plugins/market"]);
  });
});
