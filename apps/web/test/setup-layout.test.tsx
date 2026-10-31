import { DesignProvider, type LinkComponent, ToastProvider } from "@capybara-hq/design";
import { cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import zh from "../messages/zh.json";
import { AppFrame } from "../src/components/shell/AppFrame";
import { RequireSession } from "../src/components/shell/session";
import { setupRouteOf } from "../src/components/shell/setup";
import type { Me } from "../src/lib/session";
import { Link, resetNavigation, router } from "./support/navigation";
import { ME } from "./support/render";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));

// Acceptance round 2, D + D2: the guided setup layout. While the current org has no usable model or
// no agent, workspace routes render in the setup layout (top bar, centered column, status bar, no
// sidebar); the admin console keeps its own context; the checklist differs by role.

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type Handler = (init?: RequestInit) => Response | Promise<Response>;

function stubApi(routes: Record<string, Handler>) {
  const calls: { method: string; url: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const handler = routes[`${method} ${url.split("?")[0]}`];
      if (!handler) throw new Error(`unexpected ${method} ${url}`);
      return handler(init);
    }),
  );
  return calls;
}

const s = zh.chat.setup;
const sl = zh.setupLayout;
const READY = { modelProvider: "ready", agents: 1 };
const NONE = { modelProvider: "none", agents: 0 };
const PROVIDER_ONLY = { modelProvider: "ready", agents: 0 };

/** The org's readiness read (a body, or a handler such as a pending one), and other routes. */
function api(o: { me?: Me; readiness?: unknown | Handler; extra?: Record<string, Handler> } = {}) {
  const readiness = o.readiness ?? NONE;
  return stubApi({
    "GET /api/v1/me": () => json(200, o.me ?? ME),
    "GET /api/v1/orgs/o1/readiness":
      typeof readiness === "function" ? (readiness as Handler) : () => json(200, readiness),
    "GET /api/v1/orgs/o1/inbox": () => json(200, { items: [], truncated: false }),
    "GET /api/v1/orgs/o1/conversations/groups": () => json(200, { groups: [], next: null }),
    "GET /api/v1/orgs/o1/ui/contributions": () => json(200, { items: [] }),
    ...o.extra,
  });
}

function renderFrame() {
  return render(
    <NextIntlClientProvider locale="zh" messages={zh}>
      <DesignProvider locale="zh" link={Link as LinkComponent}>
        <ToastProvider>
          <AppFrame version="v9.9.9">
            <RequireSession>
              <p>page body</p>
            </RequireSession>
          </AppFrame>
        </ToastProvider>
      </DesignProvider>
    </NextIntlClientProvider>,
  );
}

const setupPage = () => document.querySelector('[data-template="SetupPage"]');
const step = (label: string) => screen.getByText(label).closest("li") as HTMLElement;
const memberMe = (role: string, enterprise = false): Me => ({
  ...ME,
  account: { ...ME.account, isEnterpriseAdmin: enterprise },
  memberships: [{ orgId: "o1", slug: "acme", name: "Acme", role }],
});

