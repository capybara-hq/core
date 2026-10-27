import { DesignProvider, type LinkComponent, ToastProvider } from "@capybara-hq/design";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import CatchAllPage from "../src/app/[locale]/(app)/[...rest]/page";
import NewAgentPage from "../src/app/[locale]/(app)/agents/new/page";
import AgentsPage from "../src/app/[locale]/(app)/agents/page";
import NotFound from "../src/app/[locale]/(app)/not-found";
import HomePage from "../src/app/[locale]/(app)/page";
import LoginPage from "../src/app/[locale]/(auth)/login/page";
import SetupPage from "../src/app/[locale]/(auth)/setup/page";
import { AppFrame } from "../src/components/shell/AppFrame";
import { activeNavOf } from "../src/components/shell/nav";
import { RequireSession } from "../src/components/shell/session";
import { Link, resetNavigation, router } from "./support/navigation";
import { ME, renderPage } from "./support/render";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
const notFound = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
);
vi.mock("next/navigation", () => ({ notFound }));

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

beforeEach(() => resetNavigation("/"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("(app) 页面模板", () => {
  it("概览页：OverviewPage，问候 + 当前组织 + 去 Agents 的入口", () => {
    renderPage(<HomePage />, { locale: "zh" });
    expect(template("OverviewPage")).not.toBeNull();
    expect(
      screen.getByRole("heading", { level: 1, name: zh.home.greeting.replace("{name}", "Grant") }),
    ).toBeTruthy();
    expect(
      (screen.getByRole("combobox", { name: zh.home.currentOrg }) as HTMLSelectElement).value,
    ).toBe("o1");
    expect(screen.getByRole("link", { name: zh.home.openAgents }).getAttribute("href")).toBe(
      "/agents",
    );
  });

  it("概览页：选回「选择组织」清除当前组织（switchOrg(null)）", async () => {
    const switchOrg = vi.fn(async () => {});
    renderPage(<HomePage />, { session: { switchOrg } });
    const select = screen.getByRole("combobox", { name: en.home.currentOrg });
    expect(within(select).getByRole("option", { name: en.home.selectOrg })).toBeTruthy();
    await userEvent.selectOptions(select, "");
    expect(switchOrg).toHaveBeenCalledWith(null);
  });

  it("概览页：切换当前组织调用 switchOrg", async () => {
    const switchOrg = vi.fn(async () => {});
    const me = {
      ...ME,
      currentOrgId: null,
      memberships: [...ME.memberships, { orgId: "o2", slug: "b", name: "Beta", role: "member" }],
    };
    renderPage(<HomePage />, { me, session: { switchOrg } });
    expect(screen.queryByRole("link", { name: en.home.openAgents })).toBeNull();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: en.home.currentOrg }), "o2");
    expect(switchOrg).toHaveBeenCalledWith("o2");
  });

  it("没有任何组织：StatusPage disabled「还没有加入任何组织」", () => {
    renderPage(<HomePage />, { locale: "zh", me: { ...ME, currentOrgId: null, memberships: [] } });
    expect(template("StatusPage")?.getAttribute("data-kind")).toBe("disabled");
    expect(screen.getByText("还没有加入任何组织")).toBeTruthy();
  });

  it("Agents 页：ListPage + DataTable（名称、模型），header 主操作「新建 Agent」，行菜单「开始对话」", async () => {
    const calls = stubApi({
      "GET /api/v1/orgs/o1/agents": () =>
        json(200, {
          agents: [
            {
              id: "ag1",
              definition: {
                name: "Echo agent",
                model: { provider: "model-fake", model: "fake-1" },
              },
            },
          ],
        }),
      "POST /api/v1/orgs/o1/conversations": () => json(201, { conversation: { id: "c 1" } }),
    });
    renderPage(<AgentsPage />, { locale: "zh" });
    expect(template("ListPage")).not.toBeNull();
    const table = await screen.findByRole("table", { name: zh.agents.title });
    // the signed reference: a list page's table sits on the panel ground
    expect(table.closest("[data-framed]")?.getAttribute("data-framed")).toBe("true");
    const headers = within(table)
      .getAllByRole("columnheader")
      .map((h) => h.textContent);
    expect(headers).toEqual(
      expect.arrayContaining([zh.agents.columns.name, zh.agents.columns.model]),
    );
    expect(within(table).getByText("Echo agent")).toBeTruthy();
    expect(within(table).getByText("model-fake / fake-1")).toBeTruthy();
    const create = screen.getByRole("link", { name: zh.agents.new });
    expect(create.getAttribute("href")).toBe("/agents/new");

    const user = userEvent.setup();
    await user.click(within(table).getByRole("button", { name: "行操作" }));
    await user.click(await screen.findByRole("menuitem", { name: zh.agents.startChat }));
    // A new conversation with the agent picked: nothing is created before the first send.
    await vi.waitFor(() => expect(router.push).toHaveBeenCalledWith("/chat?agent=ag1"));
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  const oneAgent = () =>
    json(200, {
      agents: [
        { id: "ag1", definition: { name: "Echo agent", model: { provider: "p", model: "m" } } },
      ],
    });

  it("Agents 页：点击行即开始对话（新会话，选好该 agent）", async () => {
    stubApi({ "GET /api/v1/orgs/o1/agents": oneAgent });
    renderPage(<AgentsPage />, { locale: "zh" });
    await userEvent.setup().click(await screen.findByText("Echo agent"));
    await vi.waitFor(() => expect(router.push).toHaveBeenCalledWith("/chat?agent=ag1"));
  });

  it("Agents 页：行获得焦点后按 Enter 开始对话", async () => {
    stubApi({ "GET /api/v1/orgs/o1/agents": oneAgent });
    renderPage(<AgentsPage />, { locale: "zh" });
    const cell = await screen.findByText("Echo agent");
    cell.closest("tr")?.focus();
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(router.push).toHaveBeenCalledWith("/chat?agent=ag1"));
  });

  it("Agents 页：空状态带「新建 Agent」", async () => {
    stubApi({ "GET /api/v1/orgs/o1/agents": () => json(200, { agents: [] }) });
    renderPage(<AgentsPage />);
    expect(await screen.findByText(en.agents.empty)).toBeTruthy();
    const emptyCreate = screen.getByRole("button", { name: en.agents.new });
    // 一个视图只有一个主操作（spec §6.1）：页头的「新建 Agent」是主操作，空状态里的用 default
    expect(emptyCreate.getAttribute("data-variant")).toBe("default");
    expect(screen.getByRole("link", { name: en.agents.new })).toBeTruthy();
    await userEvent.click(emptyCreate);
    expect(router.push).toHaveBeenCalledWith("/agents/new");
  });

  it("需要组织的页面在未选组织时显示 StatusPage disabled", () => {
    renderPage(<NewAgentPage />, { me: { ...ME, currentOrgId: null } });
    expect(template("StatusPage")?.getAttribute("data-kind")).toBe("disabled");
    expect(screen.getByRole("heading", { level: 2, name: en.agents.noOrg })).toBeTruthy();
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
  it("登录页：AuthPage；未初始化时转到初始化向导", async () => {
    stubApi({ "GET /api/v1/setup": () => json(200, { needsSetup: true }) });
    renderPage(<LoginPage />, { locale: "zh" });
    expect(template("AuthPage")).not.toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: zh.login.title })).toBeTruthy();
    // 认证页也能切换语言：两种语言各一个链接，指向当前路径
    for (const name of [zh.common.localeName.zh, zh.common.localeName.en]) {
      expect(screen.getByRole("link", { name }).getAttribute("href")).toBe("/");
    }
    expect(
      screen.getByRole("link", { name: zh.common.localeName.zh }).getAttribute("aria-current"),
    ).toBe("true");
    expect(
      screen.getByRole("navigation", { name: zh.common.language }).getAttribute("aria-label"),
    ).toBe(zh.common.language);
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith("/setup"));
  });

  it("初始化页：AuthPage + 表单；已初始化时提示前往登录", async () => {
    stubApi({ "GET /api/v1/setup": () => json(200, { needsSetup: false }) });
    renderPage(<SetupPage />, { locale: "zh" });
    expect(template("AuthPage")).not.toBeNull();
    expect(screen.getByRole("link", { name: zh.common.localeName.en })).toBeTruthy();
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
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith("/"));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({
      login: "admin",
      password: "correct-horse-battery",
      displayName: "Admin",
    });
  });
});

