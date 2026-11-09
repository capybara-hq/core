import { describeNestedBox, findNestedBoxes } from "@capybara-hq/design/reference";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { keys } from "../src/lib/query/keys";
import type { Me } from "../src/lib/session";
import type { UiArrangementSingleSlot } from "../src/lib/ui";
import { bodyOf, json, lastStubRoutes, stubApi } from "./support/api";
import { resetNavigation } from "./support/navigation";
import { renderRouteWithCache } from "./support/query";
import { ME } from "./support/render";
import { optionLabels, pickOption } from "./support/select";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));

/**
 * The replaceable slots of 界面位置 (client extensions spec §6.3): one table row per single slot
 * with a select 内置 / candidates, whether the org follows the platform, and 跟随平台.
 */

const BASE = "/api/v1/orgs/o1";
const t = en.uiArrangement;

const brand = (over: Partial<UiArrangementSingleSlot> = {}): UiArrangementSingleSlot => ({
  slot: "shell.brand",
  candidates: [{ key: "theme-neon/brand", title: { zh: "霓虹品牌", en: "Neon brand" } }],
  use: null,
  followsPlatform: true,
  ...over,
});

function api(single: UiArrangementSingleSlot) {
  return stubApi({
    [`GET ${BASE}/extensions`]: () => json(200, { extensions: [] }),
    [`GET ${BASE}/file-previewers`]: () => json(200, { items: [] }),
    [`GET ${BASE}/extension-points`]: () => json(200, { points: [] }),
    [`GET ${BASE}/ui/arrangement`]: () =>
      json(200, {
        slots: [
          { slot: "org.page", source: "none", items: [] },
          single,
          // a replaceable slot nothing may replace and nothing picked: not listed
          { slot: "conversation.empty", candidates: [], use: null, followsPlatform: true },
        ],
      }),
    [`GET ${BASE}/ui/contributions`]: () => json(200, { items: [] }),
    [`GET ${BASE}/ui/client`]: () => json(200, { enabled: true, apiVersion: 1, items: [] }),
    [`PATCH ${BASE}/settings`]: () => json(200, { settings: {} }),
    "GET /api/v1/auth/sources": () => json(200, { sources: [] }),
  });
}

const as = (role: "owner" | "admin" | "member"): Me => ({
  ...ME,
  account: { ...ME.account, isSuperAdmin: false },
  memberships: [{ orgId: "o1", slug: "acme", name: "Acme", role }],
});

