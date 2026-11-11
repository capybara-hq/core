import { describeNestedBox, findNestedBoxes } from "@capybara-hq/design/reference";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import type { Me } from "../src/lib/session";
import type { UiArrangementListSlot, UiArrangementSlot } from "../src/lib/ui";
import { bodyOf, json, lastStubRoutes, stubApi } from "./support/api";
import { FakeEventSource } from "./support/conversation";
import { resetNavigation } from "./support/navigation";
import { renderRouteWithCache } from "./support/query";
import { ME } from "./support/render";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));

const BASE = "/api/v1/orgs/o1";
const t = en.uiArrangement;

const item = (plugin: string, id: string, title: string, hidden = false) => ({
  plugin,
  id,
  title: { zh: title, en: title },
  slot: "org.page" as const,
  kind: "view" as const,
  icon: "puzzle" as const,
  hidden,
});

const slot = (source: UiArrangementListSlot["source"]): UiArrangementListSlot => ({
  slot: "org.page",
  source,
  items: [
    item("ext-a", "one", "Alpha"),
    item("ext-b", "two", "Beta"),
    item("ext-c", "three", "Gamma"),
  ],
});

function api(source: UiArrangementListSlot["source"] = "none", extra: UiArrangementSlot[] = []) {
  return stubApi({
    [`GET ${BASE}/themes`]: () =>
      json(200, { themes: [], resolved: null, org: { id: null, personal: "allowed" } }),
    [`GET ${BASE}/components?kind=theme`]: () => json(200, { components: [] }),
    "GET /api/v1/platform/theme": () => json(200, null),
    [`GET ${BASE}/ui/arrangement`]: () => json(200, { slots: [slot(source), ...extra] }),
    [`GET ${BASE}/ui/contributions`]: () => json(200, { items: [] }),
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
  resetNavigation("/settings/appearance");
  window.history.replaceState(null, "", "/");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("界面位置 on /settings/appearance (组织设置 › 外观)", () => {
  it("a member sees the arrangement read only", async () => {
    const calls = api();
    await renderRouteWithCache("/settings/appearance", lastStubRoutes(), { me: as("member") });
    const section = await screen.findByRole("region", { name: t.title });
    expect(within(section).getByText(t.descriptionReadonly)).toBeTruthy();
    expect(within(section).getByText("Beta")).toBeTruthy();
    expect(within(section).queryByRole("switch")).toBeNull();
    expect(within(section).queryByRole("button", { name: /Move .* up/ })).toBeNull();
    expect(within(section).queryByRole("button", { name: /^Reset/ })).toBeNull();
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
  });

  it("an admin hides a contribution and the PATCH carries only that slot", async () => {
    const calls = api();
    await renderRouteWithCache("/settings/appearance", lastStubRoutes(), { me: as("admin") });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("switch", { name: "Hide Beta" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const patch = calls.find((c) => c.method === "PATCH");
    expect(bodyOf(patch)).toEqual({
      uiArrangement: {
        "org.page": {
          hidden: ["ext-b/two"],
          order: ["ext-a/one", "ext-b/two", "ext-c/three"],
        },
      },
    });
    expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
  });

  it("move up sends the new order", async () => {
    const calls = api();
    await renderRouteWithCache("/settings/appearance", lastStubRoutes(), { me: as("admin") });
    const user = userEvent.setup();
    expect(
      (await screen.findByRole("button", { name: "Move Alpha up" })).hasAttribute("disabled"),
    ).toBe(true);
    await user.click(screen.getByRole("button", { name: "Move Gamma up" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(bodyOf(calls.find((c) => c.method === "PATCH"))).toEqual({
      uiArrangement: {
        "org.page": {
          hidden: [],
          order: ["ext-a/one", "ext-c/three", "ext-b/two"],
        },
      },
    });
  });

  it("the first row's up and the last row's down are disabled, the others usable", async () => {
    api();
    await renderRouteWithCache("/settings/appearance", lastStubRoutes(), { me: as("admin") });
    const section = await screen.findByRole("region", { name: t.title });
    const button = (name: string) => within(section).getByRole("button", { name });
    expect(button("Move Alpha up")).toHaveProperty("disabled", true);
    expect(button("Move Alpha down")).toHaveProperty("disabled", false);
    expect(button("Move Beta up")).toHaveProperty("disabled", false);
    expect(button("Move Beta down")).toHaveProperty("disabled", false);
    expect(button("Move Gamma up")).toHaveProperty("disabled", false);
    expect(button("Move Gamma down")).toHaveProperty("disabled", true);
    // disabled buttons are announced as such (and skipped by the tab order)
    expect(
      within(section)
        .getAllByRole("button", { name: /^Move/ })
        .filter((b) => b.matches(":disabled"))
        .map((b) => b.getAttribute("aria-label")),
    ).toEqual(["Move Alpha up", "Move Gamma down"]);
  });

  it("外观 holds the theme first, then 替换, then 界面位置", async () => {
    api("none", [
      {
        slot: "shell.brand",
        candidates: [{ key: "theme-neon/brand", title: { zh: "霓虹品牌", en: "Neon brand" } }],
        use: null,
        followsPlatform: true,
      },
    ]);
    await renderRouteWithCache("/settings/appearance", lastStubRoutes(), { me: as("admin") });
    await screen.findByRole("region", { name: t.title });
    const names = screen
      .getAllByRole("region")
      .map((r) => r.getAttribute("aria-label"))
      .filter((n) => n !== null);
    expect(names).toEqual([
      en.appearance.themes.title,
      en.appearance.org.title,
      t.replaceTitle,
      t.title,
    ]);
  });

  it("the arrangement change refreshes the contribution lists", async () => {
    const calls = api();
    await renderRouteWithCache("/settings/appearance", lastStubRoutes(), { me: as("admin") });
    const user = userEvent.setup();
    // the first paint read nothing in the browser (hydrated): this read is the refetch
    expect(calls.some((c) => c.url === `${BASE}/ui/arrangement`)).toBe(false);
    await user.click(await screen.findByRole("switch", { name: "Hide Beta" }));
    await waitFor(() => expect(calls.some((c) => c.url === `${BASE}/ui/arrangement`)).toBe(true));
  });

  it("跟随平台 shows when the slot follows the platform", async () => {
    api("platform");
    await renderRouteWithCache("/settings/appearance", lastStubRoutes(), {
      locale: "zh",
      me: as("admin"),
    });
    const section = await screen.findByRole("region", { name: zh.uiArrangement.title });
    expect(within(section).getByText(zh.uiArrangement.followsPlatform)).toBeTruthy();
    expect(within(section).queryByRole("button", { name: /^重置/ })).toBeNull();
  });

  it("an org's own arrangement can be reset, which sends null", async () => {
    const calls = api("org");
    await renderRouteWithCache("/settings/appearance", lastStubRoutes(), { me: as("admin") });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Reset Org pages" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(bodyOf(calls.find((c) => c.method === "PATCH"))).toEqual({
      uiArrangement: { "org.page": null },
    });
    expect(within(document.body).queryByText(t.followsPlatform)).toBeNull();
  });
});

describe("/extensions points to 外观", () => {
  function extensionsApi() {
    return stubApi({
      [`GET ${BASE}/extensions`]: () => json(200, { extensions: [] }),
      [`GET ${BASE}/file-previewers`]: () => json(200, { items: [] }),
      [`GET ${BASE}/extension-points`]: () => json(200, { points: [] }),
      [`GET ${BASE}/ui/arrangement`]: () => json(200, { slots: [slot("none")] }),
      [`GET ${BASE}/ui/contributions`]: () => json(200, { items: [] }),
      "GET /api/v1/auth/sources": () => json(200, { sources: [] }),
    });
  }

  for (const role of ["admin", "member"] as const) {
    it(`an org ${role} finds one line with a link to 组织设置 › 外观, not the arrangement`, async () => {
      resetNavigation("/extensions");
      const calls = extensionsApi();
      await renderRouteWithCache("/extensions", lastStubRoutes(), {
        locale: "zh",
        me: as(role),
      });
      const link = await screen.findByRole("link", { name: zh.extensions.arrangementLink });
      expect(link.getAttribute("href")).toBe("/settings/appearance");
      expect(screen.getByText(zh.extensions.arrangementPointer)).toBeTruthy();
      expect(screen.queryByRole("region", { name: zh.uiArrangement.title })).toBeNull();
      expect(screen.queryByRole("table", { name: zh.uiArrangement.replaceTitle })).toBeNull();
      // the page no longer reads the arrangement
      expect(calls.some((c) => c.url === `${BASE}/ui/arrangement`)).toBe(false);
    });
  }

  it("a search hides the pointer", async () => {
    resetNavigation("/extensions");
    extensionsApi();
    await renderRouteWithCache("/extensions", lastStubRoutes(), { me: as("admin") });
    const user = userEvent.setup();
    await screen.findByRole("link", { name: en.extensions.arrangementLink });
    await user.type(screen.getByRole("searchbox"), "x");
    await waitFor(() =>
      expect(screen.queryByRole("link", { name: en.extensions.arrangementLink })).toBeNull(),
    );
  });
});

describe("界面位置 on /admin/settings", () => {
  it("the super admin sets the platform default and the PUT carries only that slot", async () => {
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
        json(200, {
          slots: [
            {
              slot: "platform.page",
              source: "none",
              items: [{ ...item("ext-a", "home", "Home"), slot: "platform.page" }],
            },
          ],
        }),
      "GET /api/v1/admin/ui/contributions": () => json(200, { items: [] }),
      "PUT /api/v1/admin/settings": () => json(200, {}),
    });
    resetNavigation("/admin/settings");
    await renderRouteWithCache("/admin/settings", lastStubRoutes());
    const user = userEvent.setup();
    await user.click(await screen.findByRole("switch", { name: "Hide Home" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(bodyOf(calls.find((c) => c.method === "PUT"))).toEqual({
      uiArrangement: { "platform.page": { hidden: ["ext-a/home"], order: ["ext-a/home"] } },
    });
    expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
  });
});

describe("a hidden org page", () => {
  it("still renders at its direct URL (hidden means not listed)", async () => {
    stubApi({
      [`GET ${BASE}/ui/contributions`]: () => json(200, { items: [] }),
      [`GET ${BASE}/ui/arrangement`]: () =>
        json(200, { slots: [{ ...slot("org"), items: [item("ext-a", "one", "Alpha", true)] }] }),
      [`GET ${BASE}/ui/views/ext-a/one`]: () =>
        json(200, { view: { blocks: [{ type: "heading", text: "Alpha body" }] } }),
    });
    vi.stubGlobal("EventSource", FakeEventSource);
    resetNavigation("/p/ext-a/one");
    await renderRouteWithCache("/p/ext-a/one", lastStubRoutes(), { me: as("member") });
    expect(await screen.findByRole("heading", { name: "Alpha body" })).toBeTruthy();
  });

  it("an unknown page is still not found", async () => {
    stubApi({
      [`GET ${BASE}/ui/contributions`]: () => json(200, { items: [] }),
      [`GET ${BASE}/ui/arrangement`]: () => json(200, { slots: [slot("none")] }),
    });
    vi.stubGlobal("EventSource", FakeEventSource);
    resetNavigation("/p/ext-z/none");
    await renderRouteWithCache("/p/ext-z/none", lastStubRoutes(), { me: as("member") });
    expect(await screen.findByText(en.errors.ui.not_found)).toBeTruthy();
  });
});
