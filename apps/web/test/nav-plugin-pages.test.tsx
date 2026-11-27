import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import zh from "../messages/zh.json";
import { type NavLevel, pageSections, useDrawerNav } from "../src/components/shell/nav";
import type { UiContributionItem } from "../src/lib/ui";
import { bodyOf, type Call, json, lastStubRoutes, stubApi } from "./support/api";
import { resetNavigation } from "./support/navigation";
import { renderRouteWithCache } from "./support/query";
import { ME } from "./support/render";
import { renderFrame, shellOf } from "./support/shell";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));

/**
 * Plugin pages in the primary navigation (plugin full pages spec §9): a contribution's `nav`
 * suggestion applies until an org admin saves a choice; at most 3 in primary; the compact drawer
 * shows the same split; only org admins edit it.
 */

const page = (id: string, title: string, nav?: "primary" | "more"): UiContributionItem => ({
  plugin: "acme",
  id,
  title: { zh: title, en: title },
  slot: "org.page",
  kind: "view",
  icon: "puzzle",
  compact: "kept",
  ...(nav !== undefined ? { nav } : {}),
});

const BOARD: UiContributionItem = { ...page("board", "看板", "primary"), icon: "users" };
const PLAIN = page("plain", "清单");

const settingsBody = (navigation?: unknown) => ({
  settings: {
    toolSearch: "on",
    locale: "zh",
    platformTool: "on",
    ...(navigation ? { navigation } : {}),
  },
  deployment: {},
  effectiveNetwork: { mode: "open", hosts: [] },
});

