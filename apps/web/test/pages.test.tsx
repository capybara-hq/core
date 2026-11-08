import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import CatchAllPage from "../src/app/(app)/[...rest]/page";
import NotFound from "../src/app/(app)/not-found";
import LoginPage from "../src/app/(auth)/login/page";
import SetupPage from "../src/app/(auth)/setup/page";
import { ErrorFrame } from "../src/components/ErrorFrame";
import { activeNavOf } from "../src/components/shell/nav";
import { navigateBrowser } from "../src/lib/browser";
import type { Me } from "../src/lib/session";
import { resetNavigation, router } from "./support/navigation";
import { renderRouteWithCache } from "./support/query";
import { ME, renderPage } from "./support/render";
import { fieldOptionLabels } from "./support/select";
import { expectNoFirstPaintFetch, renderRoute } from "./support/server";
import { frameElement, renderFrame, shellOf } from "./support/shell";

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
  const agentRow = (id: string, name: string, over: Record<string, unknown> = {}) => ({
    id,
    ownerAccountId: "someone-else",
    visibility: "org",
    definition: {
      name,
      model: { provider: "model-fake", model: "fake-1" },
      skills: { orgSkills: ["s1", "s2"] },
      tools: [{ kind: "builtin", name: "AskUserQuestion" }],
    },
    profile: { avatar: null, description: "", quickActions: [], updatedAt: "2026-10-26T06:00:00Z" },
    ...over,
  });

  /** What the agents page reads on a first load (members up: the members and the templates). */
  const agentsPage = (agents: unknown[]) => ({
    "GET /api/v1/orgs/o1/agents": () => json(200, { agents }),
    "GET /api/v1/orgs/o1/members": () =>
      json(200, {
        members: [
          {
            account: { id: "someone-else", displayName: "Lin", email: null },
            role: "member",
            joinedAt: "2026-10-01T00:00:00Z",
            anonymous: false,
          },
        ],
      }),
    "GET /api/v1/orgs/o1/agent-templates": () => json(200, { templates: [] }),
    "GET /api/v1/orgs/o1/components": () => json(200, { components: [] }),
  });

  it("Agents page: cards with owner · visibility as the meta line (no chip) and the primary 开始会话", async () => {
    const calls = stubApi({});
    await renderRouteWithCache(
      "/agents",
      agentsPage([
        agentRow("ag1", "Echo agent", {
          profile: { ...agentRow("x", "x").profile, description: "Says it back." },
        }),
      ]),
      { locale: "zh" },
    );
    expect(template("ListPage")).not.toBeNull();
    const grid = await screen.findByRole("list", { name: zh.agents.title });
    expect(grid.getAttribute("data-part")).toBe("card-grid");
    const card = within(grid).getAllByRole("listitem")[0] as HTMLElement;
    // the name is the card's one link, to the agent's page
    expect(within(card).getByRole("link", { name: "Echo agent" }).getAttribute("href")).toBe(
      "/agents/ag1",
    );
    expect(within(card).getByText("Says it back.")).toBeTruthy();
    // owner · visibility is plain metadata, never a chip
    expect(card.querySelector(".cb-object-chip")).toBeNull();
    expect(within(card).getByText(`Lin · ${zh.agents.scope.org}`)).toBeTruthy();
    // 开始会话: a new conversation with the agent picked; nothing is created before the first send
    expect(within(card).getByRole("link", { name: zh.agents.chat }).getAttribute("href")).toBe(
      "/?agent=ag1",
    );
    expect(screen.getByRole("link", { name: zh.agents.new }).getAttribute("href")).toBe(
      "/agents/new",
    );
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("Agents page: the tabs 智能体 / 模板 with counts, the toolbar filter 全部 / 我的 / 组织共享 and a local search", async () => {
    stubApi({});
    await renderRouteWithCache(
      "/agents",
      agentsPage([
        agentRow("ag1", "Alpha"),
        agentRow("ag2", "Beta", { ownerAccountId: ME.account.id, visibility: "private" }),
        agentRow("ag3", "Gamma", { ownerAccountId: ME.account.id }),
      ]),
    );
    const user = userEvent.setup();
    await screen.findByText("Alpha");
    expect(screen.getByRole("tab", { name: /Agents/ }).textContent).toContain("3");
    expect(screen.getByRole("tab", { name: /Templates/ }).textContent).toContain("0");
    // the owner is "Me" on one's own agents
    expect(screen.getByText(`${en.agents.ownerMe} · ${en.agents.scope.private}`)).toBeTruthy();
    const filter = screen.getByRole("radiogroup", { name: en.agents.filter });
    await user.click(within(filter).getByRole("radio", { name: en.agents.tabs.mine }));
    expect(screen.queryByText("Alpha")).toBeNull();
    expect(screen.getByText("Beta")).toBeTruthy();
    await user.click(within(filter).getByRole("radio", { name: en.agents.tabs.shared }));
    expect(screen.queryByText("Beta")).toBeNull();
    expect(screen.getByText("Gamma")).toBeTruthy();
    await user.click(within(filter).getByRole("radio", { name: en.agents.tabs.all }));
    await user.type(screen.getByRole("searchbox", { name: en.agents.search }), "gam");
    expect(screen.getByText("Gamma")).toBeTruthy();
    expect(screen.queryByText("Alpha")).toBeNull();
    // nothing left: one sentence, no primary
    await user.type(screen.getByRole("searchbox", { name: en.agents.search }), "zzz");
    expect(screen.getByText(en.agents.noMatch)).toBeTruthy();
  });

  it("Agents page: the empty state is one sentence and the primary action", async () => {
    stubApi({});
    await renderRouteWithCache("/agents", agentsPage([]));
    expect(await screen.findByText(en.agents.empty)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getAllByRole("link", { name: en.agents.new }).length).toBeGreaterThan(0);
  });

  it("(app)/[...rest] 未匹配的路径调用 notFound()（由 (app)/not-found 渲染 404）", () => {
    expect(() => renderToString(<CatchAllPage />)).toThrow("NEXT_NOT_FOUND");
    expect(notFound).toHaveBeenCalled();
  });

  it("not-found：StatusPage 404; its action goes home, the new conversation", async () => {
    renderPage(<NotFound />, { locale: "zh" });
    expect(template("StatusPage")?.getAttribute("data-kind")).toBe("404");
    expect(screen.getByText(zh.notFound.description)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: zh.notFound.back }));
    expect(router.push).toHaveBeenCalledWith("/");
  });

  it("not-found keeps the page's path in the head, not ~", () => {
    resetNavigation("/trajectories/9f60c1e6-1111-4222-8333-444455556666");
    renderPage(<NotFound />, { locale: "zh" });
    const nav = screen.getByRole("navigation", { name: "路径" });
    expect(nav.textContent).toBe("acme/trajectories/9f60c1e6");
    // the org scope links home (the new conversation; there is no home page)
    expect(within(nav).getByRole("link", { name: "acme" }).getAttribute("href")).toBe("/");
    expect(within(nav).getByRole("link", { name: "trajectories" }).getAttribute("href")).toBe(
      "/trajectories",
    );
  });

  it("the error page keeps the page's path in the head; under /admin it starts with /admin", () => {
    resetNavigation("/trajectories");
    const { unmount } = renderPage(<ErrorFrame reset={() => {}} />, { locale: "zh" });
    expect(screen.getByRole("navigation", { name: "路径" }).textContent).toBe("acme/trajectories");
    unmount();
    resetNavigation("/admin/accounts");
    renderPage(<ErrorFrame reset={() => {}} />, { locale: "zh" });
    expect(screen.getByRole("navigation", { name: "路径" }).textContent).toBe("/admin/accounts");
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
    }) as HTMLButtonElement;
    expect(language.value).toBe("zh");
    expect(fieldOptionLabels(language)).toEqual([zh.common.localeName.zh, zh.common.localeName.en]);
    expect(screen.getByRole("radiogroup", { name: zh.common.theme })).toBeTruthy();
  });

  it("初始化页：AuthPage + 表单；已初始化时提示前往登录", async () => {
    stubApi({ "GET /api/v1/setup": () => json(200, { needsSetup: false }) });
    renderPage(await SetupPage(), { locale: "zh" });
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
    renderPage(await SetupPage());
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
  const notSuperAdmin: Me = { ...ME, account: { ...ME.account, isSuperAdmin: false } };

  it("the sidebar lists existing routes only; the status bar reads account@org:route and the version", async () => {
    resetNavigation("/agents/new");
    renderFrame(shellOf(ME));
    expect(screen.getByText("page body")).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "主导航" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((l) => [l.textContent, l.getAttribute("href")])).toEqual([
      // A new conversation starts at the composer (UI refresh B)
      ["新会话", "/"],
      // no home item; 技能 and 连接器 sit under 智能体 (acceptance 2026-11-07)
      [zh.nav.agents, "/agents"],
      [zh.nav.skills, "/skills"],
      [zh.nav.connectors, "/connectors"],
      [zh.nav.devices, "/devices"],
    ]);
    // the inbox is the brand row's icon button
    expect(screen.getByRole("link", { name: zh.nav.inbox }).getAttribute("href")).toBe("/inbox");
    const menu = await openMore(nav);
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((l) => [l.textContent, l.getAttribute("href")])).toEqual([
      // 更多: plugins (members and up), extensions (org admins)
      [zh.nav.plugins, "/plugins"],
      [zh.nav.extensions, "/extensions"],
      // org admins (owner) see channels, evals and organization settings
      [zh.nav.channels, "/channels"],
      [zh.nav.evals, "/evals"],
      [zh.nav.settings, "/settings/organization"],
    ]);
    await userEvent.setup().keyboard("{Escape}");
    // 超级管理员（与组织角色无关）看得到管理后台的入口，在账户行之上
    expect(screen.getByRole("link", { name: "管理后台" }).getAttribute("href")).toBe("/admin");
    expect(
      within(nav).getByRole("link", { name: zh.nav.agents }).getAttribute("aria-current"),
    ).toBe("page");
    const status = screen.getByRole("contentinfo");
    expect(within(status).getByText("grant@acme:~/agents/new")).toBeTruthy();
    expect(within(status).getByText("v9.9.9")).toBeTruthy();
    expect(status.textContent).not.toContain(">");
  });

  it("普通成员的顶栏不显示管理员才能用的「渠道」", async () => {
    renderFrame(shellOf(as("member")));
    const nav = screen.getByRole("navigation", { name: "主导航" });
    expect(within(nav).getByRole("link", { name: zh.nav.connectors })).toBeTruthy();
    expect(within(nav).getByRole("link", { name: zh.nav.skills })).toBeTruthy();
    const menu = await openMore(nav);
    expect(within(menu).queryByRole("menuitem", { name: zh.nav.channels })).toBeNull();
    expect(within(menu).queryByRole("menuitem", { name: zh.nav.evals })).toBeNull();
    // 技能 and 连接器 are top-level items, not in the flyout; members browse skills
    expect(within(menu).queryByRole("menuitem", { name: zh.nav.connectors })).toBeNull();
    expect(within(menu).queryByRole("menuitem", { name: zh.nav.skills })).toBeNull();
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
    // can create one too, and a super admin can reach the admin console
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
      shellOf({ ...notSuperAdmin, currentOrgId: null, memberships: [], canCreateOrg: false }),
    );
    expect(screen.getByText(zh.orgChooser.askHint)).toBeTruthy();
    expect(screen.queryByRole("button", { name: zh.orgChooser.create })).toBeNull();
    expect(screen.queryByRole("link", { name: zh.orgChooser.admin })).toBeNull();
    expect(screen.getByRole("button", { name: zh.orgChooser.logout })).toBeTruthy();
  });

  it("the org switcher's menu ends with Create organization", async () => {
    renderFrame(shellOf(ME));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "当前组织：Acme，切换组织" }));
    // jsdom has no layout: pick items with the keyboard (see design menu-submenu tests)
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
    await vi.waitFor(() => expect(router.push).toHaveBeenCalledWith("/?agent=a1"));
  });

  it("非超级管理员看不到一级导航「管理」（组织 owner 也不行）", async () => {
    renderFrame(shellOf(notSuperAdmin));
    const nav = screen.getByRole("navigation", { name: "主导航" });
    expect(screen.queryByRole("link", { name: "管理后台" })).toBeNull();
    const menu = await openMore(nav);
    expect(within(menu).getByRole("menuitem", { name: zh.nav.evals })).toBeTruthy();
  });

  it("a super admin without an org still reaches the admin console in the shell", () => {
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

  it("a person who is not a super admin keeps the workspace sidebar under /admin", () => {
    resetNavigation("/admin/accounts");
    renderFrame(shellOf(notSuperAdmin));
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
    expect(within(nav).getByRole("link", { name: zh.nav.connectors })).toBeTruthy();
    // nothing of the 更多 flyout is a guest's (no extension pages here): no 更多 row
    expect(within(nav).queryByRole("button", { name: "更多" })).toBeNull();
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
      expect(within(menu).getByRole("menuitem", { name: m.nav.plugins })).toBeTruthy();
    },
  );

  it("收件箱被截断（truncated）：Badge 显示「<数量>+」", () => {
    renderFrame(shellOf(ME, { pending: { count: 2, more: true } }), undefined, { locale: "en" });
    const link = screen.getByRole("link", { name: `${en.nav.inbox}, 2+ pending` });
    expect(within(link).getByText("2+")).toBeTruthy();
  });

  it("the account menu holds Language ▸ above sign-out, the org switcher switches orgs; the theme switch follows the account", async () => {
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
    // the account menu: Language ▸ above sign-out, no org entry
    await user.click(account());
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual([
      zh.common.language,
      zh.shell.accountSettings,
      zh.common.logout,
    ]);
    await user.keyboard("{Escape}");
    // the org switcher's menu: the orgs as radio items directly
    await user.click(screen.getByRole("button", { name: "当前组织：Acme，切换组织" }));
    const current = await screen.findByRole("menuitemradio", { name: "Acme" });
    expect(current.getAttribute("aria-checked")).toBe("true");
    expect(current.querySelector("svg")).toBeTruthy();
    expect(current.textContent).toBe("Acme");
    // the current org is the current choice, in primary text: not disabled
    expect(current.getAttribute("aria-disabled")).toBeNull();
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
    for (const p of ["/settings", "/settings/organization", "/settings/sandbox"]) {
      expect(activeNavOf(p)).toBe("settings");
    }
    expect(activeNavOf("/settingsx")).toBe("");
    expect(activeNavOf("/appsx")).toBe("");
    expect(activeNavOf("/inbox")).toBe("inbox");
    expect(activeNavOf("/channels")).toBe("channels");
    expect(activeNavOf("/channels/new")).toBe("channels");
    expect(activeNavOf("/chat/c1")).toBe("");
    // the new conversation is the home: 新会话 is current there
    expect(activeNavOf("/")).toBe("new");
    // the old `/chat` never renders (next.config redirects it to `/`); admin pages are not 新会话
    expect(activeNavOf("/chat")).toBe("");
    expect(activeNavOf("/admin/plugins")).not.toBe("new");
    expect(activeNavOf("/skills")).toBe("skills");
    expect(activeNavOf("/skills/s1")).toBe("skills");
    expect(activeNavOf("/plugins")).toBe("plugins");
    expect(activeNavOf("/plugins/x/enable")).toBe("plugins");
    expect(activeNavOf("/extensions")).toBe("extensions");
  });
});
