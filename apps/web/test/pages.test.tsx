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
    await vi.waitFor(() => expect(router.push).toHaveBeenCalledWith("/chat/c%201"));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ agentId: "ag1" });
  });

  const oneAgent = () =>
    json(200, {
      agents: [
        { id: "ag1", definition: { name: "Echo agent", model: { provider: "p", model: "m" } } },
      ],
    });

  it("Agents 页：点击行即开始对话；创建期间该行置灰并显示进度，重复点击不再创建", async () => {
    let resolve: (r: Response) => void = () => {};
    const calls = stubApi({
      "GET /api/v1/orgs/o1/agents": oneAgent,
      "POST /api/v1/orgs/o1/conversations": () =>
        new Promise<Response>((r) => {
          resolve = r;
        }) as unknown as Response,
    });
    renderPage(<AgentsPage />, { locale: "zh" });
    const user = userEvent.setup();
    await user.click(await screen.findByText("Echo agent"));
    const row = await screen.findByText(`Echo agent · ${zh.agents.starting}`);
    expect(row.closest("tr")?.getAttribute("data-state")).toContain("disabled");
    await user.click(row);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    resolve(json(201, { conversation: { id: "c2" } }));
    await vi.waitFor(() => expect(router.push).toHaveBeenCalledWith("/chat/c2"));
  });

  it("Agents 页：行获得焦点后按 Enter 开始对话", async () => {
    stubApi({
      "GET /api/v1/orgs/o1/agents": oneAgent,
      "POST /api/v1/orgs/o1/conversations": () => json(201, { conversation: { id: "c3" } }),
    });
    renderPage(<AgentsPage />, { locale: "zh" });
    const cell = await screen.findByText("Echo agent");
    cell.closest("tr")?.focus();
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(router.push).toHaveBeenCalledWith("/chat/c3"));
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

  it("顶栏只列已存在的路由；状态栏 `> 账号@组织:路由` 与版本", async () => {
    resetNavigation("/agents/new");
    stubApi({ "GET /api/v1/me": () => json(200, ME) });
    renderFrame();
    expect(await screen.findByText("page body")).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "主导航" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((l) => [l.textContent, l.getAttribute("href")])).toEqual([
      [zh.nav.overview, "/"],
      [zh.nav.agents, "/agents"],
      [zh.nav.inbox, "/inbox"],
      [zh.nav.apps, "/apps"],
    ]);
    expect(
      within(nav).getByRole("link", { name: zh.nav.agents }).getAttribute("aria-current"),
    ).toBe("page");
    expect(screen.getByText("> Grant@Acme:agents/new")).toBeTruthy();
    expect(screen.getByText(/^v9\.9\.9/)).toBeTruthy();
  });

  it.each(["zh", "en"] as const)(
    "顶栏「收件箱」带待处理审批数 Badge（当前组织的 pending 审批）（%s）",
    async (locale) => {
      const m = locale === "zh" ? zh : en;
      resetNavigation("/");
      stubApi({
        "GET /api/v1/me": () => json(200, ME),
        "GET /api/v1/orgs/o1/approvals": () => json(200, { approvals: [{ id: "x" }, { id: "y" }] }),
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
      expect(within(nav).getByRole("link", { name: m.nav.apps })).toBeTruthy();
    },
  );

  it("组织菜单切换当前组织；用户菜单含语言、主题与退出登录", async () => {
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
    await user.click(screen.getByRole("button", { name: "组织: Acme" }));
    await user.click(await screen.findByRole("menuitem", { name: "Beta" }));
    await vi.waitFor(() =>
      expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ orgId: "o2" }),
    );

    await user.click(screen.getByRole("button", { name: `账户: ${ME.account.displayName}` }));
    expect(
      await screen.findByRole("menuitem", {
        name: zh.shell.switchLocale.replace("{name}", zh.common.localeName.en),
      }),
    ).toBeTruthy();
    await user.click(screen.getByRole("menuitem", { name: zh.shell.themeLight }));
    expect(document.documentElement.dataset.theme).toBe("light");

    await user.click(screen.getByRole("button", { name: `账户: ${ME.account.displayName}` }));
    await user.click(await screen.findByRole("menuitem", { name: zh.common.logout }));
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith("/login"));
  });

  it("会话加载中：内容区显示加载中，状态栏不显示 `>` 上下文", () => {
    stubApi({ "GET /api/v1/me": () => new Promise<Response>(() => {}) as unknown as Response });
    renderFrame();
    expect(screen.getAllByText(zh.common.loading).length).toBeGreaterThan(0);
    expect(within(screen.getByRole("main")).getByText(zh.common.loading)).toBeTruthy();
    const statusBar = screen.getByRole("contentinfo");
    expect(statusBar.textContent).not.toContain(">");
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
  it("应用只高亮 /apps*、/settings/connections、/settings/grants、/settings/organization；其他 /settings 不高亮", () => {
    expect(activeNavOf("/apps")).toBe("apps");
    expect(activeNavOf("/apps/x")).toBe("apps");
    expect(activeNavOf("/settings/connections")).toBe("apps");
    expect(activeNavOf("/settings/grants")).toBe("apps");
    expect(activeNavOf("/settings/organization")).toBe("apps");
    expect(activeNavOf("/apps/install")).toBe("apps");
    expect(activeNavOf("/settings/org")).toBe("");
    expect(activeNavOf("/settings")).toBe("");
    expect(activeNavOf("/appsx")).toBe("");
    expect(activeNavOf("/inbox")).toBe("inbox");
    expect(activeNavOf("/chat/c1")).toBe("agents");
  });
});
