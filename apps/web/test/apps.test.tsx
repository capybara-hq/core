import { DesignProvider, type LinkComponent, ToastProvider } from "@capybara-hq/design";
import { act, cleanup, render, renderHook, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import NewAgentPage from "../src/app/[locale]/(app)/agents/new/page";
import AppDetailPage from "../src/app/[locale]/(app)/apps/[appId]/page";
import AppsPage from "../src/app/[locale]/(app)/apps/page";
import ConnectionsPage from "../src/app/[locale]/(app)/settings/connections/page";
import { AppFrame } from "../src/components/shell/AppFrame";
import type { Me } from "../src/lib/session";
import { useLoad } from "../src/lib/use-load";
import { bodyOf, json, noContent, stubApi } from "./support/api";
import { Link, resetNavigation, router } from "./support/navigation";
import { ME, renderPage } from "./support/render";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("next/navigation", () => ({ useParams: () => ({ appId: "app1" }) }));

const msgs = { zh, en } as const;
const LOCALES = ["zh", "en"] as const;
const T = "2026-10-19T12:00:00.000Z";
const MEMBER: Me = {
  ...ME,
  memberships: [{ orgId: "o1", slug: "acme", name: "Acme", role: "member" }],
};

const summary = (over: Record<string, unknown> = {}) => ({
  id: "app1",
  slug: "fixture",
  name: "Fixture",
  connector: "mcp",
  endpoint: { url: "http://127.0.0.1:9/mcp" },
  auth: { type: "none" },
  status: "active",
  createdAt: T,
  updatedAt: T,
  ...over,
});

const tool = (name: string, over: Record<string, unknown> = {}) => ({
  name,
  key: `fixture__${name}`,
  description: `${name} things`,
  inputSchema: {},
  annotations: null,
  status: "enabled",
  defaultPolicy: "ask",
  specHash: "h",
  issue: null,
  source: "connector",
  ...over,
});

const detail = (over: Record<string, unknown> = {}) => ({
  ...summary(),
  tools: [tool("search", { defaultPolicy: "allow" }), tool("delete_item")],
  credential: { ownership: null, status: "connected" },
  ...over,
});

beforeEach(() => resetNavigation("/apps"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("应用列表（ListPage）", () => {
  it.each(LOCALES)("列出应用；管理员有「添加应用」，点击行进入详情（%s）", async (locale) => {
    const m = msgs[locale];
    stubApi({ "GET /api/v1/orgs/o1/apps": () => json(200, { apps: [summary()] }) });
    const { container } = renderPage(<AppsPage />, { locale });
    expect(container.querySelector('[data-template="ListPage"]')).not.toBeNull();
    const table = await screen.findByRole("table", { name: m.apps.title });
    expect(within(table).getByText("Fixture")).toBeTruthy();
    expect(within(table).getByText(m.apps.auth.none)).toBeTruthy();
    expect(screen.getByRole("link", { name: m.apps.new }).getAttribute("href")).toBe(
      "/apps/install",
    );
    await userEvent.setup().click(within(table).getByText("Fixture"));
    expect(router.push).toHaveBeenCalledWith("/apps/app1");
  });

  it("普通成员看不到「添加应用」；空状态", async () => {
    stubApi({ "GET /api/v1/orgs/o1/apps": () => json(200, { apps: [] }) });
    renderPage(<AppsPage />, { me: MEMBER });
    expect(await screen.findByText(en.apps.empty)).toBeTruthy();
    expect(screen.queryByRole("link", { name: en.apps.new })).toBeNull();
    expect(screen.queryByRole("button", { name: en.apps.new })).toBeNull();
  });
});

describe("应用详情（DetailPage）", () => {
  it.each(LOCALES)("工具页签：改默认策略与启停 → PATCH tools（%s）", async (locale) => {
    const m = msgs[locale];
    const calls = stubApi({
      "GET /api/v1/orgs/o1/apps/app1": () => json(200, { app: detail() }),
      "PATCH /api/v1/orgs/o1/apps/app1": (c) => {
        const body = bodyOf(c) as { tools: Record<string, Record<string, string>> };
        const patch = body.tools.delete_item ?? {};
        return json(200, {
          app: detail({
            tools: [tool("search", { defaultPolicy: "allow" }), tool("delete_item", patch)],
          }),
        });
      },
    });
    const { container } = renderPage(<AppDetailPage />, { locale });
    expect(container.querySelector('[data-template="DetailPage"]')).not.toBeNull();
    const policy = await screen.findByRole("combobox", {
      name: m.apps.tools.policyLabel.replace("{tool}", "fixture__delete_item"),
    });
    const tabs = screen.getByRole("tablist", { name: m.apps.detail.tabsLabel });
    expect(
      within(tabs)
        .getAllByRole("tab")
        .map((x) => x.textContent),
    ).toEqual([
      `${m.apps.detail.tabs.tools}2`,
      m.apps.detail.tabs.review,
      m.apps.detail.tabs.credentials,
      m.apps.detail.tabs.settings,
    ]);
    const user = userEvent.setup();
    await user.selectOptions(policy, "deny");
    expect(bodyOf(calls.find((c) => c.method === "PATCH"))).toEqual({
      tools: { delete_item: { defaultPolicy: "deny" } },
    });
    await user.click(
      screen.getByRole("switch", {
        name: m.apps.tools.enabledLabel.replace("{tool}", "fixture__delete_item"),
      }),
    );
    expect(bodyOf(calls.filter((c) => c.method === "PATCH")[1])).toEqual({
      tools: { delete_item: { status: "disabled" } },
    });
    // inspector
    const inspector = screen.getByRole("complementary");
    expect(within(inspector).getByText("http://127.0.0.1:9/mcp")).toBeTruthy();
  });

  it.each(LOCALES)(
    "凭据页签：组织凭据未设置 → 填令牌保存 PUT credentials/org（%s）",
    async (locale) => {
      const m = msgs[locale];
      const calls = stubApi({
        "GET /api/v1/orgs/o1/apps/app1": () =>
          json(200, {
            app: detail({
              auth: { type: "bearer", ownership: "org" },
              credential: { ownership: "org", status: "missing" },
            }),
          }),
        "PUT /api/v1/orgs/o1/apps/app1/credentials/org": () => noContent(),
      });
      renderPage(<AppDetailPage />, { locale });
      const user = userEvent.setup();
      await user.click(await screen.findByRole("tab", { name: m.apps.detail.tabs.credentials }));
      expect(screen.getByText(`‖ ${m.apps.credential.missing}`)).toBeTruthy();
      await user.type(screen.getByLabelText(m.apps.form.tokenLabel), "tok");
      await user.click(screen.getByRole("button", { name: m.apps.credential.save }));
      const put = calls.find((c) => c.method === "PUT");
      expect(bodyOf(put)).toEqual({ token: "tok" });
      expect(calls.filter((c) => c.method === "GET")).toHaveLength(2);
      // 保存成功后清空输入框（凭据值不留在页面上）
      await vi.waitFor(() =>
        expect(screen.getByLabelText(m.apps.form.tokenLabel)).toHaveProperty("value", ""),
      );
    },
  );

  it.each(LOCALES)(
    "设置页签：删除需输入应用名确认（DangerConfirm），删除后回到列表（%s）",
    async (locale) => {
      const m = msgs[locale];
      const calls = stubApi({
        "GET /api/v1/orgs/o1/apps/app1": () => json(200, { app: detail() }),
        "DELETE /api/v1/orgs/o1/apps/app1": () => noContent(),
      });
      renderPage(<AppDetailPage />, { locale });
      const user = userEvent.setup();
      await user.click(await screen.findByRole("tab", { name: m.apps.detail.tabs.settings }));
      await user.click(screen.getByRole("button", { name: m.apps.settings.delete }));
      const dialog = await screen.findByRole("dialog");
      const confirm = within(dialog).getByRole("button", { name: m.apps.settings.delete });
      expect(confirm).toHaveProperty("disabled", true);
      await user.type(within(dialog).getByRole("textbox"), "Fixture");
      await user.click(confirm);
      expect(calls.some((c) => c.method === "DELETE")).toBe(true);
      await vi.waitFor(() => expect(router.push).toHaveBeenCalledWith("/apps"));
    },
  );

  it("普通成员：工具策略只读，没有删除", async () => {
    stubApi({ "GET /api/v1/orgs/o1/apps/app1": () => json(200, { app: detail() }) });
    renderPage(<AppDetailPage />, { me: MEMBER });
    expect(await screen.findByText(en.apps.policy.allow)).toBeTruthy();
    expect(screen.queryByRole("combobox")).toBeNull();
    await userEvent.setup().click(screen.getByRole("tab", { name: en.apps.detail.tabs.settings }));
    expect(screen.queryByRole("button", { name: en.apps.settings.delete })).toBeNull();
  });
});

describe("应用详情：复核页签（漂移检测）", () => {
  const changed = tool("getPet", {
    key: "fixture__getPet",
    status: "pending_review",
    description: "Get a pet",
    inputSchema: { type: "object", properties: { id: { type: "integer" } } },
    annotations: { readOnlyHint: true },
    connectorData: { method: "get", path: "/pets/{petId}" },
    reviewedAt: T,
    pending: {
      description: "Get a pet (v2)",
      inputSchema: { type: "object", properties: { id: { type: "string" } } },
      annotations: { readOnlyHint: true },
      connectorData: { method: "get", path: "/animals/{petId}" },
      specHash: "h2",
    },
  });
  const added = tool("newOne", {
    key: "fixture__newOne",
    status: "pending_review",
    description: "Brand new",
    connectorData: null,
    reviewedAt: null,
    pending: null,
  });
  const gone = tool("oldOne", { key: "fixture__oldOne", status: "disabled", missing: true });

  it.each(LOCALES)(
    "列出新旧定义（描述、inputSchema、注解、路由数据）；批准 / 拒绝 → POST review（%s）",
    async (locale) => {
      const m = msgs[locale];
      const r = m.apps.review;
      let tools = [changed, added, gone, tool("search")];
      const calls = stubApi({
        "GET /api/v1/orgs/o1/apps/app1": () => json(200, { app: detail({ tools }) }),
        "POST /api/v1/orgs/o1/apps/app1/tools/getPet/review": () => {
          tools = tools.map((x) =>
            x.name === "getPet" ? { ...x, status: "enabled", pending: null } : x,
          );
          return json(200, { app: detail({ tools }) });
        },
        "POST /api/v1/orgs/o1/apps/app1/tools/newOne/review": () =>
          json(409, { error: { code: "app.tool_not_pending", message: "x" } }),
      });
      renderPage(<AppDetailPage />, { locale });
      const user = userEvent.setup();
      // 工具页签：待复核的工具显示状态而不是开关；不再提供的工具标注出来
      expect(await screen.findAllByText(`‖ ${m.apps.tools.pendingReview}`)).toHaveLength(2);
      expect(screen.getByText(m.apps.tools.missing)).toBeTruthy();
      expect(
        screen.getByRole("switch", {
          name: m.apps.tools.enabledLabel.replace("{tool}", "fixture__oldOne"),
        }),
      ).toHaveProperty("disabled", true);
      await user.click(screen.getByRole("tab", { name: `${m.apps.detail.tabs.review}2` }));

      const card = screen.getByRole("region", { name: "fixture__getPet" });
      expect(within(card).getByText(`‖ ${r.changedTool}`)).toBeTruthy();
      const field = (label: string, side: "current" | "new") =>
        within(card).getByRole("textbox", { name: `${label} · ${r[side]}` }) as HTMLTextAreaElement;
      expect(field(r.description, "current").value).toBe("Get a pet");
      expect(field(r.description, "new").value).toBe("Get a pet (v2)");
      expect(field(r.inputSchema, "current").value).toContain('"type": "integer"');
      expect(field(r.inputSchema, "new").value).toContain('"type": "string"');
      expect(field(r.inputSchema, "new").readOnly).toBe(true);
      expect(field(r.connectorData, "current").value).toContain("/pets/{petId}");
      expect(field(r.connectorData, "new").value).toContain("/animals/{petId}");
      // 有变化的项标出来，注解没变不标
      expect(within(card).getByText(r.changed.replace("{field}", r.connectorData))).toBeTruthy();
      expect(within(card).queryByText(r.changed.replace("{field}", r.annotations))).toBeNull();

      // 新工具：只有新定义
      const fresh = screen.getByRole("region", { name: "fixture__newOne" });
      expect(within(fresh).getByText(`‖ ${r.newTool}`)).toBeTruthy();
      expect(
        (
          within(fresh).getByRole("textbox", {
            name: `${r.description} · ${r.new}`,
          }) as HTMLTextAreaElement
        ).value,
      ).toBe("Brand new");
      expect(
        within(fresh).queryByRole("textbox", { name: `${r.description} · ${r.current}` }),
      ).toBeNull();

      // 不再提供的工具
      expect(screen.getByText("‖ fixture__oldOne")).toBeTruthy();

      await user.click(
        within(card).getByRole("button", {
          name: r.approveLabel.replace("{tool}", "fixture__getPet"),
        }),
      );
      expect(bodyOf(calls.find((c) => c.url.endsWith("/tools/getPet/review")))).toEqual({
        action: "approve",
      });
      await vi.waitFor(() =>
        expect(screen.queryByRole("region", { name: "fixture__getPet" })).toBeNull(),
      );
      await user.click(
        screen.getByRole("button", { name: r.rejectLabel.replace("{tool}", "fixture__newOne") }),
      );
      expect(bodyOf(calls.find((c) => c.url.endsWith("/tools/newOne/review")))).toEqual({
        action: "reject",
      });
      expect(await screen.findByText(m.errors.app.tool_not_pending)).toBeTruthy();
    },
  );

  it("普通成员：只看对比，没有批准 / 拒绝；没有待复核时显示空状态", async () => {
    stubApi({
      "GET /api/v1/orgs/o1/apps/app1": () => json(200, { app: detail({ tools: [added] }) }),
    });
    renderPage(<AppDetailPage />, { me: MEMBER });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: `${en.apps.detail.tabs.review}1` }));
    expect(screen.getByRole("region", { name: "fixture__newOne" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: en.apps.review.approve })).toBeNull();
    cleanup();
    stubApi({ "GET /api/v1/orgs/o1/apps/app1": () => json(200, { app: detail() }) });
    renderPage(<AppDetailPage />);
    await user.click(await screen.findByRole("tab", { name: en.apps.detail.tabs.review }));
    expect(screen.getByText(en.apps.review.empty)).toBeTruthy();
  });
});

