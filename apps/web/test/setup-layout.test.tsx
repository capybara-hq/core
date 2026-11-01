import { cleanup, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import zh from "../messages/zh.json";
import { setupRouteOf } from "../src/components/shell/setup";
import type { Me } from "../src/lib/session";
import { bodyOf, noContent, stubApi } from "./support/api";
import { resetNavigation, router } from "./support/navigation";
import { ME } from "./support/render";
import { NOT_READY, PROVIDER_ONLY, READY, renderFrame as render, shellOf } from "./support/shell";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));

// Acceptance round 2, D + D2: the guided setup layout. While the current org has no usable model or
// no agent, workspace routes render in the setup layout (the shell's geometry with the setup
// sidebar: no workspace navigation, no conversations); the admin console keeps its own context; the
// checklist differs by role. The frame comes from the layout's props (web-SSR spec §3–§4).

const s = zh.chat.setup;
const sl = zh.setupLayout;

/** The frame for `me` with the org's readiness (not ready by default). */
const renderFrame = (o: { me?: Me; readiness?: typeof READY } = {}) =>
  render(shellOf(o.me ?? ME, { readiness: o.readiness ?? NOT_READY }));

const setupPage = () => document.querySelector('[data-template="SetupPage"]');
const setupSidebar = () => document.querySelector('[data-part="sidebar"][data-context="setup"]');
const workSidebar = () => document.querySelector('[data-part="sidebar"][data-context="work"]');
const step = (label: string) =>
  within(screen.getByRole("main")).getByText(label).closest("li") as HTMLElement;
const memberMe = (role: string, enterprise = false): Me => ({
  ...ME,
  account: { ...ME.account, isEnterpriseAdmin: enterprise },
  memberships: [{ orgId: "o1", slug: "acme", name: "Acme", role }],
});

beforeEach(() => {
  resetNavigation("/");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("setup layout scope", () => {
  it("not ready on /: the setup home in the setup sidebar's frame, with the org and the account", async () => {
    renderFrame();
    expect(screen.getByRole("heading", { level: 1, name: s.title })).toBeTruthy();
    expect(setupPage()).not.toBeNull();
    expect(setupSidebar()).not.toBeNull();
    expect(workSidebar()).toBeNull();
    expect(screen.queryByRole("region", { name: "会话" })).toBeNull();
    expect(screen.queryByText("page body")).toBeNull();
    const org = setupSidebar()?.querySelector('[data-part="org-switcher"]') as HTMLElement;
    expect(org.textContent).toContain("Acme");
    expect(org.textContent).toContain("~/acme");
    // the path line `<slug> / 开始之前`, the description, the checklist
    const path = screen.getByRole("navigation", { name: "路径" });
    expect(path.textContent).toContain("acme");
    expect(screen.getByText(s.description)).toBeTruthy();
    expect(step(zh.home.setup.org).getAttribute("data-state")).toBe("done");
    expect(step(s.model.label).getAttribute("data-state")).toBe("todo");
    // the account menu holds sign-out
    await userEvent.setup().click(screen.getByRole("button", { name: "账户: Grant" }));
    expect(await screen.findByRole("menuitem", { name: zh.common.logout })).toBeTruthy();
    // the status bar prompt
    expect(screen.getByText("Grant@acme:~/setup")).toBeTruthy();
  });

  it("not ready on /chat: the same setup home, never a composer", () => {
    resetNavigation("/chat");
    renderFrame();
    expect(screen.getByRole("heading", { level: 1, name: s.title })).toBeTruthy();
    expect(document.querySelector('[data-template="ConversationPage"]')).toBeNull();
  });

  it("ready: the shell renders, no setup layout", () => {
    renderFrame({ readiness: READY });
    expect(screen.getByText("page body")).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "主导航" })).toBeTruthy();
    expect(setupPage()).toBeNull();
  });

  it("a workspace route that is not a step redirects to / while not ready", async () => {
    resetNavigation("/connectors");
    renderFrame();
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith("/"));
    expect(screen.queryByText("page body")).toBeNull();
    // the setup home meanwhile, never the shell
    expect(setupPage()).not.toBeNull();
  });

  it("a step page (/settings/models) renders inside the setup frame; the sidebar leads back", () => {
    resetNavigation("/settings/models");
    renderFrame();
    expect(screen.getByText("page body")).toBeTruthy();
    expect(setupPage()).not.toBeNull();
    expect(workSidebar()).toBeNull();
    const home = setupSidebar()?.querySelector('[data-part="nav-item"]') as HTMLElement;
    expect(home.textContent).toBe(sl.back);
    expect(home.getAttribute("href")).toBe("/");
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("/admin keeps the admin console context while not ready", () => {
    resetNavigation("/admin/extensions");
    renderFrame();
    expect(screen.getByText("page body")).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "主导航" });
    expect(within(nav).getByRole("link", { name: zh.admin.nav.extensions })).toBeTruthy();
    expect(setupPage()).toBeNull();
  });

  it("the org switch in the setup sidebar works", async () => {
    const me = {
      ...ME,
      memberships: [...ME.memberships, { orgId: "o2", slug: "b", name: "Beta", role: "member" }],
    };
    const calls = stubApi({ "PUT /api/v1/me/current-org": () => noContent() });
    renderFrame({ me });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "当前组织：Acme，切换组织" }));
    await user.click(await screen.findByRole("menuitemradio", { name: "Beta" }));
    await vi.waitFor(() =>
      expect(bodyOf(calls.find((c) => c.method === "PUT"))).toEqual({ orgId: "o2" }),
    );
    await vi.waitFor(() => expect(router.refresh).toHaveBeenCalled());
  });

  it("routes: home, steps, redirects and the admin console", () => {
    expect(setupRouteOf("/")).toBe("home");
    expect(setupRouteOf("/chat")).toBe("home");
    for (const p of [
      "/settings/models",
      "/settings/members",
      "/agents/new",
      "/agents/a1",
      "/channels/new",
      "/catalog",
      "/catalog/x",
      "/catalog/x/install",
      "/account/connections",
    ])
      expect(setupRouteOf(p), p).toBe("step");
    for (const p of ["/agents", "/connectors", "/skills", "/chat/c1", "/settings/organization"])
      expect(setupRouteOf(p), p).toBe("redirect");
    expect(setupRouteOf("/admin")).toBe("outside");
    expect(setupRouteOf("/admin/extensions")).toBe("outside");
  });
});

