import { DesignProvider, type LinkComponent, ToastProvider } from "@capybara-hq/design";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import CatchAllPage from "../src/app/(app)/[...rest]/page";
import NewAgentPage from "../src/app/(app)/agents/new/page";
import AgentsPage from "../src/app/(app)/agents/page";
import NotFound from "../src/app/(app)/not-found";
import HomePage from "../src/app/(app)/page";
import LoginPage from "../src/app/(auth)/login/page";
import SetupPage from "../src/app/(auth)/setup/page";
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
  const MODELS_READY = { providers: [{ provider: "model-fake", models: [{ id: "fake-1" }] }] };
  const AGENT = (id: string, name: string) => ({
    id,
    definition: { name, model: { provider: "model-fake", model: "fake-1" } },
  });
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  function overviewApi(over: Record<string, () => Response> = {}) {
    return stubApi({
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
      "POST /api/v1/orgs/o1/approvals/ap1/decision": () => json(200, { approval: { id: "ap1" } }),
      ...over,
    });
  }

  it("the overview: what waits on me (allow once in place), conversations to pick up, the org, my agents", async () => {
    const calls = overviewApi();
    renderPage(<HomePage />, { locale: "zh" });
    expect(template("OverviewPage")).not.toBeNull();
    const h = zh.home;
    expect(
      screen.getByRole("heading", { level: 1, name: h.greeting.replace("{name}", "Grant") }),
    ).toBeTruthy();
    const inbox = await screen.findByRole("list", { name: h.inbox.title });
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
    // allowing an approval in place sends "approve once" and reloads
    await user.click(
      within(rows[0] as HTMLElement).getByRole("button", { name: h.inbox.approveOnce }),
    );
    await vi.waitFor(() =>
      expect(calls.find((c) => c.method === "POST")?.body).toEqual({
        decision: "approve",
        scope: "once",
      }),
    );
    await vi.waitFor(() => expect(calls.filter((c) => c.url.endsWith("/inbox")).length).toBe(2));
  });

  it("the overview hides counts this role may not read", async () => {
    overviewApi({
      "GET /api/v1/orgs/o1/members": () => json(403, { error: { code: "forbidden" } }),
    });
    renderPage(<HomePage />);
    await screen.findByRole("list", { name: en.home.inbox.title });
    expect(screen.queryByText(en.home.members)).toBeNull();
    expect(screen.getByText(en.home.skills)).toBeTruthy();
  });

  it("before a model and an agent exist the overview is the setup checklist", async () => {
    overviewApi({
      "GET /api/v1/orgs/o1/agents": () => json(200, { agents: [] }),
      "GET /api/v1/orgs/o1/inbox": () => json(200, { items: [], truncated: false }),
      "GET /api/v1/orgs/o1/conversations/groups": () => json(200, { groups: [], next: null }),
    });
    renderPage(<HomePage />, { locale: "zh" });
    const h = zh.home;
    expect(await screen.findByText(h.setup.title)).toBeTruthy();
    expect(screen.getByText("已完成 2 / 3")).toBeTruthy();
    const step = (label: string) => screen.getByText(label).closest("li") as HTMLElement;
    expect(step(h.setup.org).getAttribute("data-state")).toBe("done");
    expect(step(zh.chat.setup.model.label).getAttribute("data-state")).toBe("done");
    expect(step(zh.chat.setup.agent.label).getAttribute("data-state")).toBe("todo");
    const later = within(screen.getByRole("list", { name: h.setup.later }));
    expect(later.getByRole("link", { name: h.setup.inviteMembers }).getAttribute("href")).toBe(
      "/settings/members",
    );
    expect(screen.queryByRole("list", { name: h.inbox.title })).toBeNull();
  });

  it("a page that needs an organization keeps its own title and offers creating one", () => {
    resetNavigation("/agents");
    renderPage(<AgentsPage />, {
      locale: "zh",
      me: { ...ME, currentOrgId: null, memberships: [], canCreateOrg: true },
    });
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(zh.nav.agents);
    expect(screen.getByText("还没有加入任何组织")).toBeTruthy();
    expect(screen.getByRole("button", { name: zh.home.createOrg.open })).toBeTruthy();
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
    const calls = stubApi({
      "GET /api/v1/orgs/o1/agents": () => json(200, { agents: [agentRow("ag1", "Echo agent")] }),
    });
    renderPage(<AgentsPage />, { locale: "zh" });
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
    stubApi({
      "GET /api/v1/orgs/o1/agents": () =>
        json(200, {
          agents: [
            agentRow("ag1", "Alpha"),
            agentRow("ag2", "Beta", { ownerAccountId: ME.account.id, visibility: "private" }),
            agentRow("ag3", "Gamma", { ownerAccountId: ME.account.id }),
          ],
        }),
    });
    renderPage(<AgentsPage />, { locale: "en" });
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
    stubApi({ "GET /api/v1/orgs/o1/agents": () => json(200, { agents: [] }) });
    renderPage(<AgentsPage />);
    expect(await screen.findByText(en.agents.empty)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getAllByRole("link", { name: en.agents.new }).length).toBeGreaterThan(0);
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
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith("/setup"));
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
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith("/"));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({
      login: "admin",
      password: "correct-horse-battery",
      displayName: "Admin",
    });
  });
});

