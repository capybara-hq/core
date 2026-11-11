import { describeNestedBox, findNestedBoxes } from "@capybara-hq/design/reference";
import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { useAdminNav } from "../src/components/admin-nav";
import type { Me } from "../src/lib/session";
import type { UiContributionItem } from "../src/lib/ui";
import { json, lastStubRoutes, stubApi } from "./support/api";
import { FakeEventSource } from "./support/conversation";
import { resetNavigation } from "./support/navigation";
import { renderRouteWithCache } from "./support/query";
import { ME, renderPage } from "./support/render";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

const ADMIN = "/api/v1/admin";
const home: UiContributionItem = {
  plugin: "fake-tools-ui",
  id: "platform-home",
  title: { zh: "平台首页", en: "Platform home" },
  slot: "platform.page",
  kind: "view",
  icon: "puzzle",
};
const NOT_SUPER: Me = { ...ME, account: { ...ME.account, isSuperAdmin: false } };

beforeEach(() => {
  resetNavigation("/admin");
  window.history.replaceState(null, "", "/");
  vi.stubGlobal("EventSource", FakeEventSource);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  FakeEventSource.instances = [];
});

function Nav() {
  const groups = useAdminNav();
  return (
    <pre data-testid="nav">{JSON.stringify(groups.map((g) => [g.group, g.items.length]))}</pre>
  );
}
function NavItems() {
  const groups = useAdminNav();
  return (
    <pre data-testid="items">
      {JSON.stringify(groups.at(-1)?.items.map((i) => [i.label, i.href]))}
    </pre>
  );
}

describe("the admin nav", () => {
  it("the admin nav lists platform pages under 扩展", async () => {
    stubApi({ [`GET ${ADMIN}/ui/contributions`]: () => json(200, { items: [home] }) });
    renderPage(<NavItems />, { locale: "zh" });
    await waitFor(() =>
      expect(JSON.parse(screen.getByTestId("items").textContent ?? "null")).toEqual([
        ["平台首页", "/admin/p/fake-tools-ui/platform-home"],
      ]),
    );
    cleanup();
    renderPage(<Nav />, { locale: "zh" });
    await waitFor(() =>
      expect(JSON.parse(screen.getByTestId("nav").textContent ?? "[]").at(-1)).toEqual([
        zh.admin.nav.extensionPages,
        1,
      ]),
    );
    expect(zh.admin.nav.extensionPages).toBe("扩展");
  });

  it("no platform pages, no group", async () => {
    const calls = stubApi({ [`GET ${ADMIN}/ui/contributions`]: () => json(200, { items: [] }) });
    renderPage(<Nav />, { locale: "zh" });
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/ui/contributions"))).toBe(true));
    await waitFor(() =>
      expect(JSON.parse(screen.getByTestId("nav").textContent ?? "[]")).toEqual([
        [zh.admin.nav.group, 13],
      ]),
    );
  });
});