describe("应用详情：OAuth 客户端轮换", () => {
  it.each(LOCALES)(
    "客户端凭据流：填 client id 与密钥（密码框）→ PUT credentials/org；成功后清空（%s）",
    async (locale) => {
      const m = msgs[locale];
      const calls = stubApi({
        "GET /api/v1/orgs/o1/apps/app1": () =>
          json(200, {
            app: detail({
              auth: { type: "oauth_client", ownership: "org", tokenUrl: "https://a/token" },
              credential: { ownership: "org", status: "connected" },
            }),
          }),
        "PUT /api/v1/orgs/o1/apps/app1/credentials/org": () => noContent(),
      });
      renderPage(<AppDetailPage />, { locale });
      const user = userEvent.setup();
      await user.click(await screen.findByRole("tab", { name: m.apps.detail.tabs.credentials }));
      expect(screen.getByText(m.apps.credential.rotateVerified)).toBeTruthy();
      const rotate = screen.getByRole("button", { name: m.apps.credential.rotate });
      expect(rotate).toHaveProperty("disabled", true);
      await user.type(screen.getByRole("textbox", { name: m.apps.oauth.clientIdLabel }), "cid2");
      // 客户端凭据流必须带密钥
      expect(rotate).toHaveProperty("disabled", true);
      const secret = screen.getByLabelText(new RegExp(`^${m.apps.oauth.clientSecretLabel}`));
      expect(secret.getAttribute("type")).toBe("password");
      await user.type(secret, "sec2");
      await user.click(rotate);
      expect(bodyOf(calls.find((c) => c.method === "PUT"))).toEqual({
        clientId: "cid2",
        clientSecret: "sec2",
      });
      await vi.waitFor(() => expect(secret).toHaveProperty("value", ""));
    },
  );

  it.each(LOCALES)(
    "授权码流（手填客户端）：提示新客户端不验证、填错会让所有成员重连；自动注册的客户端不能替换（%s）",
    async (locale) => {
      const m = msgs[locale];
      const code = (client: "manual" | "dcr") => ({
        type: "oauth_code",
        ownership: "personal",
        discovery: "mcp",
        client,
      });
      let client: "manual" | "dcr" = "manual";
      const calls = stubApi({
        "GET /api/v1/orgs/o1/apps/app1": () =>
          json(200, {
            app: detail({
              auth: code(client),
              credential: { ownership: "personal", status: "missing" },
            }),
          }),
        "PUT /api/v1/orgs/o1/apps/app1/credentials/org": () => noContent(),
      });
      const { container } = renderPage(<AppDetailPage />, { locale });
      const user = userEvent.setup();
      await user.click(await screen.findByRole("tab", { name: m.apps.detail.tabs.credentials }));
      expect(screen.getByText(m.apps.credential.rotateUnverified)).toBeTruthy();
      expect(screen.getByText(m.apps.credential.personalHint)).toBeTruthy();
      expect(container.querySelectorAll('[data-variant="primary"]').length).toBeLessThanOrEqual(1);
      await user.type(screen.getByRole("textbox", { name: m.apps.oauth.clientIdLabel }), "pub");
      await user.click(screen.getByRole("button", { name: m.apps.credential.rotate }));
      expect(bodyOf(calls.find((c) => c.method === "PUT"))).toEqual({ clientId: "pub" });

      cleanup();
      client = "dcr";
      renderPage(<AppDetailPage />, { locale });
      await user.click(await screen.findByRole("tab", { name: m.apps.detail.tabs.credentials }));
      expect(screen.getByText(m.apps.credential.clientDcr)).toBeTruthy();
      expect(screen.queryByRole("button", { name: m.apps.credential.rotate })).toBeNull();
    },
  );
});

