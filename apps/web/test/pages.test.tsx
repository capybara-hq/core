import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import CatchAllPage from "../src/app/(app)/[...rest]/page";
import AgentsPage from "../src/app/(app)/agents/page";
import NotFound from "../src/app/(app)/not-found";
import HomePage from "../src/app/(app)/page";
import LoginPage from "../src/app/(auth)/login/page";
import SetupPage from "../src/app/(auth)/setup/page";
import { activeNavOf } from "../src/components/shell/nav";
import { navigateBrowser } from "../src/lib/browser";
import type { Me } from "../src/lib/session";
import { resetNavigation, router } from "./support/navigation";
import { ME, renderPage } from "./support/render";
import { expectNoFirstPaintFetch, onServer, renderRoute } from "./support/server";
import { frameElement, NOT_READY, renderFrame, shellOf } from "./support/shell";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("../src/lib/browser", () => ({ navigateBrowser: vi.fn() }));
const notFound = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
);
vi.mock("next/navigation", () => ({
  notFound,
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** 按 `METHOD path` 路由的 fetch 桩；返回请求记录。 */
function stubApi(routes: Record<string, (init?: RequestInit) => Response>) {
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

const template = (name: string) => document.querySelector(`[data-template="${name}"]`);

beforeEach(() => {
  resetNavigation("/");
  vi.mocked(navigateBrowser).mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("(app) 页面模板", () => {
  const MODELS_READY = { providers: [{ provider: "model-fake", models: [{ id: "fake-1" }] }] };
  const AGENT = (id: string, name: string) => ({
    id,
    definition: { name, model: { provider: "model-fake", model: "fake-1" } },
  });
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  function overviewRoutes(over: Record<string, () => Response> = {}) {
    return {
      "GET /api/v1/orgs/o1/agents": () =>
        json(200, {
          agents: [AGENT("ag1", "研究助手"), AGENT("ag2", "客服分流"), AGENT("ag3", "写作助手")],
        }),
      "GET /api/v1/orgs/o1/models": () => json(200, MODELS_READY),
      "GET /api/v1/orgs/o1/inbox": () =>
        json(200, {
          truncated: false,
          items: [
            {
              type: "tool_approval",
              id: "ap1",
              createdAt: ago(2),
              approval: {
                id: "ap1",
                conversationId: "c1",
                toolName: "sandbox_bash",
                agent: { id: "ag1", name: "研究助手" },
                requestedFor: "a1",
                conversationPath: "/chat/c1",
              },
            },
            {
              type: "skill_change",
              id: "sc1",
              createdAt: ago(60),
              skillChange: {
                id: "sc1",
                agent: { id: "ag2", name: "客服分流" },
                skillId: "s1",
                name: "refund-policy",
              },
            },
          ],
        }),
      "GET /api/v1/orgs/o1/conversations/groups": () =>
        json(200, {
          next: null,
          groups: [
            {
              agent: { id: "ag2", name: "客服分流" },
              latestAt: ago(1),
              more: false,
              conversations: [
                {
                  id: "c2",
                  agentId: "ag2",
                  title: "订单 8841 退款",
                  createdAt: ago(30),
                  updatedAt: ago(1),
                },
              ],
            },
            {
              agent: { id: "ag1", name: "研究助手" },
              latestAt: ago(2),
              more: false,
              conversations: [
                {
                  id: "c1",
                  agentId: "ag1",
                  title: "季度报告数据核对",
                  createdAt: ago(90),
                  updatedAt: ago(2),
                },
              ],
            },
          ],
        }),
      "GET /api/v1/orgs/o1/skills": () => json(200, { skills: [{}, {}, {}] }),
      "GET /api/v1/orgs/o1/connectors": () => json(200, { connectors: [{}] }),
      "GET /api/v1/orgs/o1/members": () => json(200, { members: [{}, {}] }),
      ...over,
    };
  }

  it("the overview: what waits on me (allow once in place), conversations to pick up, the org, my agents", async () => {
    // the first paint is the server's: the browser only sends the decision
    const calls = stubApi({
      "POST /api/v1/orgs/o1/approvals/ap1/decision": () => json(200, { approval: { id: "ap1" } }),
    });
    await renderRoute(() => HomePage(), overviewRoutes(), { locale: "zh" });
    expect(template("OverviewPage")).not.toBeNull();
    const h = zh.home;
    expect(
      screen.getByRole("heading", { level: 1, name: h.greeting.replace("{name}", "Grant") }),
    ).toBeTruthy();
    const inbox = screen.getByRole("list", { name: h.inbox.title });
    const rows = within(inbox).getAllByRole("listitem");
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining("研究助手 想调用 sandbox_bash"),
      expect.stringContaining("客服分流 想更新技能 refund-policy"),
    ]);
    expect(screen.getByText("Acme · 所有者 · 2 件事等你处理")).toBeTruthy();
    // the conversations to pick up, newest first; the one with an approval is marked
    const recent = within(screen.getByRole("list", { name: h.recent.title })).getAllByRole(
      "listitem",
    );
    expect(recent.map((r) => within(r).getByRole("link").textContent)).toEqual([
      "订单 8841 退款",
      "季度报告数据核对",
    ]);
    expect(within(recent[1] as HTMLElement).getByText(h.recent.waiting)).toBeTruthy();
    expect(
      within(recent[1] as HTMLElement)
        .getByRole("link")
        .getAttribute("href"),
    ).toBe("/chat/c1");
    // the org at a glance
    for (const [k, v] of [
      [h.agents, "3"],
      [h.skills, "3"],
      [h.connectors, "1"],
      [h.members, "2"],
      [h.models, "1"],
    ]) {
      expect(screen.getByText(k as string).nextElementSibling?.textContent).toBe(v);
    }
    // my agents, the most recently used first
    const agents = within(screen.getByRole("list", { name: h.agentsCard.title })).getAllByRole(
      "listitem",
    );
    expect(agents.map((r) => within(r).getByRole("link").textContent)).toEqual([
      "客服分流",
      "研究助手",
      "写作助手",
    ]);
    const user = userEvent.setup();
    await user.click(
      within(agents[0] as HTMLElement).getByRole("button", { name: h.agentsCard.chat }),
    );
    expect(router.push).toHaveBeenCalledWith("/chat?agent=ag2");
    expect(screen.getByRole("link", { name: h.newConversation }).getAttribute("href")).toBe(
      "/chat",
    );
    // allowing an approval in place sends "approve once" and re-renders the page on the server
    await user.click(
      within(rows[0] as HTMLElement).getByRole("button", { name: h.inbox.approveOnce }),
    );
    await vi.waitFor(() =>
      expect(calls.find((c) => c.method === "POST")?.body).toEqual({
        decision: "approve",
        scope: "once",
      }),
    );
    await vi.waitFor(() => expect(router.refresh).toHaveBeenCalled());
    expect(calls.filter((c) => c.method === "GET")).toEqual([]);
    // the decided approval is gone at once, not when the server's new overview lands
    expect(
      within(screen.getByRole("list", { name: h.inbox.title }))
        .getAllByRole("listitem")
        .map((r) => r.textContent),
    ).toEqual([expect.stringContaining("客服分流 想更新技能 refund-policy")]);
  });

  it("the overview hides counts this role may not read", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRoute(
      () => HomePage(),
      overviewRoutes({
        "GET /api/v1/orgs/o1/members": () => json(403, { error: { code: "forbidden" } }),
      }),
    );
    screen.getByRole("list", { name: en.home.inbox.title });
    expect(screen.queryByText(en.home.members)).toBeNull();
    expect(screen.getByText(en.home.skills)).toBeTruthy();
    expect(browser).toEqual([]);
  });

  it("without a current org or while the org is in setup, the page draws nothing itself (the frame draws it)", async () => {
    stubApi({});
    const none = await renderRoute(() => HomePage(), {}, { me: { ...ME, currentOrgId: null } });
    expect(none.calls.map((c) => c.url)).toEqual(["/api/v1/me"]);
    expect(template("OverviewPage")).toBeNull();
    // outside a frame (no setup context) the page asks for one re-render
    expect(router.refresh).toHaveBeenCalledTimes(1);
    cleanup();
    router.refresh.mockReset();
    const setup = await renderRoute(() => HomePage(), {}, { readiness: NOT_READY });
    expect(new Set(setup.calls.map((c) => c.url))).toEqual(
      new Set(["/api/v1/me", "/api/v1/orgs/o1/readiness"]),
    );
    expect(template("OverviewPage")).toBeNull();
  });

  it("the org is not ready but the frame still draws the ready shell (stale layout props): refreshes once", async () => {
    stubApi({});
    // an admin removed the last model; a client navigation reused the layout's old props
    const { element } = await onServer(() => HomePage(), {}, { readiness: NOT_READY });
    const view = renderFrame(shellOf(), element);
    await vi.waitFor(() => expect(router.refresh).toHaveBeenCalledTimes(1));
    expect(template("OverviewPage")).toBeNull();
    // the same output again (the refresh's answer before the layout's arrives): no second refresh
    view.update(shellOf(), element);
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it("the org is not ready and the frame draws the setup home: no refresh", async () => {
    stubApi({});
    const { element } = await onServer(() => HomePage(), {}, { readiness: NOT_READY });
    renderFrame(shellOf(ME, { readiness: NOT_READY }), element);
    await new Promise((r) => setTimeout(r, 0));
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("the org was left but the frame still draws its shell: refreshes once", async () => {
    stubApi({});
    const { element } = await onServer(() => HomePage(), {}, { me: { ...ME, currentOrgId: null } });
    renderFrame(shellOf(), element);
    await vi.waitFor(() => expect(router.refresh).toHaveBeenCalledTimes(1));
  });

  it("the inbox and the conversations are sections: a failed read draws that panel's own state", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRoute(
      () => HomePage(),
      overviewRoutes({
        "GET /api/v1/orgs/o1/inbox": () => json(500, { error: { code: "internal" } }),
        "GET /api/v1/orgs/o1/conversations/groups": () =>
          json(503, { error: { code: "unavailable" } }),
      }),
    );
    expect(template("OverviewPage")).not.toBeNull();
    expect(screen.getByText(en.home.inbox.unavailable)).toBeTruthy();
    expect(screen.getByText(en.home.recent.unavailable)).toBeTruthy();
    // the agents card still renders
    expect(screen.getByRole("list", { name: en.home.agentsCard.title })).toBeTruthy();
    expect(browser).toEqual([]);
  });

  const agentRow = (id: string, name: string, over: Record<string, unknown> = {}) => ({
    id,
    ownerAccountId: "someone-else",
    visibility: "org",
    definition: {
      name,
      model: { provider: "model-fake", model: "fake-1" },
      skills: { orgSkills: ["s1", "s2"] },
      tools: [{ kind: "builtin", name: "ask_user" }],
    },
    ...over,
  });

  it("Agents page: object rows with scope chip, meta line and the row action Chat", async () => {
    const calls = stubApi({});
    await renderRoute(
      () => AgentsPage(),
      {
        "GET /api/v1/orgs/o1/agents": () => json(200, { agents: [agentRow("ag1", "Echo agent")] }),
      },
      { locale: "zh" },
    );
    expect(template("ListPage")).not.toBeNull();
    const list = await screen.findByRole("list", { name: zh.agents.title });
    const row = within(list).getAllByRole("listitem")[0] as HTMLElement;
    expect(within(row).getByText("Echo agent")).toBeTruthy();
    expect(within(row).getByText(zh.agents.scope.org)).toBeTruthy();
    expect(within(row).getByText("model-fake / fake-1 · 2 技能 · 1 工具")).toBeTruthy();
    expect(screen.getByRole("link", { name: zh.agents.new }).getAttribute("href")).toBe(
      "/agents/new",
    );
    await userEvent.setup().click(within(row).getByRole("button", { name: zh.agents.chat }));
    // A new conversation with the agent picked: nothing is created before the first send.
    expect(router.push).toHaveBeenCalledWith("/chat?agent=ag1");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("Agents page: tabs with counts (all / mine / shared) and a local search", async () => {
    stubApi({});
    await renderRoute(() => AgentsPage(), {
      "GET /api/v1/orgs/o1/agents": () =>
        json(200, {
          agents: [
            agentRow("ag1", "Alpha"),
            agentRow("ag2", "Beta", { ownerAccountId: ME.account.id, visibility: "private" }),
            agentRow("ag3", "Gamma", { ownerAccountId: ME.account.id }),
          ],
        }),
    });
    const user = userEvent.setup();
    await screen.findByText("Alpha");
    await user.click(screen.getByRole("tab", { name: /Mine/ }));
    expect(screen.queryByText("Alpha")).toBeNull();
    expect(screen.getByText("Beta")).toBeTruthy();
    expect(screen.getByRole("tab", { name: /Mine/ }).textContent).toContain("2");
    await user.click(screen.getByRole("tab", { name: /Shared with org/ }));
    expect(screen.queryByText("Beta")).toBeNull();
    expect(screen.getByRole("tab", { name: /Shared with org/ }).textContent).toContain("2");
    await user.click(screen.getByRole("tab", { name: /All/ }));
    await user.type(screen.getByRole("searchbox", { name: en.agents.search }), "gam");
    expect(screen.getByText("Gamma")).toBeTruthy();
    expect(screen.queryByText("Alpha")).toBeNull();
  });

  it("Agents page: the empty state is one sentence and the primary action", async () => {
    stubApi({});
    await renderRoute(() => AgentsPage(), {
      "GET /api/v1/orgs/o1/agents": () => json(200, { agents: [] }),
    });
    expect(await screen.findByText(en.agents.empty)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getAllByRole("link", { name: en.agents.new }).length).toBeGreaterThan(0);
  });

  it("(app)/[...rest] 未匹配的路径调用 notFound()（由 (app)/not-found 渲染 404）", () => {
    expect(() => renderToString(<CatchAllPage />)).toThrow("NEXT_NOT_FOUND");
    expect(notFound).toHaveBeenCalled();
  });

  it("not-found：StatusPage 404", () => {
    renderPage(<NotFound />, { locale: "zh" });
    expect(template("StatusPage")?.getAttribute("data-kind")).toBe("404");
    expect(screen.getByText(zh.notFound.description)).toBeTruthy();
  });
});

describe("(auth) 页面模板", () => {
  it("the sign-in page: AuthPage, rendered on the server (the layout sends setup to /setup)", async () => {
    expectNoFirstPaintFetch();
    await renderRoute(
      () => LoginPage({ searchParams: Promise.resolve({}) }),
      {
        "GET /api/v1/me": () => json(401, { error: { code: "auth.required", message: "x" } }),
        "GET /api/v1/auth/sources": () => json(200, { sources: [] }),
      },
      { locale: "zh" },
    );
    expect(template("AuthPage")).not.toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: zh.login.title })).toBeTruthy();
    // the auth pages switch language and theme too: a language dropdown and the theme radio
    const language = screen.getByRole("combobox", {
      name: zh.common.language,
    }) as HTMLSelectElement;
    expect(language.value).toBe("zh");
    expect([...language.options].map((o) => o.textContent)).toEqual([
      zh.common.localeName.zh,
      zh.common.localeName.en,
    ]);
    expect(screen.getByRole("radiogroup", { name: zh.common.theme })).toBeTruthy();
  });

  it("初始化页：AuthPage + 表单；已初始化时提示前往登录", async () => {
    stubApi({ "GET /api/v1/setup": () => json(200, { needsSetup: false }) });
    renderPage(<SetupPage />, { locale: "zh" });
    expect(template("AuthPage")).not.toBeNull();
    expect(screen.getByRole("combobox", { name: zh.common.language })).toBeTruthy();
    expect(await screen.findByText(zh.setup.alreadyDone)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: zh.setup.goToLogin }));
    expect(router.push).toHaveBeenCalledWith("/login");
  });

  it("初始化页：提交表单 POST /api/v1/setup，可选字段为空时不发送", async () => {
    const calls = stubApi({
      "GET /api/v1/setup": () => json(200, { needsSetup: true }),
      "POST /api/v1/setup": () => json(200, { account: { id: "a1" } }),
    });
    renderPage(<SetupPage />);
    const user = userEvent.setup();
    await user.type(await screen.findByRole("textbox", { name: en.setup.loginLabel }), "admin");
    await user.type(
      screen.getByLabelText(en.setup.passwordLabel, { exact: false }),
      "correct-horse-battery",
    );
    await user.type(screen.getByRole("textbox", { name: en.setup.displayNameLabel }), "Admin");
    await user.click(screen.getByRole("button", { name: en.setup.submit }));
    await vi.waitFor(() => expect(navigateBrowser).toHaveBeenCalledWith("/"));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({
      login: "admin",
      password: "correct-horse-battery",
      displayName: "Admin",
    });
  });
});

describe("AppFrame（(app) 布局的 App Shell）", () => {
  /** Opens the 更多 flyout (a menu to the right of the sidebar) and returns it. */
  async function openMore(nav: HTMLElement, name = "更多") {
    await userEvent.setup().click(within(nav).getByRole("button", { name }));
    return screen.findByRole("menu", { name });
  }
  const as = (role: string): Me => ({
    ...ME,
    memberships: [{ orgId: "o1", slug: "acme", name: "Acme", role }],
  });
  const notEnterprise: Me = { ...ME, account: { ...ME.account, isEnterpriseAdmin: false } };

  it("the sidebar lists existing routes only; the status bar reads account@org:route and the version", async () => {
    resetNavigation("/agents/new");
    renderFrame(shellOf(ME));
    expect(screen.getByText("page body")).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "主导航" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((l) => [l.textContent, l.getAttribute("href")])).toEqual([
      // A new conversation starts at the composer (UI refresh B)
      ["新会话", "/chat"],
      [zh.nav.overview, "/"],
      [zh.nav.agents, "/agents"],
    ]);
    // the inbox is the brand row's icon button
    expect(screen.getByRole("link", { name: zh.nav.inbox }).getAttribute("href")).toBe("/inbox");
    const menu = await openMore(nav);
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((l) => [l.textContent, l.getAttribute("href")])).toEqual([
      // 更多
      [zh.nav.skills, "/skills"],
      [zh.nav.connectors, "/connectors"],
      // plugins: members and up
      [zh.nav.catalog, "/catalog"],
      // org admins (owner) see channels, evals and organization settings
      [zh.nav.channels, "/channels"],
      [zh.nav.evals, "/evals"],
      [zh.nav.settings, "/settings/organization"],
    ]);
    await userEvent.setup().keyboard("{Escape}");
    // 企业管理员（与组织角色无关）看得到管理后台的入口，在账户行之上
    expect(screen.getByRole("link", { name: "管理后台" }).getAttribute("href")).toBe("/admin");
    expect(
      within(nav).getByRole("link", { name: zh.nav.agents }).getAttribute("aria-current"),
    ).toBe("page");
    const status = screen.getByRole("contentinfo");
    expect(within(status).getByText("Grant@acme:~/agents/new")).toBeTruthy();
    expect(within(status).getByText("v9.9.9")).toBeTruthy();
    expect(status.textContent).not.toContain(">");
  });

  it("普通成员的顶栏不显示管理员才能用的「渠道」", async () => {
    renderFrame(shellOf(as("member")));
    const nav = screen.getByRole("navigation", { name: "主导航" });
    const menu = await openMore(nav);
    expect(within(menu).queryByRole("menuitem", { name: zh.nav.channels })).toBeNull();
    expect(within(menu).queryByRole("menuitem", { name: zh.nav.evals })).toBeNull();
    expect(within(menu).getByRole("menuitem", { name: zh.nav.connectors })).toBeTruthy();
    // 成员能浏览技能库
    expect(within(menu).getByRole("menuitem", { name: zh.nav.skills })).toBeTruthy();
  });

  it("a failed conversation read on the server: the section's error state with 重试", () => {
    renderFrame(shellOf(ME, { groups: null }));
    const region = screen.getByRole("region", { name: "会话" });
    expect(within(region).getByRole("button", { name: zh.common.retry })).toBeTruthy();
  });

  it("signed in without a current org: the chooser covers the whole shell; opening an org enters the app", async () => {
    const me: Me = {
      ...ME,
      currentOrgId: null,
      memberships: [...ME.memberships, { orgId: "o2", slug: "b", name: "Beta", role: "member" }],
    };
    const calls = stubApi({
      "PUT /api/v1/me/current-org": () => new Response(null, { status: 204 }),
    });
    const view = renderFrame(shellOf(me));
    const c = zh.orgChooser;
    expect(screen.getByRole("heading", { name: c.title })).toBeTruthy();
    expect(document.querySelector('[data-template="AuthPage"]')).not.toBeNull();
    expect(screen.queryByRole("navigation", { name: "主导航" })).toBeNull();
    expect(screen.queryByText("page body")).toBeNull();
    const orgs = within(screen.getByRole("list", { name: c.listLabel })).getAllByRole("listitem");
    expect(orgs.map((o) => o.textContent)).toEqual([
      expect.stringContaining("Acme"),
      expect.stringContaining("Beta"),
    ]);
    // can create one too, and an enterprise admin can reach the admin console
    expect(screen.getByRole("button", { name: c.create })).toBeTruthy();
    expect(screen.getByRole("link", { name: c.admin }).getAttribute("href")).toBe("/admin");
    await userEvent.click(within(orgs[1] as HTMLElement).getByRole("button", { name: c.enter }));
    await vi.waitFor(() => expect(navigateBrowser).toHaveBeenCalledWith("/"));
    expect(calls.find((x) => x.method === "PUT")?.body).toEqual({ orgId: "o2" });
    // the button stays pending until the server's new frame arrives
    expect(
      within(orgs[1] as HTMLElement)
        .getByRole("button", { name: c.enter })
        .getAttribute("aria-busy"),
    ).toBe("true");
    view.update(shellOf({ ...me, currentOrgId: "o2" }));
    expect(screen.getByText("page body")).toBeTruthy();
    expect(screen.getByRole("button", { name: "当前组织：Beta，切换组织" })).toBeTruthy();
  });

  it("no org and not allowed to create one: the chooser says to ask for an invitation", () => {
    renderFrame(
      shellOf({ ...notEnterprise, currentOrgId: null, memberships: [], canCreateOrg: false }),
    );
    expect(screen.getByText(zh.orgChooser.askHint)).toBeTruthy();
    expect(screen.queryByRole("button", { name: zh.orgChooser.create })).toBeNull();
    expect(screen.queryByRole("link", { name: zh.orgChooser.admin })).toBeNull();
    expect(screen.getByRole("button", { name: zh.orgChooser.logout })).toBeTruthy();
  });

  it("the account menu's Organization submenu ends with Create organization", async () => {
    renderFrame(shellOf(ME));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^账户: Grant/ }));
    await user.click(screen.getByRole("menuitem", { name: zh.shell.orgMenu }));
    // jsdom has no layout: pick submenu items with the keyboard (see design menu-submenu tests)
    (await screen.findByRole("menuitem", { name: zh.shell.createOrg })).focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("dialog", { name: zh.home.createOrg.title })).toBeTruthy();
  });

  it("the group ＋ opens a new conversation with that agent picked", async () => {
    renderFrame(
      shellOf(ME, {
        groups: {
          groups: [
            {
              agent: { id: "a1", name: "研究助手" },
              latestAt: "2026-10-20T06:32:00.000Z",
              conversations: [],
              more: false,
            },
          ],
          next: null,
        },
      }),
    );
    await userEvent.click(screen.getByRole("button", { name: "与 研究助手 新建会话" }));
    await vi.waitFor(() => expect(router.push).toHaveBeenCalledWith("/chat?agent=a1"));
  });

  it("非企业管理员看不到一级导航「管理」（组织 owner 也不行）", async () => {
    renderFrame(shellOf(notEnterprise));
    const nav = screen.getByRole("navigation", { name: "主导航" });
    expect(screen.queryByRole("link", { name: "管理后台" })).toBeNull();
    const menu = await openMore(nav);
    expect(within(menu).getByRole("menuitem", { name: zh.nav.evals })).toBeTruthy();
  });

  it("an enterprise admin without an org still reaches the admin console in the shell", () => {
    resetNavigation("/admin");
    renderFrame(shellOf({ ...ME, currentOrgId: null, memberships: [] }));
    expect(screen.getByText("page body")).toBeTruthy();
    // the admin context: its items, the current one marked
    const nav = screen.getByRole("navigation", { name: "主导航" });
    const overview = within(nav).getByRole("link", { name: zh.admin.nav.overview });
    expect(overview.getAttribute("href")).toBe("/admin");
    expect(overview.getAttribute("aria-current")).toBe("page");
    expect(screen.queryByRole("region", { name: "会话" })).toBeNull();
  });

  it("a person who is not an enterprise admin keeps the workspace sidebar under /admin", () => {
    resetNavigation("/admin/accounts");
    renderFrame(shellOf(notEnterprise));
    expect(screen.getByText("page body")).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "主导航" });
    // the 403 page stands beside the workspace sidebar, never the admin context
    expect(within(nav).queryByRole("link", { name: zh.admin.nav.overview })).toBeNull();
    expect(within(nav).getByRole("link", { name: zh.nav.agents })).toBeTruthy();
  });

  it("访客的顶栏不显示「技能」", () => {
    renderFrame(shellOf(as("guest")));
    const nav = screen.getByRole("navigation", { name: "主导航" });
    expect(within(nav).queryByRole("link", { name: zh.nav.skills })).toBeNull();
    expect(within(nav).getByRole("link", { name: zh.nav.agents })).toBeTruthy();
  });

  it.each(["zh", "en"] as const)(
    "顶栏「收件箱」带待处理数 Badge（收件箱汇总：工具审批 + 技能变更）（%s）",
    async (locale) => {
      const m = locale === "zh" ? zh : en;
      renderFrame(shellOf(ME, { pending: { count: 2, more: false } }), undefined, { locale });
      const nav = screen.getByRole("navigation", {
        name: locale === "zh" ? "主导航" : "Main navigation",
      });
      expect(
        screen.getByRole("link", {
          name: locale === "zh" ? `${m.nav.inbox}，2 项待处理` : `${m.nav.inbox}, 2 pending`,
        }),
      ).toBeTruthy();
      const menu = await openMore(nav, locale === "zh" ? "更多" : "More");
      expect(within(menu).getByRole("menuitem", { name: m.nav.connectors })).toBeTruthy();
    },
  );

  it("收件箱被截断（truncated）：Badge 显示「<数量>+」", () => {
    renderFrame(shellOf(ME, { pending: { count: 2, more: true } }), undefined, { locale: "en" });
    const link = screen.getByRole("link", { name: `${en.nav.inbox}, 2+ pending` });
    expect(within(link).getByText("2+")).toBeTruthy();
  });

  it("the account menu holds Organization ▸ and Language ▸ above sign-out; the theme switch follows the account", async () => {
    const me = {
      ...ME,
      memberships: [...ME.memberships, { orgId: "o2", slug: "b", name: "Beta", role: "member" }],
    };
    const calls = stubApi({
      "PUT /api/v1/me/current-org": () => new Response(null, { status: 204 }),
      "POST /api/v1/auth/logout": () => new Response(null, { status: 204 }),
    });
    renderFrame(shellOf(me));
    const user = userEvent.setup();
    const account = () => screen.getByRole("button", { name: `账户: ${ME.account.displayName}` });
    // the account menu: Organization ▸ and Language ▸ above sign-out
    await user.click(account());
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual([
      zh.shell.orgMenu,
      zh.common.language,
      zh.shell.accountSettings,
      zh.common.logout,
    ]);
    await user.click(screen.getByRole("menuitem", { name: zh.shell.orgMenu }));
    const current = await screen.findByRole("menuitemradio", { name: "Acme" });
    expect(current.getAttribute("aria-checked")).toBe("true");
    expect(current.querySelector("svg")).toBeTruthy();
    expect(current.textContent).toBe("Acme");
    // jsdom has no layout: pick submenu items with the keyboard (see design menu-submenu tests)
    (await screen.findByRole("menuitemradio", { name: "Beta" })).focus();
    await user.keyboard("{Enter}");
    await vi.waitFor(() =>
      expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ orgId: "o2" }),
    );

    await user.click(account());
    await user.click(screen.getByRole("menuitem", { name: zh.common.language }));
    (await screen.findByRole("menuitemradio", { name: zh.common.localeName.en })).focus();
    await user.keyboard("{Enter}");
    expect(document.cookie).toContain("NEXT_LOCALE=en");
    expect(router.refresh).toHaveBeenCalled();

    // the theme switch sits after the account, one click away
    const themes = screen.getByRole("radiogroup", { name: zh.common.theme });
    await user.click(within(themes).getByRole("radio", { name: zh.common.themeLight }));
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.cookie).toContain("cb-theme=light");

    await user.click(account());
    await user.click(await screen.findByRole("menuitem", { name: zh.common.logout }));
    await vi.waitFor(() => expect(navigateBrowser).toHaveBeenCalledWith("/login"));
  });

  it("服务端渲染不含时区（避免与浏览器时区不同导致的水合不一致）", () => {
    resetNavigation("/admin");
    const html = renderToString(frameElement(shellOf(ME)));
    expect(html).toContain("v9.9.9");
    expect(html).not.toContain("UTC");
  });

  it("a workspace route server-renders its frame, never a neutral state", () => {
    const html = renderToString(frameElement(shellOf(ME), <NotFound />));
    expect(html).toContain('data-part="sidebar"');
    expect(html).toContain('data-kind="404"');
    expect(html).not.toContain('data-part="pending-state"');
  });

  it("the not-found page renders inside the admin shell on the server", () => {
    resetNavigation("/admin/nope");
    const html = renderToString(frameElement(shellOf(ME), <NotFound />));
    expect(html).toContain('data-template="StatusPage"');
    expect(html).toContain('data-kind="404"');
  });
});

describe("activeNavOf", () => {
  it("connectors light /connectors*; every /settings page is Settings; a conversation is none", () => {
    expect(activeNavOf("/connectors")).toBe("connectors");
    expect(activeNavOf("/connectors/x")).toBe("connectors");
    expect(activeNavOf("/connectors/install")).toBe("connectors");
    for (const p of [
      "/settings",
      "/settings/organization",
      "/settings/sandbox",
      "/settings/extensions",
      "/settings/plugins",
    ]) {
      expect(activeNavOf(p)).toBe("settings");
    }
    expect(activeNavOf("/settingsx")).toBe("");
    expect(activeNavOf("/appsx")).toBe("");
    expect(activeNavOf("/inbox")).toBe("inbox");
    expect(activeNavOf("/channels")).toBe("channels");
    expect(activeNavOf("/channels/new")).toBe("channels");
    expect(activeNavOf("/chat/c1")).toBe("");
    expect(activeNavOf("/skills")).toBe("skills");
    expect(activeNavOf("/skills/s1")).toBe("skills");
    expect(activeNavOf("/catalog")).toBe("catalog");
    expect(activeNavOf("/catalog/x/install")).toBe("catalog");
  });
});