describe("/admin/p/[plugin]/[id]", () => {
  function pageApi() {
    return stubApi({
      [`GET ${ADMIN}/ui/contributions`]: () => json(200, { items: [home] }),
      [`GET ${ADMIN}/ui/views/fake-tools-ui/platform-home`]: () =>
        json(200, { view: { blocks: [{ type: "heading", text: "Platform home" }] } }),
    });
  }

  it("a super admin sees the view, read from the platform routes", async () => {
    const calls = pageApi();
    resetNavigation("/admin/p/fake-tools-ui/platform-home");
    await renderRouteWithCache("/admin/p/fake-tools-ui/platform-home", lastStubRoutes());
    // the page title, then the view's own heading
    expect(await screen.findAllByRole("heading", { name: "Platform home" })).toHaveLength(2);
    expect(document.querySelector('[data-template="DetailPage"]')).not.toBeNull();
    expect(calls.some((c) => c.url.includes("/api/v1/orgs/"))).toBe(false);
    expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
  });

  it("a person who is not a super admin gets the no-access state and no platform read", async () => {
    const calls = pageApi();
    resetNavigation("/admin/p/fake-tools-ui/platform-home");
    await renderRouteWithCache("/admin/p/fake-tools-ui/platform-home", lastStubRoutes(), {
      me: NOT_SUPER,
    });
    await waitFor(() =>
      expect(
        document.querySelector('[data-template="StatusPage"]')?.getAttribute("data-kind"),
      ).toBe("no-access"),
    );
    expect(screen.getByText(en.roles.noAccess.askSuperAdmin)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Platform home" })).toBeNull();
    expect(calls.some((c) => c.url.includes("/api/v1/admin/"))).toBe(false);
  });

  /** The platform arrangement listing with `home` hidden (hidden means not listed). */
  const hiddenHome = () =>
    json(200, {
      slots: [{ slot: "platform.page", source: "platform", items: [{ ...home, hidden: true }] }],
    });

  it("an unknown page says so", async () => {
    stubApi({
      [`GET ${ADMIN}/ui/contributions`]: () => json(200, { items: [] }),
      [`GET ${ADMIN}/ui/arrangement`]: hiddenHome,
    });
    resetNavigation("/admin/p/fake-tools-ui/nope");
    await renderRouteWithCache("/admin/p/fake-tools-ui/nope", lastStubRoutes());
    expect(await screen.findByText(en.errors.ui.not_found)).toBeTruthy();
  });

  it("a page the platform arrangement hides still renders by its direct link", async () => {
    const calls = stubApi({
      [`GET ${ADMIN}/ui/contributions`]: () => json(200, { items: [] }),
      [`GET ${ADMIN}/ui/arrangement`]: hiddenHome,
      [`GET ${ADMIN}/ui/views/fake-tools-ui/platform-home`]: () =>
        json(200, { view: { blocks: [{ type: "heading", text: "Platform home" }] } }),
    });
    resetNavigation("/admin/p/fake-tools-ui/platform-home");
    await renderRouteWithCache("/admin/p/fake-tools-ui/platform-home", lastStubRoutes(), {
      locale: "en",
    });
    // the page title, then the view's own heading (read in the browser: not prefetched)
    await waitFor(() =>
      expect(screen.getAllByRole("heading", { name: "Platform home" })).toHaveLength(2),
    );
    expect(screen.queryByText(en.errors.ui.not_found)).toBeNull();
    expect(calls.some((c) => c.url.includes("/api/v1/orgs/"))).toBe(false);
  });

  it("a listed page does not read the arrangement", async () => {
    const calls = pageApi();
    resetNavigation("/admin/p/fake-tools-ui/platform-home");
    const { calls: server } = await renderRouteWithCache(
      "/admin/p/fake-tools-ui/platform-home",
      lastStubRoutes(),
    );
    expect(await screen.findAllByRole("heading", { name: "Platform home" })).toHaveLength(2);
    expect([...server, ...calls].some((c) => c.url.endsWith("/ui/arrangement"))).toBe(false);
  });

  it("a 404 on the arrangement read is final: the designed not-found, read once", async () => {
    const calls = stubApi({
      [`GET ${ADMIN}/ui/contributions`]: () => json(200, { items: [] }),
      [`GET ${ADMIN}/ui/arrangement`]: () =>
        json(404, { error: { code: "not_found", message: "no" } }),
    });
    resetNavigation("/admin/p/fake-tools-ui/platform-home");
    const { calls: server } = await renderRouteWithCache(
      "/admin/p/fake-tools-ui/platform-home",
      lastStubRoutes(),
      { locale: "en" },
    );
    await waitFor(() =>
      expect(
        document.querySelector('[data-template="StatusPage"]')?.getAttribute("data-kind"),
      ).toBe("404"),
    );
    expect(screen.queryByText(en.errors.ui.not_found)).toBeNull();
    await new Promise((r) => setTimeout(r, 50));
    const reads = [...server, ...calls].filter((c) => c.url.endsWith("/ui/arrangement"));
    expect(reads).toHaveLength(1);
  });
});

describe("未生效的界面 on the extension detail", () => {
  const SHA = "a".repeat(64);
  const ext = (uiDropped: unknown[]) => ({
    name: "demo",
    version: "1.0.0",
    source: "install",
    sha256: SHA,
    status: "enabled",
    desired: { version: "1.0.0", sha256: SHA, state: "enabled" },
    replicas: [],
    permissions: [],
    added: [],
    addedItems: [],
    warnings: [],
    removed: [],
    reviewHash: "0123456789abcdef",
    sensitive: false,
    snapshot: null,
    configurable: false,
    configValid: true,
    removable: true,
    required: false,
    installSource: "file",
    uiDropped,
  });
  function detail(uiDropped: unknown[]) {
    stubApi({
      [`GET ${ADMIN}/extensions`]: () =>
        json(200, { extensions: [ext(uiDropped)], drainSeconds: 30 }),
      [`GET ${ADMIN}/extensions/demo/config`]: () =>
        json(200, {
          plugin: "demo",
          version: "1.0.0",
          configurable: false,
          schema: null,
          fields: [],
          valid: true,
          validated: true,
          issues: [],
        }),
    });
    return renderRouteWithCache("/admin/extensions/demo", lastStubRoutes(), { locale: "zh" });
  }

  it("未生效的界面 lists dropped contributions with their reason", async () => {
    resetNavigation("/admin/extensions/demo");
    await detail([
      { id: "a-page", ref: "nowhere.page@1", reason: "unknown-slot" },
      { id: "b-panel", ref: "conversation.panel@9", reason: "unsupported-version" },
    ]);
    expect(await screen.findByText("未生效的界面")).toBeTruthy();
    const table = screen.getByRole("table", { name: "未生效的界面" });
    const rows = [...table.querySelectorAll("tbody tr")].map((r) =>
      [...r.querySelectorAll("td")].map((c) => c.textContent),
    );
    expect(rows).toEqual([
      ["a-page", "nowhere.page@1", "插槽不存在"],
      ["b-panel", "conversation.panel@9", "插槽版本不受支持"],
    ]);
    expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
  });

  it("no dropped contributions, no section", async () => {
    resetNavigation("/admin/extensions/demo");
    await detail([]);
    await screen.findAllByText("v1.0.0", { exact: false });
    expect(screen.queryByText("未生效的界面")).toBeNull();
  });
});