beforeEach(() => {
  resetNavigation("/");
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("setup layout scope", () => {
  it("not ready on /: the setup home, no sidebar; top bar with the org and the account", async () => {
    api();
    renderFrame();
    expect(await screen.findByRole("heading", { level: 1, name: s.title })).toBeTruthy();
    expect(setupPage()).not.toBeNull();
    expect(screen.queryByRole("navigation", { name: "主导航" })).toBeNull();
    expect(screen.queryByText("page body")).toBeNull();
    const top = document.querySelector('[data-part="setup-top-bar"]') as HTMLElement;
    expect(top.textContent).toContain("Acme");
    expect(top.textContent).toContain("~/acme");
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

  it("not ready on /chat: the same setup home, never a composer", async () => {
    resetNavigation("/chat");
    api();
    renderFrame();
    expect(await screen.findByRole("heading", { level: 1, name: s.title })).toBeTruthy();
    expect(document.querySelector('[data-template="ConversationPage"]')).toBeNull();
  });

  it("ready: the shell renders, no setup layout", async () => {
    const calls = api({ readiness: READY });
    renderFrame();
    expect(await screen.findByText("page body")).toBeTruthy();
    // one cheap read decides the layout: no agent list, no vendor model listing
    expect(calls.some((c) => c.url.endsWith("/models") || c.url.endsWith("/agents"))).toBe(false);
    expect(screen.getByRole("navigation", { name: "主导航" })).toBeTruthy();
    expect(setupPage()).toBeNull();
  });

  it("while readiness loads on /: neither the sidebar nor the checklist, only the neutral state", async () => {
    api({ readiness: () => new Promise<Response>(() => {}) });
    renderFrame();
    await vi.waitFor(() => {
      if (document.querySelector('[data-part="pending-state"]') === null) throw new Error("no");
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByRole("navigation", { name: "主导航" })).toBeNull();
    expect(setupPage()).toBeNull();
    expect(screen.queryByText(s.model.label)).toBeNull();
    expect(document.querySelector('[data-template="ConversationPage"]')).toBeNull();
  });

  it("a workspace route that is not a step redirects to / while not ready", async () => {
    resetNavigation("/connectors");
    api();
    renderFrame();
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith("/"));
    expect(screen.queryByText("page body")).toBeNull();
  });

  it("a step page (/settings/models) renders inside the setup frame with the back link", async () => {
    resetNavigation("/settings/models");
    api();
    renderFrame();
    expect(await screen.findByText("page body")).toBeTruthy();
    expect(setupPage()).not.toBeNull();
    expect(screen.queryByRole("navigation", { name: "主导航" })).toBeNull();
    expect(screen.getByRole("link", { name: sl.back }).getAttribute("href")).toBe("/");
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("/admin keeps the admin console context while not ready", async () => {
    resetNavigation("/admin/extensions");
    api();
    renderFrame();
    expect(await screen.findByText("page body")).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "主导航" });
    expect(within(nav).getByRole("link", { name: zh.admin.nav.extensions })).toBeTruthy();
    expect(setupPage()).toBeNull();
  });

  it("the org switch in the top bar works", async () => {
    const me = {
      ...ME,
      memberships: [...ME.memberships, { orgId: "o2", slug: "b", name: "Beta", role: "member" }],
    };
    const calls = api({
      me,
      extra: { "PUT /api/v1/me/current-org": () => new Response(null, { status: 204 }) },
    });
    renderFrame();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "当前组织：Acme，切换组织" }));
    await user.click(await screen.findByRole("menuitemradio", { name: "Beta" }));
    await vi.waitFor(() =>
      expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ orgId: "o2" }),
    );
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
    api();
    renderFrame();
    const model = await vi.waitFor(() => step(s.model.label));
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

  it("an org admin cannot fix a missing model provider: a deployment admin is needed", async () => {
    api({ me: memberMe("admin") });
    renderFrame();
    const model = await vi.waitFor(() => step(s.model.label));
    expect(within(model).queryByRole("button")).toBeNull();
    expect(within(model).getByText(sl.model.needsDeploymentAdmin)).toBeTruthy();
    // the role-specific line, with Refresh
    expect(screen.getByText(sl.waitingDeployment)).toBeTruthy();
    expect(screen.queryByText(sl.waiting)).toBeNull();
    expect(screen.getByRole("button", { name: sl.refresh })).toBeTruthy();
  });

  it("a member waits: no model action, the waiting line with Refresh, only personal items later", async () => {
    api({ me: memberMe("member") });
    renderFrame();
    const model = await vi.waitFor(() => step(s.model.label));
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
    api({ me: memberMe("member"), readiness: PROVIDER_ONLY });
    renderFrame();
    const agent = await vi.waitFor(() => step(s.agent.label));
    await userEvent.setup().click(within(agent).getByRole("button", { name: s.agent.action }));
    expect(router.push).toHaveBeenCalledWith("/agents/new");
    expect(screen.queryByText(sl.waiting)).toBeNull();
    cleanup();
    api({ me: memberMe("guest"), readiness: PROVIDER_ONLY });
    renderFrame();
    const waiting = await vi.waitFor(() => step(s.agent.label));
    expect(within(waiting).queryByRole("button")).toBeNull();
    expect(within(waiting).getByText(sl.agent.waitingForAdmin)).toBeTruthy();
    expect(screen.getByText(sl.waiting)).toBeTruthy();
    expect(screen.queryByRole("list", { name: zh.home.setup.later })).toBeNull();
  });

  it("after readiness flips, Refresh renders the shell", async () => {
    let r: unknown = PROVIDER_ONLY;
    api({ me: memberMe("guest"), readiness: () => json(200, r) });
    renderFrame();
    const refresh = await screen.findByRole("button", { name: sl.refresh });
    r = READY;
    await userEvent.setup().click(refresh);
    expect(await screen.findByText("page body")).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "主导航" })).toBeTruthy();
    expect(setupPage()).toBeNull();
  });
});