describe("AppFrame（(app) 布局的 App Shell）", () => {
  function renderFrame(locale: "zh" | "en" = "zh") {
    return render(
      <NextIntlClientProvider locale={locale} messages={locale === "zh" ? zh : en}>
        <DesignProvider locale={locale} link={Link as LinkComponent}>
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

  it("the sidebar lists existing routes only; the status bar reads account@org:route and the version", async () => {
    resetNavigation("/agents/new");
    stubApi({ "GET /api/v1/me": () => json(200, ME) });
    renderFrame();
    expect(await screen.findByText("page body")).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "主导航" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((l) => [l.textContent, l.getAttribute("href")])).toEqual([
      // A new conversation starts at the composer (UI refresh B)
      ["新会话", "/chat"],
      [zh.nav.overview, "/"],
      [zh.nav.agents, "/agents"],
      [zh.nav.skills, "/skills"],
      [zh.nav.inbox, "/inbox"],
      [zh.nav.connectors, "/connectors"],
      // 企业目录：成员起
      [zh.nav.catalog, "/catalog"],
      // 管理员（owner）才看得到渠道与评测
      [zh.nav.channels, "/channels"],
      [zh.nav.evals, "/evals"],
      // Settings for everyone, after the main items
      [zh.nav.settings, "/settings/connections"],
      // 企业管理员（与组织角色无关）看得到「管理」
      [zh.nav.admin, "/admin"],
    ]);
    expect(
      within(nav).getByRole("link", { name: zh.nav.agents }).getAttribute("aria-current"),
    ).toBe("page");
    const status = screen.getByRole("contentinfo");
    expect(within(status).getByText("Grant@Acme:agents/new")).toBeTruthy();
    expect(within(status).getByText("v9.9.9")).toBeTruthy();
    expect(status.textContent).not.toContain(">");
  });

  it("普通成员的顶栏不显示管理员才能用的「渠道」", async () => {
    resetNavigation("/");
    stubApi({
      "GET /api/v1/me": () =>
        json(200, {
          ...ME,
          memberships: [{ orgId: "o1", slug: "acme", name: "Acme", role: "member" }],
        }),
      "GET /api/v1/orgs/o1/inbox": () => json(200, { items: [], truncated: false }),
    });
    renderFrame();
    expect(await screen.findByText("page body")).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "主导航" });
    expect(within(nav).queryByRole("link", { name: zh.nav.channels })).toBeNull();
    expect(within(nav).queryByRole("link", { name: zh.nav.evals })).toBeNull();
    expect(within(nav).getByRole("link", { name: zh.nav.connectors })).toBeTruthy();
    // 成员能浏览技能库
    expect(within(nav).getByRole("link", { name: zh.nav.skills })).toBeTruthy();
  });

  it("while /me is pending the conversation section is busy, without the empty hint (I2)", async () => {
    resetNavigation("/");
    stubApi({ "GET /api/v1/me": () => new Promise<Response>(() => {}) as unknown as Response });
    renderFrame();
    const region = screen.getByRole("region", { name: "会话" });
    expect(region.getAttribute("aria-busy")).toBe("true");
    expect(within(region).queryByText("还没有会话，从 Agents 里选一个开始。")).toBeNull();
  });

  it("memberships but no current org: the account reads 选择组织 (m3)", async () => {
    resetNavigation("/");
    stubApi({ "GET /api/v1/me": () => json(200, { ...ME, currentOrgId: null }) });
    renderFrame();
    expect(await screen.findByText("page body")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^账户: Grant · 选择组织/ })).toBeTruthy();
  });

  it("the group ＋ opens a new conversation with that agent picked", async () => {
    resetNavigation("/");
    stubApi({
      "GET /api/v1/me": () => json(200, ME),
      "GET /api/v1/orgs/o1/inbox": () => json(200, { items: [], truncated: false }),
      "GET /api/v1/orgs/o1/conversations/groups": () =>
        json(200, {
          groups: [
            {
              agent: { id: "a1", name: "研究助手" },
              latestAt: "2026-10-20T06:32:00.000Z",
              conversations: [],
              more: false,
            },
          ],
          next: null,
        }),
    });
    renderFrame();
    await userEvent.click(await screen.findByRole("button", { name: "与 研究助手 新建会话" }));
    await vi.waitFor(() => expect(router.push).toHaveBeenCalledWith("/chat?agent=a1"));
  });

  it("非企业管理员看不到一级导航「管理」（组织 owner 也不行）", async () => {
    resetNavigation("/");
    stubApi({
      "GET /api/v1/me": () =>
        json(200, { ...ME, account: { ...ME.account, isEnterpriseAdmin: false } }),
      "GET /api/v1/orgs/o1/inbox": () => json(200, { items: [], truncated: false }),
    });
    renderFrame();
    expect(await screen.findByText("page body")).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "主导航" });
    expect(within(nav).queryByRole("link", { name: zh.nav.admin })).toBeNull();
    expect(within(nav).getByRole("link", { name: zh.nav.evals })).toBeTruthy();
  });

  it("没有任何组织的企业管理员也看得到「管理」", async () => {
    resetNavigation("/");
    stubApi({
      "GET /api/v1/me": () => json(200, { ...ME, currentOrgId: null, memberships: [] }),
    });
    renderFrame();
    expect(await screen.findByText("page body")).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "主导航" });
    expect(within(nav).getByRole("link", { name: zh.nav.admin }).getAttribute("href")).toBe(
      "/admin",
    );
  });

  it("访客的顶栏不显示「技能」", async () => {
    resetNavigation("/");
    stubApi({
      "GET /api/v1/me": () =>
        json(200, {
          ...ME,
          memberships: [{ orgId: "o1", slug: "acme", name: "Acme", role: "guest" }],
        }),
      "GET /api/v1/orgs/o1/inbox": () => json(200, { items: [], truncated: false }),
    });
    renderFrame();
    expect(await screen.findByText("page body")).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "主导航" });
    expect(within(nav).queryByRole("link", { name: zh.nav.skills })).toBeNull();
    expect(within(nav).getByRole("link", { name: zh.nav.agents })).toBeTruthy();
  });

  it("未登录访问某页（401）：去登录页并带回该页", async () => {
    resetNavigation("/channels/c1");
    stubApi({
      "GET /api/v1/me": () => json(401, { error: { code: "auth.required", message: "x" } }),
      "POST /api/v1/auth/refresh": () =>
        json(401, { error: { code: "auth.refresh_invalid", message: "x" } }),
    });
    renderFrame();
    await vi.waitFor(() =>
      expect(router.replace).toHaveBeenCalledWith("/login?returnTo=%2Fchannels%2Fc1"),
    );
  });

  it.each(["zh", "en"] as const)(
    "顶栏「收件箱」带待处理数 Badge（收件箱汇总：工具审批 + 技能变更）（%s）",
    async (locale) => {
      const m = locale === "zh" ? zh : en;
      resetNavigation("/");
      stubApi({
        "GET /api/v1/me": () => json(200, ME),
        "GET /api/v1/orgs/o1/inbox": () =>
          json(200, {
            items: [
              { type: "tool_approval", id: "x" },
              { type: "skill_change", id: "y" },
            ],
            truncated: false,
          }),
      });
      renderFrame(locale);
      const nav = await screen.findByRole("navigation", {
        name: locale === "zh" ? "主导航" : "Main navigation",
      });
      await vi.waitFor(() =>
        expect(
          within(nav).getByRole("link", {
            name: locale === "zh" ? `${m.nav.inbox}，2 项待处理` : `${m.nav.inbox}, 2 pending`,
          }),
        ).toBeTruthy(),
      );
      expect(within(nav).getByRole("link", { name: m.nav.connectors })).toBeTruthy();
    },
  );

  it("收件箱被截断（truncated）：Badge 显示「<数量>+」", async () => {
    resetNavigation("/");
    stubApi({
      "GET /api/v1/me": () => json(200, ME),
      "GET /api/v1/orgs/o1/inbox": () =>
        json(200, {
          items: [
            { type: "tool_approval", id: "x" },
            { type: "skill_change", id: "y" },
          ],
          truncated: true,
        }),
    });
    renderFrame("en");
    const nav = await screen.findByRole("navigation", { name: "Main navigation" });
    const link = await within(nav).findByRole("link", { name: `${en.nav.inbox}, 2+ pending` });
    expect(within(link).getByText("2+")).toBeTruthy();
  });

  it("the account menu switches the org (current checked), and holds language, theme and sign out", async () => {
    const me = {
      ...ME,
      memberships: [...ME.memberships, { orgId: "o2", slug: "b", name: "Beta", role: "member" }],
    };
    const calls = stubApi({
      "GET /api/v1/me": () => json(200, me),
      "PUT /api/v1/me/current-org": () => new Response(null, { status: 204 }),
      "POST /api/v1/auth/logout": () => new Response(null, { status: 204 }),
    });
    renderFrame();
    await screen.findByText("page body");
    const user = userEvent.setup();
    const account = () =>
      screen.getByRole("button", { name: `账户: ${ME.account.displayName} · Acme` });
    await user.click(account());
    const current = await screen.findByRole("menuitemradio", { name: "Acme" });
    expect(current.getAttribute("aria-checked")).toBe("true");
    expect(current.querySelector("svg")).toBeTruthy();
    expect(current.textContent).toBe("Acme");
    await user.click(await screen.findByRole("menuitemradio", { name: "Beta" }));
    await vi.waitFor(() =>
      expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ orgId: "o2" }),
    );

    await user.click(account());
    expect(
      await screen.findByRole("menuitem", {
        name: zh.shell.switchLocale.replace("{name}", zh.common.localeName.en),
      }),
    ).toBeTruthy();
    await user.click(screen.getByRole("menuitem", { name: zh.shell.themeLight }));
    expect(document.documentElement.dataset.theme).toBe("light");

    await user.click(account());
    await user.click(await screen.findByRole("menuitem", { name: zh.common.logout }));
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith("/login"));
  });

  it("while the session loads: the content shows loading, the status bar no context", () => {
    stubApi({ "GET /api/v1/me": () => new Promise<Response>(() => {}) as unknown as Response });
    renderFrame();
    expect(screen.getAllByText(zh.common.loading).length).toBeGreaterThan(0);
    expect(within(screen.getByRole("main")).getByText(zh.common.loading)).toBeTruthy();
    const statusBar = screen.getByRole("contentinfo");
    expect(statusBar.textContent).not.toContain("@");
    expect(statusBar.textContent).toContain("v9.9.9");
    // 用户菜单在会话就绪前不可点击（不渲染空下拉）
    expect(screen.queryByRole("button", { name: /账户/ })).toBeNull();
  });

  it("服务端渲染不含时区（避免与浏览器时区不同导致的水合不一致）", () => {
    stubApi({ "GET /api/v1/me": () => json(200, ME) });
    const html = renderToString(
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
    expect(html).toContain("v9.9.9");
    expect(html).not.toContain("UTC");
  });

  it("不需要会话的内容（404）在服务端渲染时即输出，无需等待 /me", () => {
    const html = renderToString(
      <NextIntlClientProvider locale="zh" messages={zh}>
        <DesignProvider locale="zh" link={Link as LinkComponent}>
          <ToastProvider>
            <AppFrame version="v9.9.9">
              <NotFound />
            </AppFrame>
          </ToastProvider>
        </DesignProvider>
      </NextIntlClientProvider>,
    );
    expect(html).toContain('data-template="StatusPage"');
    expect(html).toContain('data-kind="404"');
  });

  it("未登录（401）时跳转到登录页", async () => {
    stubApi({
      "GET /api/v1/me": () => json(401, { error: { code: "auth.required", message: "x" } }),
      "POST /api/v1/auth/refresh": () =>
        json(401, { error: { code: "auth.refresh_invalid", message: "x" } }),
    });
    renderFrame();
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith("/login"));
    expect(screen.queryByText("page body")).toBeNull();
  });
});

describe("activeNavOf", () => {
  it("connectors light /connectors*; every /settings page is Settings; a conversation is none", () => {
    expect(activeNavOf("/connectors")).toBe("connectors");
    expect(activeNavOf("/connectors/x")).toBe("connectors");
    expect(activeNavOf("/connectors/install")).toBe("connectors");
    for (const p of [
      "/settings",
      "/settings/connections",
      "/settings/grants",
      "/settings/organization",
      "/settings/identities",
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