describe("个人连接（SettingsPage）", () => {
  it.each(LOCALES)(
    "只列个人凭据型应用；填写保存 PUT credentials/me，已连接可清除（%s）",
    async (locale) => {
      const m = msgs[locale];
      let connected = false;
      const personal = { auth: { type: "basic", ownership: "personal" } };
      const calls = stubApi({
        "GET /api/v1/orgs/o1/apps": () =>
          json(200, { apps: [summary(personal), summary({ id: "app2", name: "Org app" })] }),
        "GET /api/v1/orgs/o1/apps/app1": () =>
          json(200, {
            app: detail({
              ...personal,
              credential: { ownership: "personal", status: connected ? "connected" : "missing" },
            }),
          }),
        "PUT /api/v1/orgs/o1/apps/app1/credentials/me": () => {
          connected = true;
          return noContent();
        },
        "DELETE /api/v1/orgs/o1/apps/app1/credentials/me": () => {
          connected = false;
          return noContent();
        },
      });
      const { container } = renderPage(<ConnectionsPage />, { locale });
      expect(container.querySelector('[data-template="SettingsPage"]')).not.toBeNull();
      const section = await screen.findByRole("region", { name: "Fixture" });
      // 每个应用一个分组：页面上没有多个主操作
      expect(
        container.querySelectorAll('[data-variant="primary"], .cb-btn-link-primary').length,
      ).toBeLessThanOrEqual(1);
      expect(screen.queryByText("Org app")).toBeNull();
      expect(within(section).getByText(`‖ ${m.connections.missing}`)).toBeTruthy();
      const user = userEvent.setup();
      await user.type(within(section).getByLabelText(m.apps.form.usernameLabel), "me");
      await user.type(within(section).getByLabelText(m.apps.form.passwordLabel), "pw");
      await user.click(within(section).getByRole("button", { name: m.connections.save }));
      expect(bodyOf(calls.find((c) => c.method === "PUT"))).toEqual({
        username: "me",
        password: "pw",
      });
      await vi.waitFor(() =>
        expect(within(section).getByLabelText(m.apps.form.passwordLabel)).toHaveProperty(
          "value",
          "",
        ),
      );
      expect(within(section).getByLabelText(m.apps.form.usernameLabel)).toHaveProperty("value", "");
      const clear = await screen.findByRole("button", { name: m.connections.clear });
      await user.click(clear);
      expect(calls.some((c) => c.method === "DELETE")).toBe(true);
      await vi.waitFor(() =>
        expect(screen.queryByRole("button", { name: m.connections.clear })).toBeNull(),
      );
    },
  );
});

