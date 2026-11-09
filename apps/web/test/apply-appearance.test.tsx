import { describeNestedBox, findNestedBoxes } from "@capybara-hq/design/reference";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { keys } from "../src/lib/query/keys";
import type { Me } from "../src/lib/session";
import { bodyOf, type Call, json, lastStubRoutes, stubApi } from "./support/api";
import { resetNavigation } from "./support/navigation";
import { renderRouteWithCache } from "./support/query";
import { ME } from "./support/render";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));

/**
 * 应用此插件的外观 (client extensions spec §6.5): the super admin on the admin plugin detail, an org
 * admin in the extension's Sheet on /extensions. A dry run first (its changes in a confirm dialog),
 * then the apply; members never see the action.
 */

const ID = "11111111-1111-4111-8111-111111111111";
const ORG = "/api/v1/orgs/o1";
const A = en.applyAppearance;
const fill = (s: string, vars: Record<string, string>) =>
  s.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? "");

const SUGGESTION = {
  theme: "neon",
  replacements: { "shell.brand": "brand", "conversation.empty": "hero", "nope.slot": "x" },
};

/** The kernel's answer: the theme, two replacements in the plugin's order, one skipped slot. */
const RESULT = {
  theme: { from: null, to: "t-neon" },
  replacements: [
    { slot: "shell.brand", from: null, to: "theme-neon/brand" },
    { slot: "conversation.empty", from: "other/hero", to: "theme-neon/hero" },
  ],
  skipped: [{ what: "nope.slot", reason: "unknown-slot" }],
};

const singles = [
  {
    slot: "shell.brand",
    candidates: [{ key: "theme-neon/brand", title: { zh: "霓虹品牌", en: "Neon brand" } }],
    use: null,
    followsPlatform: false,
  },
  {
    slot: "conversation.empty",
    candidates: [
      { key: "theme-neon/hero", title: { zh: "霓虹主视觉", en: "Neon hero" } },
      { key: "other/hero", title: { zh: "别的主视觉", en: "Other hero" } },
    ],
    use: "other/hero",
    followsPlatform: false,
  },
];

const item = (over: Record<string, unknown> = {}) => ({
  id: ID,
  name: "theme-neon",
  publisher: "Neon",
  displayName: { en: "Neon theme", zh: "霓虹主题" },
  description: "A neon look",
  scope: "all",
  scopeOrgs: [],
  builtin: false,
  disabled: false,
  shownToOthers: true,
  enabledOrgs: 1,
  pending: false,
  permissionsHash: null,
  latestVersion: "1.0.0",
  versions: ["1.0.0"],
  installs: 1,
  source: "file",
  marketplaceId: null,
  latestMarketplaceVersion: null,
  newerInMarketplace: false,
  contentChanged: false,
  componentCounts: { extension: 0, skills: 0, connectorTemplates: 0, agentTemplates: 0 },
  sourceFormat: "capybara",
  updatedAt: "2026-11-01T00:00:00.000Z",
  ...over,
});

const detail = (suggestedAppearance: unknown) => ({
  item: { ...item(), packageName: "@neon/theme", deletedAt: null },
  versions: [
    {
      version: "1.0.0",
      source: "file",
      sourceRef: "upload",
      integrity: null,
      contentDigest: null,
      sourceDetail: null,
      manifest: { name: "theme-neon", version: "1.0.0", publisher: "Neon", description: "" },
      size: 1024,
      extensionSha256: null,
      importedAt: "2026-11-01T00:00:00.000Z",
    },
  ],
  hasIcon: false,
  suggestedAppearance,
});

function adminRoutes(
  suggestedAppearance: unknown,
  extra: Record<string, (c: Call) => Response> = {},
) {
  return stubApi({
    [`GET /api/v1/admin/catalog/items/${ID}`]: () => json(200, detail(suggestedAppearance)),
    "GET /api/v1/admin/marketplaces": () => json(200, { items: [] }),
    "GET /api/v1/admin/catalog/items": () => json(200, { items: [item()], nextOffset: null }),
    "GET /api/v1/admin/orgs": () => json(200, { orgs: [] }),
    "GET /api/v1/admin/components?kind=skill": () => json(200, { components: [] }),
    "GET /api/v1/admin/components?kind=connector_template": () => json(200, { components: [] }),
    "GET /api/v1/admin/components?kind=agent_template": () => json(200, { components: [] }),
    "GET /api/v1/admin/components?kind=theme": () =>
      json(200, {
        components: [
          { id: "t-neon", kind: "theme", name: "neon", displayName: { en: "Neon", zh: "霓虹" } },
        ],
      }),
    "GET /api/v1/admin/ui/arrangement": () => json(200, { slots: singles }),
    ...extra,
  });
}

