import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import NewAgentPage from "../src/app/[locale]/(app)/agents/new/page";
import AppDetailPage from "../src/app/[locale]/(app)/apps/[appId]/page";
import NewAppPage from "../src/app/[locale]/(app)/apps/new/page";
import AppsPage from "../src/app/[locale]/(app)/apps/page";
import ConnectionsPage from "../src/app/[locale]/(app)/settings/connections/page";
import type { Me } from "../src/lib/session";
import { bodyOf, json, noContent, stubApi } from "./support/api";
import { resetNavigation, router } from "./support/navigation";
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

const pendingRow = (locale: "zh" | "en") =>
  screen.getByRole("region", { name: locale === "zh" ? "待提交改动" : "Pending changes" });

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
    expect(screen.getByRole("link", { name: m.apps.new }).getAttribute("href")).toBe("/apps/new");
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

describe("添加应用（FormPage）", () => {
  it.each(LOCALES)(
    "MCP + Bearer（组织凭据）：提交认证方式与凭据，成功进入详情（%s）",
    async (locale) => {
      const m = msgs[locale];
      const calls = stubApi({
        "POST /api/v1/orgs/o1/apps": () => json(201, { app: detail(), issues: [] }),
      });
      const { container } = renderPage(<NewAppPage />, { locale });
      expect(container.querySelector('[data-template="FormPage"]')).not.toBeNull();
      const user = userEvent.setup();
      // 必填校验
      await user.click(
        within(pendingRow(locale)).getByRole("button", { name: m.apps.form.submit }),
      );
      expect(screen.getByText(`✗ ${m.apps.form.nameRequired}`)).toBeTruthy();
      expect(screen.getByText(`✗ ${m.apps.form.urlRequired}`)).toBeTruthy();
      expect(calls).toHaveLength(0);

      await user.type(screen.getByRole("textbox", { name: m.apps.form.nameLabel }), "Fixture");
      await user.type(
        screen.getByRole("textbox", { name: new RegExp(`^${m.apps.form.slugLabel}`) }),
        "fx",
      );
      await user.type(
        screen.getByRole("textbox", { name: m.apps.form.urlLabel }),
        "https://mcp.example.com/mcp",
      );
      await user.selectOptions(
        screen.getByRole("combobox", { name: m.apps.form.authTypeLabel }),
        "bearer",
      );
      await user.type(screen.getByLabelText(m.apps.form.tokenLabel), "s3cret");
      await user.click(
        within(pendingRow(locale)).getByRole("button", { name: m.apps.form.submit }),
      );
      expect(bodyOf(calls[0])).toEqual({
        name: "Fixture",
        slug: "fx",
        connector: "mcp",
        endpoint: { url: "https://mcp.example.com/mcp" },
        auth: { type: "bearer", ownership: "org" },
        credential: { token: "s3cret" },
      });
      expect(router.push).toHaveBeenCalledWith("/apps/app1");
    },
  );

  it("自定义请求头 + 个人凭据；有工具被停用时列出原因，点「继续」进入详情", async () => {
    const calls = stubApi({
      "POST /api/v1/orgs/o1/apps": () =>
        json(201, {
          app: detail(),
          issues: [{ name: "bad tool", reason: "Tool name is invalid" }],
        }),
    });
    renderPage(<NewAppPage />);
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox", { name: en.apps.form.nameLabel }), "Hdr");
    await user.type(
      screen.getByRole("textbox", { name: en.apps.form.urlLabel }),
      "https://x.test/mcp",
    );
    await user.selectOptions(
      screen.getByRole("combobox", { name: en.apps.form.authTypeLabel }),
      "headers",
    );
    await user.selectOptions(
      screen.getByRole("combobox", { name: en.apps.form.ownershipLabel }),
      "personal",
    );
    await user.type(
      screen.getByRole("textbox", { name: en.apps.form.headerNamesLabel }),
      "X-Team{Enter}X-Key",
    );
    await user.type(
      screen.getByLabelText(en.apps.form.headerValueLabel.replace("{name}", "X-Key")),
      "k1",
    );
    await user.click(within(pendingRow("en")).getByRole("button", { name: en.apps.form.submit }));
    expect(bodyOf(calls[0])).toMatchObject({
      auth: { type: "headers", ownership: "personal", names: ["X-Team", "X-Key"] },
      credential: { headers: { "X-Team": "", "X-Key": "k1" } },
    });
    expect(await screen.findByText("‖ bad tool: Tool name is invalid")).toBeTruthy();
    expect(router.push).not.toHaveBeenCalled();
    await user.click(within(pendingRow("en")).getByRole("button", { name: en.apps.form.continue }));
    expect(router.push).toHaveBeenCalledWith("/apps/app1");
  });

  it("连接失败：显示翻译后的错误", async () => {
    stubApi({
      "POST /api/v1/orgs/o1/apps": () =>
        json(502, { error: { code: "app.connect_failed", message: "x" } }),
    });
    renderPage(<NewAppPage />, { locale: "zh" });
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox", { name: zh.apps.form.nameLabel }), "Fixture");
    await user.type(
      screen.getByRole("textbox", { name: zh.apps.form.urlLabel }),
      "https://x.test/mcp",
    );
    await user.click(within(pendingRow("zh")).getByRole("button", { name: zh.apps.form.submit }));
    expect((await screen.findByRole("alert")).textContent).toContain(zh.errors.app.connect_failed);
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