describe("新建 agent：工具选择与策略收紧", () => {
  it.each(LOCALES)("勾选应用（全部工具）并把其中一个工具收紧为禁止（%s）", async (locale) => {
    const m = msgs[locale];
    const posts: unknown[] = [];
    stubApi({
      "GET /api/v1/orgs/o1/models": () =>
        json(200, {
          providers: [
            {
              provider: "model-fake",
              models: [
                {
                  id: "fake-1",
                  displayName: "Fake 1",
                  capabilities: { reasoning: false },
                  parameters: [],
                },
              ],
            },
          ],
        }),
      "GET /api/v1/orgs/o1/apps": () => json(200, { apps: [summary()] }),
      "GET /api/v1/orgs/o1/apps/app1": () => json(200, { app: detail() }),
      "POST /api/v1/orgs/o1/agents": (c) => {
        posts.push(bodyOf(c));
        return json(201, { agent: { id: "ag1" }, warnings: [] });
      },
    });
    renderPage(<NewAgentPage />, { locale });
    const user = userEvent.setup();
    expect(await screen.findByRole("region", { name: m.agents.form.toolsSection })).toBeTruthy();
    await user.type(screen.getByRole("textbox", { name: m.agents.form.nameLabel }), "Tooly");
    // 内置工具默认勾选；取消 read_tool_output
    await user.click(
      screen.getByRole("checkbox", { name: m.agents.form.builtin.read_tool_output }),
    );
    await user.click(
      await screen.findByRole("checkbox", {
        name: m.agents.form.appTools.replace("{name}", "Fixture"),
      }),
    );
    const policy = await screen.findByRole("combobox", { name: "fixture__delete_item" });
    await user.selectOptions(policy, "deny");
    await user.click(screen.getByRole("button", { name: m.agents.form.submit }));
    expect(posts[0]).toMatchObject({
      definition: {
        tools: [
          { kind: "builtin", name: "ask_user" },
          { kind: "app", appId: "app1", tools: "all" },
        ],
        toolPolicies: { fixture__delete_item: "deny" },
      },
    });
  });
});