beforeEach(() => {
  resetNavigation("/extensions");
  window.history.replaceState(null, "", "/");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const table = () => screen.getByRole("table", { name: t.replaceTitle });

describe("replaceable slots on /extensions", () => {
  it("the single-slot select writes use and shows follows-platform", async () => {
    const calls = api(brand());
    const { client } = await renderRouteWithCache("/extensions", lastStubRoutes(), {
      me: as("admin"),
    });
    client.setQueryData(keys.org("o1").clientExtensions(), {
      enabled: true,
      apiVersion: 1,
      items: [],
    });
    const row = within(await screen.findByRole("table", { name: t.replaceTitle })).getByRole(
      "row",
      {
        name: /Sidebar brand/,
      },
    );
    expect(within(row).getByText(t.followsPlatform)).toBeTruthy();
    // following the platform: nothing to reset
    expect(within(row).queryByRole("button", { name: /^Reset/ })).toBeNull();
    // the slot with no candidates and no pick is not listed
    expect(within(table()).queryByText(t.slots.conversationEmpty)).toBeNull();
    const select = within(row).getByRole("combobox", { name: "Use for Sidebar brand" });
    expect(await optionLabels(select)).toEqual([t.builtin, "Neon brand"]);
    await pickOption(select, "Neon brand", userEvent.setup());
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(bodyOf(calls.find((c) => c.method === "PATCH"))).toEqual({
      uiArrangement: { "shell.brand": { use: "theme-neon/brand" } },
    });
    // the change refreshes the listing and the client code the pages load
    await waitFor(() => expect(calls.some((c) => c.url === `${BASE}/ui/arrangement`)).toBe(true));
    expect(client.getQueryState(keys.org("o1").clientExtensions())?.isInvalidated).toBe(true);
    expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
  });

  it("an org's 内置 is its own pick (use: null); 跟随平台 removes the entry", async () => {
    const calls = api(brand({ use: "theme-neon/brand", followsPlatform: false }));
    await renderRouteWithCache("/extensions", lastStubRoutes(), { me: as("admin") });
    const user = userEvent.setup();
    const row = within(await screen.findByRole("table", { name: t.replaceTitle })).getByRole(
      "row",
      {
        name: /Sidebar brand/,
      },
    );
    expect(within(row).getByText(t.orgOwn)).toBeTruthy();
    await pickOption(within(row).getByRole("combobox"), t.builtin, user);
    await waitFor(() => expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(1));
    expect(bodyOf(calls.find((c) => c.method === "PATCH"))).toEqual({
      uiArrangement: { "shell.brand": { use: null } },
    });
    await user.click(within(row).getByRole("button", { name: "Reset Sidebar brand" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(2));
    expect(bodyOf(calls.filter((c) => c.method === "PATCH")[1])).toEqual({
      uiArrangement: { "shell.brand": null },
    });
  });

  it("a stored pick that is no candidate any more shows as not available", async () => {
    api(brand({ use: "gone/brand", followsPlatform: false }));
    await renderRouteWithCache("/extensions", lastStubRoutes(), { me: as("admin") });
    const row = within(await screen.findByRole("table", { name: t.replaceTitle })).getByRole(
      "row",
      {
        name: /Sidebar brand/,
      },
    );
    expect(within(row).getByRole("combobox").textContent).toContain("gone/brand (not available)");
  });

  it("members see read-only picks (zh)", async () => {
    const calls = api(brand({ use: "theme-neon/brand" }));
    await renderRouteWithCache("/extensions", lastStubRoutes(), {
      locale: "zh",
      me: as("member"),
    });
    const z = zh.uiArrangement;
    const row = within(await screen.findByRole("table", { name: z.replaceTitle })).getByRole(
      "row",
      {
        name: /侧边栏品牌/,
      },
    );
    expect(within(row).getByText("霓虹品牌")).toBeTruthy();
    expect(within(row).getByText(z.followsPlatform)).toBeTruthy();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("button", { name: /^重置/ })).toBeNull();
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
  });
});

describe("replaceable slots on /admin/settings", () => {
  it("the super admin's pick is the platform default; 内置 removes it", async () => {
    const calls = stubApi({
      "GET /api/v1/admin/settings": () =>
        json(200, {
          orgCreation: "anyone",
          runConcurrencyOverrides: {},
          priceCurrency: "USD",
          sandboxLimitOverrides: {},
          customConnectors: "allow",
          customSkills: "allow",
        }),
      "GET /api/v1/admin/components?kind=theme": () => json(200, { components: [] }),
      "GET /api/v1/admin/extensions": () => json(200, { extensions: [], drainSeconds: 30 }),
      "GET /api/v1/admin/ui/arrangement": () =>
        json(200, { slots: [brand({ use: "theme-neon/brand", followsPlatform: false })] }),
      "GET /api/v1/admin/ui/contributions": () => json(200, { items: [] }),
      "PUT /api/v1/admin/settings": () => json(200, {}),
    });
    resetNavigation("/admin/settings");
    const { client } = await renderRouteWithCache("/admin/settings", lastStubRoutes());
    client.setQueryData(keys.org("o1").clientExtensions(), {
      enabled: true,
      apiVersion: 1,
      items: [],
    });
    const row = within(await screen.findByRole("table", { name: t.replaceTitle })).getByRole(
      "row",
      {
        name: /Sidebar brand/,
      },
    );
    // the platform follows nobody: no source column, no reset
    expect(within(row).queryByText(t.followsPlatform)).toBeNull();
    expect(within(row).queryByRole("button")).toBeNull();
    await pickOption(within(row).getByRole("combobox"), t.builtin, userEvent.setup());
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(bodyOf(calls.find((c) => c.method === "PUT"))).toEqual({
      uiArrangement: { "shell.brand": null },
    });
    // the platform default changes what every org loads
    await waitFor(() =>
      expect(client.getQueryState(keys.org("o1").clientExtensions())?.isInvalidated).toBe(true),
    );
    expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
  });
});