describe("AppFrame（(app) 布局的 App Shell）", () => {
  /** Opens the sidebar's 更多 group (collapsed unless the current page is inside it). */
  function openMore(nav: HTMLElement, name = "更多") {
    const more = within(nav).getByRole("button", { name });
    if (more.getAttribute("aria-expanded") === "false") fireEvent.click(more);
  }

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
    openMore(nav);
    const links = within(nav).getAllByRole("link");
    expect(links.map((l) => [l.textContent, l.getAttribute("href")])).toEqual([
      // A new conversation starts at the composer (UI refresh B)
      ["新会话", "/chat"],
      [zh.nav.overview, "/"],
      [zh.nav.inbox, "/inbox"],
      [zh.nav.agents, "/agents"],
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
    openMore(nav);
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
    expect(within(region).queryByText("还没有会话")).toBeNull();
  });

  it("signed in without a current org: the chooser covers the whole shell; opening an org enters the app", async () => {
    resetNavigation("/");
    const me = {
      ...ME,
      currentOrgId: null,
      memberships: [...ME.memberships, { orgId: "o2", slug: "b", name: "Beta", role: "member" }],
    };
    let current: string | null = null;
    const calls = stubApi({
      "GET /api/v1/me": () => json(200, { ...me, currentOrgId: current }),
      "PUT /api/v1/me/current-org": (init) => {
        current = (JSON.parse(String(init?.body)) as { orgId: string }).orgId;
        return new Response(null, { status: 204 });
      },
      "GET /api/v1/orgs/o2/inbox": () => json(200, { items: [], truncated: false }),
      "GET /api/v1/orgs/o2/conversations/groups": () => json(200, { groups: [], next: null }),
    });
    renderFrame();
    const c = zh.orgChooser;
    expect(await screen.findByRole("heading", { name: c.title })).toBeTruthy();
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
    expect(await screen.findByText("page body")).toBeTruthy();
    expect(calls.find((x) => x.method === "PUT")?.body).toEqual({ orgId: "o2" });
    expect(screen.getByRole("button", { name: "当前组织：Beta，切换组织" })).toBeTruthy();
  });

  it("no org at all: the chooser creates one and enters it", async () => {
    resetNavigation("/");
    let me: typeof ME = { ...ME, currentOrgId: null, memberships: [] };
    const calls = stubApi({
      "GET /api/v1/me": () => json(200, me),
      "POST /api/v1/orgs": () => {
        me = { ...me, memberships: [{ orgId: "o9", slug: "new", name: "New", role: "owner" }] };
        return json(201, { org: { id: "o9", slug: "new", name: "New" }, role: "owner" });
      },
      "PUT /api/v1/me/current-org": () => {
        me = { ...me, currentOrgId: "o9" };
        return new Response(null, { status: 204 });
      },
      "GET /api/v1/orgs/o9/inbox": () => json(200, { items: [], truncated: false }),
      "GET /api/v1/orgs/o9/conversations/groups": () => json(200, { groups: [], next: null }),
    });
    renderFrame();
    const c = zh.orgChooser;
    expect(await screen.findByRole("heading", { name: c.titleNone })).toBeTruthy();
    expect(screen.queryByRole("list", { name: c.listLabel })).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: c.create }));
    const dialog = await screen.findByRole("dialog", { name: zh.home.createOrg.title });
    await user.type(within(dialog).getByRole("textbox"), "New");
    await user.click(within(dialog).getByRole("button", { name: zh.home.createOrg.submit }));
    expect(await screen.findByText("page body")).toBeTruthy();
    expect(calls.filter((x) => x.method !== "GET").map((x) => [x.method, x.url])).toEqual([
      ["POST", "/api/v1/orgs"],
      ["PUT", "/api/v1/me/current-org"],
    ]);
  });

  it("no org and not allowed to create one: the chooser says to ask for an invitation", async () => {
    resetNavigation("/");
    stubApi({
      "GET /api/v1/me": () =>
        json(200, {
          ...ME,
          account: { ...ME.account, isEnterpriseAdmin: false },
          currentOrgId: null,
          memberships: [],
          canCreateOrg: false,
        }),
    });
    renderFrame();
    expect(await screen.findByText(zh.orgChooser.askHint)).toBeTruthy();
    expect(screen.queryByRole("button", { name: zh.orgChooser.create })).toBeNull();
    expect(screen.queryByRole("link", { name: zh.orgChooser.admin })).toBeNull();
    expect(screen.getByRole("button", { name: zh.orgChooser.logout })).toBeTruthy();
  });

  it("the account menu's Organization submenu ends with Create organization", async () => {
    resetNavigation("/");
    stubApi({
      "GET /api/v1/me": () => json(200, ME),
      "GET /api/v1/orgs/o1/inbox": () => json(200, { items: [], truncated: false }),
      "GET /api/v1/orgs/o1/conversations/groups": () => json(200, { groups: [], next: null }),
    });
    renderFrame();
    await screen.findByText("page body");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^账户: Grant/ }));
    await user.click(screen.getByRole("menuitem", { name: zh.shell.orgMenu }));
    // jsdom has no layout: pick submenu items with the keyboard (see design menu-submenu tests)
    (await screen.findByRole("menuitem", { name: zh.shell.createOrg })).focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("dialog", { name: zh.home.createOrg.title })).toBeTruthy();
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
    expect(screen.queryByRole("link", { name: "管理后台" })).toBeNull();
    openMore(nav);
    expect(within(nav).getByRole("link", { name: zh.nav.evals })).toBeTruthy();
  });

  it("an enterprise admin without an org still reaches the admin console in the shell", async () => {
    resetNavigation("/admin");
    stubApi({
      "GET /api/v1/me": () => json(200, { ...ME, currentOrgId: null, memberships: [] }),
    });
    renderFrame();
    expect(await screen.findByText("page body")).toBeTruthy();
    // the admin context: its items, the current one marked
    const nav = screen.getByRole("navigation", { name: "主导航" });
    const overview = within(nav).getByRole("link", { name: zh.admin.nav.overview });
    expect(overview.getAttribute("href")).toBe("/admin");
    expect(overview.getAttribute("aria-current")).toBe("page");
    expect(screen.queryByRole("region", { name: "会话" })).toBeNull();
  });

  it("a person who is not an enterprise admin keeps the workspace sidebar under /admin", async () => {
    resetNavigation("/admin/accounts");
    stubApi({
      "GET /api/v1/me": () =>
        json(200, { ...ME, account: { ...ME.account, isEnterpriseAdmin: false } }),
      "GET /api/v1/orgs/o1/inbox": () => json(200, { items: [], truncated: false }),
    });
    renderFrame();
    expect(await screen.findByText("page body")).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "主导航" });
    // the 403 page stands beside the workspace sidebar, never the admin context
    expect(within(nav).queryByRole("link", { name: zh.admin.nav.overview })).toBeNull();
    expect(within(nav).getByRole("link", { name: zh.nav.agents })).toBeTruthy();
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
      openMore(nav, locale === "zh" ? "更多" : "More");
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

  it("the account menu holds Organization ▸ and Language ▸ above sign-out; the theme switch follows the account", async () => {
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
