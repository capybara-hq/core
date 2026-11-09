import { describeNestedBox, findNestedBoxes } from "@capybara-hq/design/reference";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import type { Me } from "../src/lib/session";
import type { UiArrangementListSlot } from "../src/lib/ui";
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

function api(source: UiArrangementListSlot["source"] = "none") {
  return stubApi({
    [`GET ${BASE}/extensions`]: () => json(200, { extensions: [] }),
    [`GET ${BASE}/file-previewers`]: () => json(200, { items: [] }),
    [`GET ${BASE}/extension-points`]: () => json(200, { points: [] }),
    [`GET ${BASE}/ui/arrangement`]: () => json(200, { slots: [slot(source)] }),
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
  resetNavigation("/extensions");
  window.history.replaceState(null, "", "/");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("界面位置 on /extensions", () => {
  it("a member sees the arrangement read only", async () => {
    const calls = api();
    await renderRouteWithCache("/extensions", lastStubRoutes(), { me: as("member") });
    expect(await screen.findByText(t.title)).toBeTruthy();
    expect(screen.getByText(t.descriptionReadonly)).toBeTruthy();
    expect(screen.getByText("Beta")).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("button", { name: /Move .* up/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Reset/ })).toBeNull();
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
  });

  it("an admin hides a contribution and the PATCH carries only that slot", async () => {
    const calls = api();
    await renderRouteWithCache("/extensions", lastStubRoutes(), { me: as("admin") });
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
    await renderRouteWithCache("/extensions", lastStubRoutes(), { me: as("admin") });
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

  it("the arrangement change refreshes the contribution lists", async () => {
    const calls = api();
    await renderRouteWithCache("/extensions", lastStubRoutes(), { me: as("admin") });
    const user = userEvent.setup();
    // the first paint read nothing in the browser (hydrated): this read is the refetch
    expect(calls.some((c) => c.url === `${BASE}/ui/arrangement`)).toBe(false);
    await user.click(await screen.findByRole("switch", { name: "Hide Beta" }));
    await waitFor(() => expect(calls.some((c) => c.url === `${BASE}/ui/arrangement`)).toBe(true));
  });

  it("跟随平台 shows when the slot follows the platform", async () => {
    api("platform");
    await renderRouteWithCache("/extensions", lastStubRoutes(), {
      locale: "zh",
      me: as("admin"),
    });
    expect(await screen.findByText(zh.uiArrangement.title)).toBeTruthy();
    expect(screen.getByText("跟随平台")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "跟随平台" })).toBeNull();
  });

  it("an org's own arrangement can be reset, which sends null", async () => {
    const calls = api("org");
    await renderRouteWithCache("/extensions", lastStubRoutes(), { me: as("admin") });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Reset Org pages" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(bodyOf(calls.find((c) => c.method === "PATCH"))).toEqual({
      uiArrangement: { "org.page": null },
    });
    expect(within(document.body).queryByText(t.followsPlatform)).toBeNull();
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
