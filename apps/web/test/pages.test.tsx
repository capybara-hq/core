import { DesignProvider, type LinkComponent, ToastProvider } from "@capybara-hq/design";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import NewAgentPage from "../src/app/[locale]/(app)/agents/new/page";
import AgentsPage from "../src/app/[locale]/(app)/agents/page";
import NotFound from "../src/app/[locale]/(app)/not-found";
import HomePage from "../src/app/[locale]/(app)/page";
import LoginPage from "../src/app/[locale]/(auth)/login/page";
import SetupPage from "../src/app/[locale]/(auth)/setup/page";
import { AppFrame } from "../src/components/shell/AppFrame";
import { Link, resetNavigation, router } from "./support/navigation";
import { ME, renderPage } from "./support/render";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));

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

  it("Agents 页：空状态带「新建 Agent」", async () => {
    stubApi({ "GET /api/v1/orgs/o1/agents": () => json(200, { agents: [] }) });
    renderPage(<AgentsPage />);
    expect(await screen.findByText(en.agents.empty)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: en.agents.new }));
    expect(router.push).toHaveBeenCalledWith("/agents/new");
  });

  it("需要组织的页面在未选组织时显示 StatusPage disabled", () => {
    renderPage(<NewAgentPage />, { me: { ...ME, currentOrgId: null } });
    expect(template("StatusPage")?.getAttribute("data-kind")).toBe("disabled");
    expect(screen.getByRole("heading", { level: 2, name: en.agents.noOrg })).toBeTruthy();
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
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith("/setup"));
  });

  it("初始化页：AuthPage + 表单；已初始化时提示前往登录", async () => {
    stubApi({ "GET /api/v1/setup": () => json(200, { needsSetup: false }) });
    renderPage(<SetupPage />, { locale: "zh" });
    expect(template("AuthPage")).not.toBeNull();
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
              <p>page body</p>
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
    ]);
    expect(
      within(nav).getByRole("link", { name: zh.nav.agents }).getAttribute("aria-current"),
    ).toBe("page");
    expect(screen.getByText("> Grant@Acme:agents/new")).toBeTruthy();
    expect(screen.getByText(/^v9\.9\.9/)).toBeTruthy();
  });

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
    await user.click(screen.getByRole("button", { name: "组织" }));
    await user.click(await screen.findByRole("menuitem", { name: "Beta" }));
    await vi.waitFor(() =>
      expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ orgId: "o2" }),
    );

    await user.click(screen.getByRole("button", { name: "账户" }));
    expect(
      await screen.findByRole("menuitem", {
        name: zh.shell.switchLocale.replace("{name}", zh.common.localeName.en),
      }),
    ).toBeTruthy();
    await user.click(screen.getByRole("menuitem", { name: zh.shell.themeLight }));
    expect(document.documentElement.dataset.theme).toBe("light");

    await user.click(screen.getByRole("button", { name: "账户" }));
    await user.click(await screen.findByRole("menuitem", { name: zh.common.logout }));
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith("/login"));
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
