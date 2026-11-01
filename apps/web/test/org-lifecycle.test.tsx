// Role pass item 9: leave an organization, delete it, service tokens.
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import zh from "../messages/zh.json";
import OrganizationSettingsPage from "../src/app/(app)/settings/organization/page";
import TokensPage from "../src/app/(app)/settings/tokens/page";
import type { OrgRole } from "../src/lib/members";
import type { Me } from "../src/lib/session";
import { bodyOf, json, noContent, stubApi } from "./support/api";
import { resetNavigation, router } from "./support/navigation";
import { ME, renderPage } from "./support/render";
import { renderFrame, shellOf } from "./support/shell";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));

const O = "/api/v1/orgs/o1";
const meAs = (role: OrgRole): Me => ({
  ...ME,
  account: { ...ME.account, isEnterpriseAdmin: false },
  memberships: [{ orgId: "o1", slug: "acme", name: "Acme", role }],
});
const member = (id: string, role: OrgRole) => ({
  account: { id, displayName: id, email: null },
  role,
  joinedAt: "2026-10-01T00:00:00Z",
  anonymous: false,
});

beforeEach(() => {
  resetNavigation("/");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("退出组织", () => {
  const api = (members: unknown[] = []) =>
    stubApi({
      [`GET ${O}/members`]: () => json(200, { members }),
      [`POST ${O}/leave`]: () => noContent(),
      "PUT /api/v1/me/current-org": () => noContent(),
      "POST /api/v1/auth/logout": () => noContent(),
    });
  async function openLeave() {
    const user = userEvent.setup();
    screen.getByText("page body");
    await user.click(screen.getByRole("button", { name: /当前组织：Acme/ }));
    await user.click(await screen.findByRole("menuitem", { name: zh.orgLifecycle.leave.action }));
    return screen.findByRole("dialog", { name: zh.orgLifecycle.leave.title });
  }

  for (const role of ["guest", "member", "admin"] as const) {
    it(`${role}: the org menu offers 退出组织…; leaving keeps the sign-in and opens the chooser`, async () => {
      const calls = api();
      const me = meAs(role);
      const view = renderFrame(shellOf(me));
      const dialog = await openLeave();
      expect(within(dialog).getByText(zh.orgLifecycle.leave.description)).toBeTruthy();
      await userEvent
        .setup()
        .click(within(dialog).getByRole("button", { name: zh.orgLifecycle.leave.confirm }));
      // the kernel cleared the current org: the server renders the chooser at /
      await vi.waitFor(() => expect(router.refresh).toHaveBeenCalled());
      expect(router.push).toHaveBeenCalledWith("/");
      expect(calls.some((c) => c.method === "PUT")).toBe(false);
      // the dialog stays pending until the new frame arrives
      expect(
        within(screen.getByRole("dialog", { name: zh.orgLifecycle.leave.title }))
          .getByRole("button", { name: zh.orgLifecycle.leave.confirm })
          .getAttribute("aria-busy"),
      ).toBe("true");
      view.update(shellOf({ ...me, memberships: [], currentOrgId: null }));
      expect(screen.getByRole("heading", { name: zh.orgChooser.titleNone })).toBeTruthy();
      expect(calls.some((c) => c.url === "/api/v1/auth/logout")).toBe(false);
    });
  }

  it("leaving one of two orgs switches to the other", async () => {
    const me: Me = {
      ...meAs("member"),
      memberships: [
        { orgId: "o1", slug: "acme", name: "Acme", role: "member" },
        { orgId: "o2", slug: "beta", name: "Beta", role: "member" },
      ],
    };
    const calls = api();
    const view = renderFrame(shellOf(me));
    const dialog = await openLeave();
    await userEvent
      .setup()
      .click(within(dialog).getByRole("button", { name: zh.orgLifecycle.leave.confirm }));
    await vi.waitFor(() => expect(router.refresh).toHaveBeenCalled());
    const put = calls.find((c) => c.method === "PUT" && c.url === "/api/v1/me/current-org");
    expect(bodyOf(put)).toEqual({ orgId: "o2" });
    expect(calls.some((c) => c.url === "/api/v1/auth/logout")).toBe(false);
    view.update(shellOf({ ...me, memberships: me.memberships.slice(1), currentOrgId: "o2" }));
    expect(screen.getByRole("button", { name: /当前组织：Beta/ })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("the only owner is told to transfer ownership first: no confirm button", async () => {
    api([member("a1", "owner"), member("a2", "member")]);
    renderFrame(shellOf(meAs("owner")));
    const dialog = await openLeave();
    expect(await within(dialog).findByText(zh.orgLifecycle.leave.lastOwner)).toBeTruthy();
    expect(
      within(dialog).queryByRole("button", { name: zh.orgLifecycle.leave.confirm }),
    ).toBeNull();
  });

  it("a failed owner count shows the error, not a bare confirm button", async () => {
    stubApi({
      [`GET ${O}/members`]: () => json(500, { error: { code: "internal", message: "boom" } }),
    });
    renderFrame(shellOf(meAs("owner")));
    const dialog = await openLeave();
    expect(await within(dialog).findByRole("alert")).toBeTruthy();
    expect(
      within(dialog).queryByRole("button", { name: zh.orgLifecycle.leave.confirm }),
    ).toBeNull();
  });

  it("an owner beside another owner may leave", async () => {
    api([member("a1", "owner"), member("a2", "owner")]);
    renderFrame(shellOf(meAs("owner")));
    const dialog = await openLeave();
    expect(
      await within(dialog).findByRole("button", { name: zh.orgLifecycle.leave.confirm }),
    ).toBeTruthy();
  });
});

describe("删除组织 (组织设置 · 通用)", () => {
  const api = () =>
    stubApi({
      [`GET ${O}/settings`]: () => json(200, { settings: { toolSearch: "on", locale: "en" } }),
      [`DELETE ${O}`]: () => noContent(),
    });
  for (const role of ["member", "admin", "owner"] as const) {
    const owner = role === "owner";
    it(`${role}: the danger zone is ${owner ? "shown" : "absent"}`, async () => {
      api();
      resetNavigation("/settings/organization");
      renderPage(<OrganizationSettingsPage />, { locale: "zh", me: meAs(role) });
      await screen.findByText(zh.orgSettings.toolSearch.title, { selector: "h2" });
      expect(screen.queryByRole("region", { name: zh.orgLifecycle.danger.title }) !== null).toBe(
        owner,
      );
    });
  }

  it("the owner types the slug to delete; then the org chooser (no current org)", async () => {
    const calls = api();
    const switchOrg = vi.fn(async () => {});
    renderPage(<OrganizationSettingsPage />, {
      locale: "zh",
      me: meAs("owner"),
      session: { switchOrg },
    });
    const user = userEvent.setup();
    const zone = await screen.findByRole("region", { name: zh.orgLifecycle.danger.title });
    await user.click(within(zone).getByRole("button", { name: zh.orgLifecycle.delete.action }));
    const dialog = await screen.findByRole("dialog", { name: zh.orgLifecycle.delete.title });
    const confirm = within(dialog).getByRole("button", { name: zh.orgLifecycle.delete.confirm });
    expect(confirm).toHaveProperty("disabled", true);
    await user.type(within(dialog).getByRole("textbox"), "acme");
    await user.click(confirm);
    await vi.waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
    await vi.waitFor(() => expect(switchOrg).toHaveBeenCalledWith(null));
    expect(router.replace).toHaveBeenCalledWith("/");
  });
});

describe("删除组织 errors", () => {
  it("a refusal shows the localized message in the dialog, not the kernel's English", async () => {
    stubApi({
      [`GET ${O}/settings`]: () => json(200, { settings: { toolSearch: "on", locale: "en" } }),
      [`DELETE ${O}`]: () =>
        json(403, { error: { code: "forbidden", message: "Insufficient organization role" } }),
    });
    renderPage(<OrganizationSettingsPage />, { locale: "zh", me: meAs("owner") });
    const user = userEvent.setup();
    const zone = await screen.findByRole("region", { name: zh.orgLifecycle.danger.title });
    await user.click(within(zone).getByRole("button", { name: zh.orgLifecycle.delete.action }));
    const dialog = await screen.findByRole("dialog", { name: zh.orgLifecycle.delete.title });
    await user.type(within(dialog).getByRole("textbox"), "acme");
    await user.click(within(dialog).getByRole("button", { name: zh.orgLifecycle.delete.confirm }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).not.toContain("Insufficient organization role");
    expect(alert.textContent).toContain(zh.errors.forbidden);
  });
});

describe("服务令牌", () => {
  const TOKEN = {
    id: "t1",
    kind: "service",
    accountId: null,
    orgId: "o1",
    role: "member",
    name: "ci",
    createdAt: "2026-10-01T00:00:00Z",
    lastUsedAt: null,
    expiresAt: null,
  };
  const api = () =>
    stubApi({
      [`GET ${O}/service-tokens`]: () => json(200, { tokens: [TOKEN] }),
      [`POST ${O}/service-tokens`]: () =>
        json(201, { token: "cap_svc_secret", record: { ...TOKEN, id: "t2", name: "deploy" } }),
      [`DELETE ${O}/service-tokens/t1`]: () => noContent(),
    });

  for (const role of ["guest", "member"] as const) {
    it(`${role}: no access, nothing loaded`, () => {
      const calls = api();
      resetNavigation("/settings/tokens");
      renderPage(<TokensPage />, { locale: "zh", me: meAs(role) });
      expect(
        document.querySelector('[data-template="StatusPage"][data-kind="no-access"]'),
      ).toBeTruthy();
      expect(calls).toEqual([]);
    });
  }

  it("the settings nav lists 服务令牌 for admins only", async () => {
    api();
    resetNavigation("/settings/organization");
    stubApi({
      [`GET ${O}/settings`]: () => json(200, { settings: { toolSearch: "on", locale: "en" } }),
    });
    renderPage(<OrganizationSettingsPage />, { locale: "zh", me: meAs("member") });
    await screen.findByRole("link", { name: zh.connections.nav.general });
    expect(screen.queryByRole("link", { name: zh.connections.nav.tokens })).toBeNull();
    cleanup();
    renderPage(<OrganizationSettingsPage />, { locale: "zh", me: meAs("admin") });
    const link = await screen.findByRole("link", { name: zh.connections.nav.tokens });
    expect(link.getAttribute("href")).toBe("/settings/tokens");
  });

  it("an expired token says 已过期", async () => {
    stubApi({
      [`GET ${O}/service-tokens`]: () =>
        json(200, { tokens: [{ ...TOKEN, expiresAt: "2020-01-01T00:00:00Z" }] }),
    });
    resetNavigation("/settings/tokens");
    renderPage(<TokensPage />, { locale: "zh", me: meAs("admin") });
    const table = await screen.findByRole("table", { name: zh.tokens.title });
    expect(within(table).getByText(zh.tokens.expired)).toBeTruthy();
  });

  for (const role of ["admin", "owner"] as const) {
    it(`${role}: lists, creates (roles up to its own, shown once) and revokes`, async () => {
      const calls = api();
      resetNavigation("/settings/tokens");
      renderPage(<TokensPage />, { locale: "zh", me: meAs(role) });
      const table = await screen.findByRole("table", { name: zh.tokens.title });
      expect(within(table).getByText("ci")).toBeTruthy();
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: zh.tokens.create }));
      const dialog = await screen.findByRole("dialog", { name: zh.tokens.createTitle });
      const roleSelect = within(dialog).getByRole("combobox", { name: zh.tokens.role });
      expect(
        within(roleSelect)
          .getAllByRole("option")
          .map((o) => o.getAttribute("value")),
      ).toEqual(["guest", "member", "admin"]);
      await user.type(within(dialog).getByRole("textbox", { name: zh.tokens.name }), "deploy");
      await user.selectOptions(roleSelect, "admin");
      await user.click(within(dialog).getByRole("button", { name: zh.tokens.createSubmit }));
      const field = (await within(dialog).findByRole("textbox", {
        name: zh.tokens.value,
      })) as HTMLInputElement;
      expect(field.value).toBe("cap_svc_secret");
      expect(bodyOf(calls.find((c) => c.method === "POST"))).toEqual({
        name: "deploy",
        role: "admin",
      });
      await user.click(within(dialog).getByRole("button", { name: zh.tokens.done }));
      // revoke from the row menu, after a confirmation
      await user.click(within(table).getAllByRole("button", { name: /行操作/ })[0] as HTMLElement);
      await user.click(await screen.findByRole("menuitem", { name: zh.tokens.revoke }));
      const confirm = await screen.findByRole("dialog", { name: zh.tokens.revokeTitle });
      await user.click(within(confirm).getByRole("button", { name: zh.tokens.revokeConfirm }));
      await vi.waitFor(() =>
        expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/t1"))).toBe(true),
      );
    });
  }
});