describe("应用详情的工具栏刷新", () => {
  it("刷新期间按钮为加载中且不可再点；完成后用返回的应用替换", async () => {
    let resolve: (r: Response) => void = () => {};
    const refreshed = new Promise<Response>((r) => {
      resolve = r;
    });
    const calls: { method: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const method = (init?.method ?? "GET").toUpperCase();
        calls.push({ method });
        if (method === "POST" && String(input) === "/api/v1/orgs/o1/apps/app1/refresh") {
          return refreshed;
        }
        if (String(input) === "/api/v1/orgs/o1/apps/app1") return json(200, { app: detail() });
        throw new Error(`unexpected ${method} ${String(input)}`);
      }),
    );
    renderPage(<AppDetailPage />);
    const button = await screen.findByRole("button", { name: en.apps.detail.refresh });
    await userEvent.setup().click(button);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button).toHaveProperty("disabled", true);
    await act(async () =>
      resolve(json(200, { app: detail({ tools: [tool("search")] }), issues: [], changes: {} })),
    );
    await vi.waitFor(() => expect(button.getAttribute("aria-busy")).toBeNull());
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(screen.queryByText("fixture__delete_item")).toBeNull();
  });
});

describe("useLoad", () => {
  it("依赖变化（切换组织）立即回到加载中，不显示上一组依赖的数据；reload 保留旧数据", async () => {
    const pending = new Map<string, (v: string) => void>();
    const load = (org: string) =>
      new Promise<string>((r) => {
        pending.set(org, r);
      });
    const { result, rerender } = renderHook(({ org }) => useLoad(() => load(org), [org]), {
      initialProps: { org: "o1" },
    });
    expect(result.current.state).toEqual({ kind: "loading" });
    await act(async () => pending.get("o1")?.("data of o1"));
    expect(result.current.state).toEqual({ kind: "ready", data: "data of o1" });

    rerender({ org: "o2" });
    // 同一次渲染里就不再给出 o1 的数据
    expect(result.current.state).toEqual({ kind: "loading" });
    await act(async () => pending.get("o2")?.("data of o2"));
    expect(result.current.state).toEqual({ kind: "ready", data: "data of o2" });

    act(() => result.current.reload());
    expect(result.current.state).toEqual({ kind: "ready", data: "data of o2" });
    await act(async () => pending.get("o2")?.("data of o2 v2"));
    expect(result.current.state).toEqual({ kind: "ready", data: "data of o2 v2" });
  });
});