beforeEach(() => {
  resetNavigation("/");
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const mainNav = () => screen.getByRole("navigation", { name: "主导航" });

describe("the sidebar's plugin pages", () => {
  it("a suggested primary page appears in the primary navigation, not under 更多", async () => {
    stubApi({ "GET /api/v1/orgs/o1/settings": () => json(200, settingsBody()) });
    renderFrame(shellOf(ME, { extensions: [BOARD, PLAIN] }));
    const board = within(mainNav()).getByRole("link", { name: "看板" });
    expect(board.getAttribute("href")).toBe("/p/acme/board");
    // the contribution's own icon (`users` is the design's `user`), not the fixed extension icon
    expect(board.querySelector('[data-part="icon"]')?.getAttribute("data-icon")).toBe("user");
    await userEvent.setup().click(within(mainNav()).getByRole("button", { name: "更多" }));
    const menu = await screen.findByRole("menu", { name: "更多" });
    expect(within(menu).queryByRole("menuitem", { name: "看板" })).toBeNull();
    expect(within(menu).getByRole("menuitem", { name: "清单" })).toBeTruthy();
  });

  it("an admin's choice wins: moved to more, and a page promoted to primary", async () => {
    stubApi({
      "GET /api/v1/orgs/o1/settings": () =>
        json(
          200,
          settingsBody({
            pluginPages: [
              { contribution: "acme/board", section: "more" },
              { contribution: "acme/plain", section: "primary" },
            ],
          }),
        ),
    });
    renderFrame(shellOf(ME, { extensions: [BOARD, PLAIN] }));
    await waitFor(() => expect(within(mainNav()).getByRole("link", { name: "清单" })).toBeTruthy());
    expect(within(mainNav()).queryByRole("link", { name: "看板" })).toBeNull();
    await userEvent.setup().click(within(mainNav()).getByRole("button", { name: "更多" }));
    const menu = await screen.findByRole("menu", { name: "更多" });
    expect(within(menu).getByRole("menuitem", { name: "看板" })).toBeTruthy();
  });

  it("at most 3 pages are primary: later ones fall back to more", () => {
    const pages = ["a", "b", "c", "d"].map((id) => page(id, id, "primary"));
    expect(pageSections(pages, undefined)).toEqual(["primary", "primary", "primary", "more"]);
    // a saved primary keeps its slot against earlier suggestions
    expect(
      pageSections(pages, { pluginPages: [{ contribution: "acme/d", section: "primary" }] }),
    ).toEqual(["primary", "primary", "more", "primary"]);
    // a saved choice for the first moves the fourth up
    expect(
      pageSections(pages, { pluginPages: [{ contribution: "acme/a", section: "more" }] }),
    ).toEqual(["more", "primary", "primary", "primary"]);
  });
});

describe("the compact drawer", () => {
  function drawer(level: NavLevel, extensions: Parameters<typeof useDrawerNav>[2]) {
    function Probe() {
      return (
        <pre data-testid="drawer">{JSON.stringify(useDrawerNav(level, undefined, extensions))}</pre>
      );
    }
    render(
      <NextIntlClientProvider locale="zh" messages={zh}>
        <Probe />
      </NextIntlClientProvider>,
    );
    const out = JSON.parse(screen.getByTestId("drawer").textContent ?? "{}");
    cleanup();
    return out as ReturnType<typeof useDrawerNav>;
  }

  it("shows the same split: primary pages on the first level, the rest under more", () => {
    const item = (
      id: string,
      section: "primary" | "more",
      compact: "kept" | "hidden" = "kept",
    ) => ({
      id: `acme/${id}`,
      label: id,
      href: `/p/acme/${id}`,
      compact,
      section,
      icon: "user" as const,
    });
    const d = drawer("member", [
      item("board", "primary"),
      item("plain", "more"),
      item("wide", "primary", "hidden"),
    ]);
    expect(d.primaryExtensions?.map((x) => x.href)).toEqual(["/p/acme/board"]);
    // a primary entry carries its own icon; the More group keeps the extension icon
    expect(d.primaryExtensions?.map((x) => x.icon)).toEqual(["user"]);
    expect(d.more.find((m) => m.href === "/p/acme/plain")?.icon).toBe("extension");
    expect(d.more.map((m) => m.href)).toEqual([
      "/skills",
      "/connectors",
      "/devices",
      "/p/acme/plain",
    ]);
  });
});

describe("/settings/navigation", () => {
  const routes = (navigation?: unknown) => ({
    "GET /api/v1/orgs/o1/settings": () => json(200, settingsBody(navigation)),
    "GET /api/v1/orgs/o1/ui/contributions": () =>
      json(200, {
        items: [
          page("a", "页面甲", "primary"),
          page("b", "页面乙", "primary"),
          page("c", "页面丙", "primary"),
          page("d", "页面丁"),
        ],
      }),
    "PATCH /api/v1/orgs/o1/settings": (c: Call) =>
      json(200, settingsBody((bodyOf(c) as { navigation: unknown }).navigation)),
  });

  const choose = async (field: string, option: string) => {
    const user = userEvent.setup();
    await user.click(await screen.findByRole("combobox", { name: new RegExp(field) }));
    await user.click(await screen.findByRole("option", { name: option }));
  };

  it("an admin moves a page to more and saves only the changed choice", async () => {
    resetNavigation("/settings/navigation");
    const calls = stubApi(routes());
    await renderRouteWithCache("/settings/navigation", lastStubRoutes(), { locale: "zh" });
    await choose("页面乙", "更多");
    await userEvent.setup().click(await screen.findByRole("button", { name: "保存" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(bodyOf(calls.find((c) => c.method === "PATCH"))).toEqual({
      navigation: { pluginPages: [{ contribution: "acme/b", section: "more" }] },
    });
  });

  it("saving drops a saved choice for a page no longer listed", async () => {
    resetNavigation("/settings/navigation");
    const calls = stubApi(
      routes({
        pluginPages: [
          { contribution: "gone/page", section: "primary" },
          { contribution: "acme/a", section: "more" },
        ],
      }),
    );
    await renderRouteWithCache("/settings/navigation", lastStubRoutes(), { locale: "zh" });
    await choose("页面乙", "更多");
    await userEvent.setup().click(await screen.findByRole("button", { name: "保存" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(bodyOf(calls.find((c) => c.method === "PATCH"))).toEqual({
      navigation: {
        pluginPages: [
          { contribution: "acme/a", section: "more" },
          { contribution: "acme/b", section: "more" },
        ],
      },
    });
  });

  it("an org whose four pages all suggest primary opens with three primary and no errors", async () => {
    resetNavigation("/settings/navigation");
    stubApi({
      ...routes(),
      "GET /api/v1/orgs/o1/ui/contributions": () =>
        json(200, {
          items: [
            page("a", "页面甲", "primary"),
            page("b", "页面乙", "primary"),
            page("c", "页面丙", "primary"),
            page("d", "页面丁", "primary"),
          ],
        }),
    });
    await renderRouteWithCache("/settings/navigation", lastStubRoutes(), { locale: "zh" });
    const boxes = await screen.findAllByRole("combobox");
    expect(boxes).toHaveLength(4);
    // what the sidebar shows: the first three suggestions fill the primary slots
    expect(boxes.map((b) => (b as HTMLSelectElement).value)).toEqual([
      "primary",
      "primary",
      "primary",
      "more",
    ]);
    expect(screen.queryByText(zh.navSettings.limit)).toBeNull();
    expect(screen.queryByRole("button", { name: "保存" })).toBeNull();
  });

  it("a suggestion gives way to a changed primary, which is all the save writes", async () => {
    resetNavigation("/settings/navigation");
    const calls = stubApi(routes());
    await renderRouteWithCache("/settings/navigation", lastStubRoutes(), { locale: "zh" });
    await choose("页面丁", "主导航");
    const boxes = await screen.findAllByRole("combobox");
    expect(boxes.map((b) => (b as HTMLSelectElement).value)).toEqual([
      "primary",
      "primary",
      "more",
      "primary",
    ]);
    expect(screen.queryByText(zh.navSettings.limit)).toBeNull();
    await userEvent.setup().click(await screen.findByRole("button", { name: "保存" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(bodyOf(calls.find((c) => c.method === "PATCH"))).toEqual({
      navigation: { pluginPages: [{ contribution: "acme/d", section: "primary" }] },
    });
  });

  it("a select moved back to the value it showed is no change", async () => {
    resetNavigation("/settings/navigation");
    stubApi(routes());
    await renderRouteWithCache("/settings/navigation", lastStubRoutes(), { locale: "zh" });
    const values = async () =>
      (await screen.findAllByRole("combobox")).map((b) => (b as HTMLSelectElement).value);
    await choose("页面丁", "主导航");
    expect(await values()).toEqual(["primary", "primary", "more", "primary"]);
    await choose("页面丁", "更多");
    // the suggestion takes its slot again, nothing to save, no limit counted
    expect(await values()).toEqual(["primary", "primary", "primary", "more"]);
    expect(screen.queryByRole("button", { name: "保存" })).toBeNull();
    // a suggested primary moved away and back stays a suggestion, not a saved choice
    await choose("页面甲", "更多");
    await choose("页面甲", "主导航");
    expect(await values()).toEqual(["primary", "primary", "primary", "more"]);
    expect(screen.queryByText(zh.navSettings.limit)).toBeNull();
    expect(screen.queryByRole("button", { name: "保存" })).toBeNull();
  });

  it("an org without plugin pages shows the empty state with its hint", async () => {
    resetNavigation("/settings/navigation");
    stubApi({
      ...routes(),
      "GET /api/v1/orgs/o1/ui/contributions": () => json(200, { items: [] }),
    });
    await renderRouteWithCache("/settings/navigation", lastStubRoutes(), { locale: "zh" });
    expect(await screen.findByText(zh.navSettings.empty)).toBeTruthy();
    expect(screen.getByText(zh.navSettings.emptyHint)).toBeTruthy();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("a fourth saved or changed primary page is refused before saving", async () => {
    resetNavigation("/settings/navigation");
    const calls = stubApi(
      routes({
        pluginPages: [
          { contribution: "acme/a", section: "primary" },
          { contribution: "acme/b", section: "primary" },
          { contribution: "acme/c", section: "primary" },
        ],
      }),
    );
    await renderRouteWithCache("/settings/navigation", lastStubRoutes(), { locale: "zh" });
    await choose("页面丁", "主导航");
    expect((await screen.findAllByText(zh.navSettings.limit)).length).toBeGreaterThan(0);
    const save = (await screen.findByRole("button", { name: "保存" })) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("a member cannot edit navigation settings: no entry, no controls", async () => {
    const member = {
      ...ME,
      account: { ...ME.account, isSuperAdmin: false },
      memberships: [{ orgId: "o1", slug: "acme", name: "Acme", role: "member" as const }],
    };
    resetNavigation("/settings/navigation");
    stubApi(routes());
    await renderRouteWithCache("/settings/navigation", lastStubRoutes(), {
      locale: "zh",
      me: member,
    });
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("button", { name: "保存" })).toBeNull();
  });
});