beforeEach(() => resetNavigation(`/admin/plugins/${ID}`));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("应用此插件的外观 on /admin/plugins/[itemId]", () => {
  it("apply appearance shows the dry run changes and applies on confirm", async () => {
    const calls = adminRoutes(SUGGESTION, {
      [`POST /api/v1/admin/catalog/items/${ID}/appearance`]: () => json(200, RESULT),
    });
    const { client } = await renderRouteWithCache(`/admin/plugins/${ID}`, lastStubRoutes());
    // what the apply changes elsewhere: the org's themes, the platform theme and arrangement
    client.setQueryData(keys.org("o1").themes(), { themes: [], resolved: null, org: {} });
    client.setQueryData(keys.org("o1").uiArrangement(), []);
    client.setQueryData(keys.org("o1").clientExtensions(), { enabled: true, items: [] });
    client.setQueryData(keys.deployment().platformTheme(), null);
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: en.catalog.admin.detail.actions.applyAppearance }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: fill(A.title, { name: "Neon theme" }),
    });
    expect(bodyOf(calls.find((c) => c.method === "POST"))).toEqual({ dryRun: true });
    // the changes in the kernel's (the plugin's) order, by name, then what is skipped
    const rows = within(within(dialog).getByRole("list", { name: A.changes }))
      .getAllByRole("listitem")
      .map((li) => li.textContent);
    expect(rows).toEqual([
      `${A.theme}${fill(A.change, { from: A.builtinTheme, to: "Neon" })}`,
      `${en.uiArrangement.slots.shellBrand}${fill(A.change, { from: A.builtin, to: "Neon brand" })}`,
      `${en.uiArrangement.slots.conversationEmpty}${fill(A.change, { from: "Other hero", to: "Neon hero" })}`,
      `${fill(A.skipped, { what: "nope.slot" })}${A.reason.unknownSlot}`,
    ]);
    expect(within(dialog).getByText(A.platformHint)).toBeTruthy();
    expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
    await user.click(within(dialog).getByRole("button", { name: A.apply }));
    await waitFor(() => expect(calls.filter((c) => c.method === "POST")).toHaveLength(2));
    expect(bodyOf(calls.filter((c) => c.method === "POST")[1])).toEqual({ dryRun: false });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    for (const key of [
      keys.org("o1").themes(),
      keys.org("o1").uiArrangement(),
      keys.org("o1").clientExtensions(),
      keys.deployment().platformTheme(),
    ]) {
      expect(client.getQueryState(key)?.isInvalidated, JSON.stringify(key)).toBe(true);
    }
    // the platform arrangement listing the dialog read is read again
    expect(calls.filter((c) => c.url === "/api/v1/admin/ui/arrangement").length).toBeGreaterThan(1);
  });

  it("nothing to change: the dialog says so and offers only 知道了 (zh)", async () => {
    const calls = adminRoutes(SUGGESTION, {
      [`POST /api/v1/admin/catalog/items/${ID}/appearance`]: () =>
        json(200, { theme: null, replacements: [], skipped: [] }),
    });
    await renderRouteWithCache(`/admin/plugins/${ID}`, lastStubRoutes(), { locale: "zh" });
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: zh.catalog.admin.detail.actions.applyAppearance }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(zh.applyAppearance.unchanged)).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: zh.applyAppearance.apply })).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: zh.applyAppearance.ok }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("a plugin without a suggestion has no apply action", async () => {
    adminRoutes(null);
    await renderRouteWithCache(`/admin/plugins/${ID}`, lastStubRoutes());
    await screen.findByRole("tab", { name: new RegExp(en.catalog.admin.detail.tabs.components) });
    expect(
      screen.queryByRole("button", { name: en.catalog.admin.detail.actions.applyAppearance }),
    ).toBeNull();
  });
});

/** The org's extension with a suggestion (org admins get `suggestedAppearance`, members do not). */
const ext = (over: Record<string, unknown> = {}) => ({
  plugin: "theme-neon",
  displayName: { en: "Neon theme", zh: "霓虹主题" },
  version: "1.0.0",
  enabled: true,
  configurable: false,
  config: null,
  secrets: [],
  permissions: [],
  orgConfigSchema: null,
  provides: [],
  ...over,
});