describe("应用详情切换组织", () => {
  it("切到其他组织：跳回 /apps，且不以新组织读取旧应用", async () => {
    resetNavigation("/apps/app1");
    let current = "o1";
    const me = () => ({
      ...ME,
      currentOrgId: current,
      memberships: [...ME.memberships, { orgId: "o2", slug: "b", name: "Beta", role: "owner" }],
    });
    const calls = stubApi({
      "GET /api/v1/me": () => json(200, me()),
      "PUT /api/v1/me/current-org": () => {
        current = "o2";
        return noContent();
      },
      "GET /api/v1/orgs/o1/apps/app1": () => json(200, { app: detail() }),
      "GET /api/v1/orgs/o1/approvals": () => json(200, { approvals: [] }),
      "GET /api/v1/orgs/o2/approvals": () => json(200, { approvals: [] }),
    });
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <DesignProvider locale="en" link={Link as LinkComponent}>
          <ToastProvider>
            <AppFrame version="v0">
              <AppDetailPage />
            </AppFrame>
          </ToastProvider>
        </DesignProvider>
      </NextIntlClientProvider>,
    );
    expect(await screen.findByRole("heading", { name: "Fixture" })).toBeTruthy();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Organization: Acme" }));
    await user.click(await screen.findByRole("menuitem", { name: "Beta" }));
    await vi.waitFor(() => expect(router.push).toHaveBeenCalledWith("/apps"));
    await vi.waitFor(() => expect(screen.getByRole("button", { name: /Beta/ })).toBeTruthy());
    expect(screen.queryByRole("heading", { name: "Fixture" })).toBeNull();
    expect(calls.some((c) => c.url.includes("/orgs/o2/apps"))).toBe(false);
  });
});