describe("readiness reads", () => {
  it("an org seen ready in this tab paints the shell at once and re-validates in the background", async () => {
    sessionStorage.setItem("cap.ready.a1.o1", "1");
    let answer: (r: Response) => void = () => {};
    api({ readiness: () => new Promise<Response>((res) => (answer = res)) });
    renderFrame();
    // the shell before the read answers
    expect(await screen.findByText("page body")).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "主导航" })).toBeTruthy();
    // the re-read says it is not ready any more: the setup layout replaces the shell
    answer(json(200, NONE));
    expect(await screen.findByRole("heading", { level: 1, name: s.title })).toBeTruthy();
    expect(sessionStorage.getItem("cap.ready.a1.o1")).toBeNull();
  });

  it("the mark is per account: another account's mark for the org is not used", async () => {
    sessionStorage.setItem("cap.ready.someone.o1", "1");
    api({ readiness: () => new Promise<Response>(() => {}) });
    renderFrame();
    // the read never answers and nothing of this account is stored: only the neutral state
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText("page body")).toBeNull();
  });

  it("signing out forgets every readiness mark of the tab", async () => {
    sessionStorage.setItem("cap.ready.someone.o9", "1");
    sessionStorage.setItem("other", "kept");
    api({
      readiness: READY,
      extra: { "POST /api/v1/auth/logout": () => new Response(null, { status: 204 }) },
    });
    renderFrame();
    await screen.findByText("page body");
    expect(sessionStorage.getItem("cap.ready.a1.o1")).toBe("1");
    await userEvent.setup().click(await screen.findByRole("button", { name: "账户: Grant" }));
    await userEvent.setup().click(await screen.findByRole("menuitem", { name: zh.common.logout }));
    await vi.waitFor(() => expect(sessionStorage.getItem("cap.ready.a1.o1")).toBeNull());
    expect(sessionStorage.getItem("cap.ready.someone.o9")).toBeNull();
    expect(sessionStorage.getItem("other")).toBe("kept");
  });

  it("a ready answer is remembered for the tab", async () => {
    api({ readiness: READY });
    renderFrame();
    await screen.findByText("page body");
    expect(sessionStorage.getItem("cap.ready.a1.o1")).toBe("1");
  });

  it("admin console navigations do not read readiness again", async () => {
    resetNavigation("/admin/extensions");
    const calls = api();
    const view = renderFrame();
    await screen.findByText("page body");
    const reads = () => calls.filter((c) => c.url.endsWith("/readiness")).length;
    const before = reads();
    resetNavigation("/admin/accounts");
    view.rerender(
      <NextIntlClientProvider locale="zh" messages={zh}>
        <DesignProvider locale="zh" link={Link as LinkComponent}>
          <ToastProvider>
            <AppFrame version="v9.9.9">
              <RequireSession>
                <p>page body</p>
              </RequireSession>
            </AppFrame>
          </ToastProvider>
        </DesignProvider>
      </NextIntlClientProvider>,
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(reads()).toBe(before);
  });

  it("an enterprise admin reaches the admin console from the setup layout", async () => {
    api();
    renderFrame();
    await userEvent.setup().click(await screen.findByRole("button", { name: "账户: Grant" }));
    const item = await screen.findByRole("menuitem", { name: zh.nav.admin });
    expect(item.getAttribute("href")).toBe("/admin");
    cleanup();
    api({ me: memberMe("admin") });
    renderFrame();
    await userEvent.setup().click(await screen.findByRole("button", { name: "账户: Grant" }));
    await screen.findByRole("menuitem", { name: zh.common.logout });
    expect(screen.queryByRole("menuitem", { name: zh.nav.admin })).toBeNull();
  });
});