describe("the checklist by role", () => {
  it("an enterprise admin configures the model in the admin console", async () => {
    renderFrame();
    const model = step(s.model.label);
    await userEvent.setup().click(within(model).getByRole("button", { name: s.model.action }));
    expect(router.push).toHaveBeenCalledWith("/admin/extensions");
    // creating an agent waits for the model: disabled with the reason
    const agent = step(s.agent.label);
    expect(
      (within(agent).getByRole("button", { name: s.agent.action }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(within(agent).getByText(sl.agent.needsModel)).toBeTruthy();
    // admins can act on the later items
    const later = within(screen.getByRole("list", { name: zh.home.setup.later }));
    expect(later.getByRole("link", { name: zh.home.setup.inviteMembers })).toBeTruthy();
    expect(later.getByRole("link", { name: zh.home.setup.channels }).getAttribute("href")).toBe(
      "/channels/new",
    );
    expect(screen.queryByText(sl.waiting)).toBeNull();
  });

  it("an org admin cannot fix a missing model provider: a deployment admin is needed", () => {
    renderFrame({ me: memberMe("admin") });
    const model = step(s.model.label);
    expect(within(model).queryByRole("button")).toBeNull();
    expect(within(model).getByText(sl.model.needsDeploymentAdmin)).toBeTruthy();
    // the role-specific line, with Refresh
    expect(screen.getByText(sl.waitingDeployment)).toBeTruthy();
    expect(screen.queryByText(sl.waiting)).toBeNull();
    expect(screen.getByRole("button", { name: sl.refresh })).toBeTruthy();
  });

  it("a member waits: no model action, the waiting line with Refresh, only personal items later", () => {
    renderFrame({ me: memberMe("member") });
    const model = step(s.model.label);
    expect(within(model).queryByRole("button")).toBeNull();
    expect(within(model).getByText(sl.model.waitingForAdmin)).toBeTruthy();
    expect(screen.getByText(sl.waiting)).toBeTruthy();
    expect(screen.getByRole("button", { name: sl.refresh })).toBeTruthy();
    const later = within(screen.getByRole("list", { name: zh.home.setup.later }));
    expect(later.getAllByRole("link").map((l) => l.getAttribute("href"))).toEqual([
      "/account/connections",
    ]);
  });

  it("a member with a model creates the agent; a guest waits for an admin", async () => {
    renderFrame({ me: memberMe("member"), readiness: PROVIDER_ONLY });
    const agent = step(s.agent.label);
    await userEvent.setup().click(within(agent).getByRole("button", { name: s.agent.action }));
    expect(router.push).toHaveBeenCalledWith("/agents/new");
    expect(screen.queryByText(sl.waiting)).toBeNull();
    cleanup();
    renderFrame({ me: memberMe("guest"), readiness: PROVIDER_ONLY });
    const waiting = step(s.agent.label);
    expect(within(waiting).queryByRole("button")).toBeNull();
    expect(within(waiting).getByText(sl.agent.waitingForAdmin)).toBeTruthy();
    expect(screen.getByText(sl.waiting)).toBeTruthy();
    expect(screen.queryByRole("list", { name: zh.home.setup.later })).toBeNull();
  });

  it("Refresh re-renders on the server; once ready the shell replaces the setup frame", async () => {
    const view = renderFrame({ me: memberMe("guest"), readiness: PROVIDER_ONLY });
    await userEvent.setup().click(screen.getByRole("button", { name: sl.refresh }));
    expect(router.refresh).toHaveBeenCalledTimes(1);
    view.update(shellOf(memberMe("guest"), { readiness: READY }));
    expect(screen.getByText("page body")).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "主导航" })).toBeTruthy();
    expect(setupPage()).toBeNull();
  });

  it("a navigation while in setup reads readiness again; the admin console does not", () => {
    resetNavigation("/settings/models");
    const view = renderFrame();
    expect(router.refresh).not.toHaveBeenCalled();
    resetNavigation("/agents/new");
    view.update(shellOf(ME, { readiness: NOT_READY }));
    expect(router.refresh).toHaveBeenCalledTimes(1);
    cleanup();
    resetNavigation("/admin/extensions");
    const admin = renderFrame();
    resetNavigation("/admin/accounts");
    admin.update(shellOf(ME, { readiness: NOT_READY }));
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("an enterprise admin reaches the admin console from the setup sidebar", () => {
    renderFrame();
    expect(setupSidebar()?.querySelector('a[href="/admin"]')).not.toBeNull();
    cleanup();
    renderFrame({ me: memberMe("admin") });
    expect(setupSidebar()?.querySelector('a[href="/admin"]')).toBeNull();
  });
});
