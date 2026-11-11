// `/admin/audit` (spec 2026-11-11-admin-overview-design.md §6.4, decision D2): the platform-level
// audit log, newest first, 加载更多 by cursor, no filters; super admins only; its sidebar entry.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { ADMIN_PAGES } from "../src/components/admin-nav";
import { activeAdminOf, useAdminItems } from "../src/components/shell/nav";
import { APP_PAGES } from "../src/components/shell/path";
import { json, lastStubRoutes, stubApi } from "./support/api";
import { resetNavigation } from "./support/navigation";
import { renderRouteEmptyCache, renderRouteWithCache } from "./support/query";
import { ME } from "./support/render";
import { expectNoFirstPaintFetch } from "./support/server";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));

const T = "2026-11-10T08:00:00.000Z";
const NOT_ADMIN = { ...ME, account: { ...ME.account, isSuperAdmin: false } };
const template = (name: string) => document.querySelector(`[data-template="${name}"]`);
const event = (id: string, action: string, actor: string | null) => ({
  id,
  at: T,
  actor: actor === null ? null : { id: `a-${actor}`, name: actor, email: null },
  viaToken: false,
  viaAgent: false,
  action,
  target: `target-${id}`,
});
const FIRST = {
  events: [
    event("9", "deployment.settings.updated", "Grant"),
    event("8", "marketplace.added", null),
  ],
  next: "8",
};
const SECOND = { events: [event("7", "extension.installed", "Alice")], next: null };

beforeEach(() => resetNavigation("/admin/audit"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("/admin/audit（ListPage）", () => {
  it("lists the events from the hydrated cache, and 加载更多 appends the next page", async () => {
    const A = zh.admin.audit;
    const routes = {
      "GET /api/v1/admin/audit?limit=20": () => json(200, FIRST),
      "GET /api/v1/admin/audit?limit=20&after=8": () => json(200, SECOND),
    };
    const browser = expectNoFirstPaintFetch();
    await renderRouteWithCache("/admin/audit", routes, { locale: "zh" });
    expect(template("ListPage")).not.toBeNull();
    const table = screen.getByRole("table", { name: A.listLabel });
    expect(within(table).getByText(A.actions.deploymentSettingsUpdated)).toBeTruthy();
    expect(within(table).getByText(A.system)).toBeTruthy();
    expect(within(table).getByText("target-9")).toBeTruthy();
    expect(browser).toEqual([]);
    const calls = stubApi(routes);
    await userEvent.setup().click(screen.getByRole("button", { name: A.loadMore }));
    expect(await within(table).findByText("Alice")).toBeTruthy();
    expect(within(table).getByText(A.actions.extensionInstalled)).toBeTruthy();
    // the first rows stay; the last page has no next, so no more button
    expect(within(table).getByText("Grant")).toBeTruthy();
    expect(screen.queryByRole("button", { name: A.loadMore })).toBeNull();
    expect(calls.map((c) => c.url)).toContain("/api/v1/admin/audit?limit=20&after=8");
  });

  it("an empty log is the list's empty state", async () => {
    stubApi({ "GET /api/v1/admin/audit": () => json(200, { events: [], next: null }) });
    await renderRouteWithCache("/admin/audit", lastStubRoutes(), { locale: "en" });
    expect(await screen.findByText(en.admin.audit.empty)).toBeTruthy();
    expect(screen.queryByRole("button", { name: en.admin.audit.loadMore })).toBeNull();
  });

  it("an empty cache shows the template's loading state, then the data", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    await renderRouteEmptyCache("/admin/audit", {
      "GET /api/v1/admin/audit": async () => {
        await gate;
        return json(200, FIRST);
      },
    });
    await vi.waitFor(() => expect(template("ListPage")).not.toBeNull());
    expect(document.querySelector("[aria-busy='true']")).not.toBeNull();
    expect(screen.queryByText("Grant")).toBeNull();
    release();
    expect(await screen.findByText("Grant")).toBeTruthy();
  });

  it("非超级管理员：没有访问权限，不请求后台接口", async () => {
    const calls = stubApi({});
    await renderRouteWithCache("/admin/audit", lastStubRoutes(), { locale: "zh", me: NOT_ADMIN });
    expect(template("StatusPage")?.getAttribute("data-kind")).toBe("no-access");
    expect(calls).toEqual([]);
  });
});

describe("审计日志 in the admin sidebar", () => {
  it("comes right after 收件箱 and is active on /admin/audit", () => {
    function Admin() {
      const items = useAdminItems();
      return (
        <pre data-testid="admin">{JSON.stringify(items.map((i) => [i.id, i.label, i.href]))}</pre>
      );
    }
    render(
      <NextIntlClientProvider locale="zh" messages={zh}>
        <Admin />
      </NextIntlClientProvider>,
    );
    const items = JSON.parse(screen.getByTestId("admin").textContent ?? "[]") as string[][];
    const at = items.findIndex((i) => i[0] === "audit");
    expect(items[at]).toEqual(["audit", zh.admin.nav.audit, "/admin/audit"]);
    expect(items[at - 1]?.[0]).toBe("inbox");
    expect(activeAdminOf("/admin/audit", [...ADMIN_PAGES])).toBe("audit");
    expect(APP_PAGES).toContain("/admin/audit");
  });
});