function orgRoutes(extension: Record<string, unknown>) {
  return stubApi({
    [`GET ${ORG}/extensions`]: () => json(200, { extensions: [extension] }),
    [`GET ${ORG}/file-previewers`]: () => json(200, { items: [] }),
    [`GET ${ORG}/extension-points`]: () => json(200, { points: [] }),
    [`GET ${ORG}/ui/arrangement`]: () => json(200, { slots: singles }),
    [`GET ${ORG}/ui/contributions`]: () => json(200, { items: [] }),
    [`GET ${ORG}/themes`]: () =>
      json(200, {
        themes: [{ id: "t-neon", key: "theme-neon/neon", name: { en: "Neon", zh: "霓虹" } }],
        resolved: null,
        org: { id: null, personal: "allowed" },
      }),
    [`GET ${ORG}/extensions/theme-neon/tools`]: () => json(200, { tools: [] }),
    [`POST ${ORG}/extensions/theme-neon/appearance`]: () => json(200, RESULT),
    "GET /api/v1/auth/sources": () => json(200, { sources: [] }),
  });
}

const as = (role: "owner" | "admin" | "member"): Me => ({
  ...ME,
  account: { ...ME.account, isSuperAdmin: false },
  memberships: [{ orgId: "o1", slug: "acme", name: "Acme", role }],
});

describe("应用此插件的外观 on /extensions", () => {
  beforeEach(() => resetNavigation("/extensions"));

  it("an org admin applies it from the extension's Sheet", async () => {
    const calls = orgRoutes(ext({ suggestedAppearance: SUGGESTION }));
    const { client } = await renderRouteWithCache("/extensions", lastStubRoutes(), {
      me: as("admin"),
    });
    client.setQueryData(keys.org("o1").clientExtensions(), { enabled: true, items: [] });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("row", { name: /Neon theme/ }));
    await user.click(
      await screen.findByRole("button", { name: fill(A.actionLabel, { name: "Neon theme" }) }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: fill(A.title, { name: "Neon theme" }),
    });
    expect(within(dialog).getByText(A.orgHint)).toBeTruthy();
    expect(
      within(dialog).getByText(fill(A.change, { from: A.builtinTheme, to: "Neon" })),
    ).toBeTruthy();
    expect(bodyOf(calls.find((c) => c.method === "POST"))).toEqual({ dryRun: true });
    await user.click(within(dialog).getByRole("button", { name: A.apply }));
    await waitFor(() => expect(calls.filter((c) => c.method === "POST")).toHaveLength(2));
    const applied = calls.findIndex(
      (c) =>
        c.method === "POST" &&
        bodyOf(c) !== undefined &&
        (bodyOf(c) as { dryRun: boolean }).dryRun === false,
    );
    expect(applied).toBeGreaterThan(-1);
    // the themes and the arrangement the dialog shows are read again; the client set goes stale
    await waitFor(() => {
      const after = calls.slice(applied + 1).map((c) => c.url);
      expect(after).toContain(`${ORG}/themes`);
      expect(after).toContain(`${ORG}/ui/arrangement`);
    });
    expect(client.getQueryState(keys.org("o1").clientExtensions())?.isInvalidated).toBe(true);
  });

  it("members see no apply action and read-only picks", async () => {
    // the kernel gives members no suggestion; even with one the page offers no action
    const calls = orgRoutes(ext({ suggestedAppearance: SUGGESTION }));
    await renderRouteWithCache("/extensions", lastStubRoutes(), { me: as("member") });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("row", { name: /Neon theme/ }));
    await screen.findByRole("dialog", { name: "Neon theme" });
    expect(
      screen.queryByRole("button", { name: fill(A.actionLabel, { name: "Neon theme" }) }),
    ).toBeNull();
    expect(screen.queryByText(en.extensions.appearanceTitle)).toBeNull();
    // 界面位置's replaceable slots are read only for members
    const table = screen.getByRole("table", { name: en.uiArrangement.replaceTitle });
    expect(within(table).getByText("Other hero")).toBeTruthy();
    expect(within(table).queryByRole("combobox")).toBeNull();
    expect(calls.some((c) => c.method === "POST" || c.method === "PATCH")).toBe(false);
    expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
  });
});
