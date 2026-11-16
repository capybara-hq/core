// `/settings/audit`: the org's audit log (org admins, SettingsPage), newest first, 加载更多 by
// cursor; members get no access and read nothing; the org settings nav lists it for admins.
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { APP_PAGES } from "../src/components/shell/path";
import { AUDIT_ACTION_KEYS } from "../src/lib/audit-actions";
import { json, lastStubRoutes, stubApi } from "./support/api";
import { resetNavigation } from "./support/navigation";
import { renderRouteWithCache } from "./support/query";
import { ME } from "./support/render";
import { expectNoFirstPaintFetch } from "./support/server";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));

const O = "/api/v1/orgs/o1";
const T = "2026-11-10T08:00:00.000Z";
const as = (role: string) => ({
  ...ME,
  account: { ...ME.account, isSuperAdmin: false },
  memberships: [{ orgId: "o1", slug: "acme", name: "Acme", role }],
});
const template = (name: string) => document.querySelector(`[data-template="${name}"]`);
const event = (id: string, action: string, actor: string | null, viaAgent = false) => ({
  id,
  at: T,
  actor: actor === null ? null : { id: `a-${actor}`, name: actor, email: null },
  viaToken: false,
  viaAgent,
  action,
  target: `target-${id}`,
});
const FIRST = {
  events: [event("9", "org.settings_updated", "Grant", true), event("8", "org.created", null)],
  next: "8",
};
const SECOND = { events: [event("7", "extension.enabled", "Alice")], next: null };

beforeEach(() => resetNavigation("/settings/audit"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("/settings/audit (org admins)", () => {
  it("lists the org's events from the hydrated cache, and 加载更多 appends the next page", async () => {
    const A = zh.admin.audit;
    const routes = {
      [`GET ${O}/audit?limit=20`]: () => json(200, FIRST),
      [`GET ${O}/audit?limit=20&after=8`]: () => json(200, SECOND),
    };
    const browser = expectNoFirstPaintFetch();
    await renderRouteWithCache("/settings/audit", routes, { locale: "zh", me: as("admin") });
    expect(template("SettingsPage")).not.toBeNull();
    const table = screen.getByRole("table", { name: zh.orgAudit.title });
    // org actions are labeled; the agent flag under the actor
    expect(within(table).getByText(A.actions.orgSettingsUpdated)).toBeTruthy();
    expect(within(table).queryByText("org.settings_updated")).toBeNull();
    expect(within(table).getByText(A.viaAgent)).toBeTruthy();
    expect(within(table).getByText(A.system)).toBeTruthy();
    expect(browser).toEqual([]);
    // the nav marks 审计日志
    expect(screen.getByRole("link", { name: zh.connections.nav.audit })).toBeTruthy();
    const calls = stubApi(routes);
    await userEvent.setup().click(screen.getByRole("button", { name: zh.orgAudit.loadMore }));
    expect(await within(table).findByText("Alice")).toBeTruthy();
    expect(within(table).getByText(A.actions.extensionEnabled)).toBeTruthy();
    expect(within(table).getByText("Grant")).toBeTruthy();
    expect(screen.queryByRole("button", { name: zh.orgAudit.loadMore })).toBeNull();
    expect(calls.map((c) => c.url)).toContain(`${O}/audit?limit=20&after=8`);
  });

  it("an empty log is the table's empty state", async () => {
    stubApi({ [`GET ${O}/audit`]: () => json(200, { events: [], next: null }) });
    await renderRouteWithCache("/settings/audit", lastStubRoutes(), { locale: "en" });
    expect(await screen.findByText(en.orgAudit.empty)).toBeTruthy();
    expect(screen.queryByRole("button", { name: en.orgAudit.loadMore })).toBeNull();
  });

  it("a member gets no access and reads no audit page", async () => {
    const calls = stubApi({});
    await renderRouteWithCache("/settings/audit", lastStubRoutes(), {
      locale: "zh",
      me: as("member"),
    });
    expect(template("StatusPage")?.getAttribute("data-kind")).toBe("no-access");
    expect(calls.map((c) => c.url).some((u) => u.includes("/audit"))).toBe(false);
  });

  it("an unknown action is shown as written", async () => {
    stubApi({
      [`GET ${O}/audit`]: () =>
        json(200, { events: [event("1", "org.future_thing", "Grant")], next: null }),
    });
    await renderRouteWithCache("/settings/audit", lastStubRoutes(), { locale: "zh" });
    expect(await screen.findByText("org.future_thing")).toBeTruthy();
  });

  it("every labeled action has zh and en copy", () => {
    for (const key of Object.values(AUDIT_ACTION_KEYS)) {
      expect(zh.admin.audit.actions, key).toHaveProperty(key);
      expect(en.admin.audit.actions, key).toHaveProperty(key);
    }
  });

  it("is a known app page", () => {
    expect(APP_PAGES).toContain("/settings/audit");
  });
});
