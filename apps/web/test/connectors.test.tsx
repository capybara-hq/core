import { act, cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import ConnectorDetailPage from "../src/app/(app)/connectors/[connectorId]/page";
import { navigateBrowser } from "../src/lib/browser";
import type { Me } from "../src/lib/session";
import { bodyOf, json, lastStubRoutes, noContent, stubApi } from "./support/api";
import { resetNavigation, router } from "./support/navigation";
import { renderRouteEmptyCache, renderRouteWithCache } from "./support/query";
import { ME } from "./support/render";
import { pickOption } from "./support/select";
import { expectNoFirstPaintFetch, onServer, type renderRoute } from "./support/server";
import { NOT_READY, renderFrame, shellOf } from "./support/shell";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("../src/lib/browser", () => ({ navigateBrowser: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
type RenderOpts = Parameters<typeof renderRoute>[2];
/** `/connectors` as a first load: the layout prefetches from the latest `stubApi` routes. */
const renderList = (opts: RenderOpts = {}) =>
  renderRouteWithCache("/connectors", lastStubRoutes(), opts);
const detailPage = () => ConnectorDetailPage({ params: Promise.resolve({ connectorId: "app1" }) });
/** `/connectors/app1` as a first load: the layout prefetches from the latest `stubApi` routes. */
const renderDetail = (opts: RenderOpts = {}) =>
  renderRouteWithCache("/connectors/app1", lastStubRoutes(), opts);

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
  key: `mcp__fixture__${name}`,
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

beforeEach(() => {
  resetNavigation("/connectors");
  vi.mocked(navigateBrowser).mockReset();
});
/** Lets pending reads and effects run (a read after mount would show up in the calls). */
const settle = () => act(() => new Promise((r) => setTimeout(r, 20)));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const COMPONENTS = "GET /api/v1/orgs/o1/components?kind=connector_template";

describe("连接器列表（ListPage，卡片）", () => {
  it.each(LOCALES)("列出连接器；管理员有「添加连接器」，点击卡片进入详情（%s）", async (locale) => {
    const m = msgs[locale];
    stubApi({
      "GET /api/v1/orgs/o1/connectors": () => json(200, { connectors: [summary()] }),
      [COMPONENTS]: () => json(200, { components: [] }),
    });
    const { container } = await renderList({ locale });
    expect(container.querySelector('[data-template="ListPage"]')).not.toBeNull();
    const list = await screen.findByRole("list", { name: m.connectors.title });
    const card = within(list).getByRole("listitem");
    expect(card.textContent).toContain(m.connectors.auth.none);
    expect(within(card).getByText(m.connectors.status.active)).toBeTruthy();
    expect(screen.getByRole("link", { name: m.connectors.new }).getAttribute("href")).toBe(
      "/connectors/install",
    );
    expect(within(card).getByRole("link", { name: "Fixture" }).getAttribute("href")).toBe(
      "/connectors/app1",
    );
  });

  it("普通成员看不到「添加连接器」；空状态", async () => {
    stubApi({
      "GET /api/v1/orgs/o1/connectors": () => json(200, { connectors: [] }),
      [COMPONENTS]: () => json(200, { components: [] }),
    });
    await renderList({ me: MEMBER });
    expect(await screen.findByText(en.connectors.empty)).toBeTruthy();
    expect(screen.queryByRole("link", { name: en.connectors.new })).toBeNull();
    expect(screen.queryByRole("button", { name: en.connectors.new })).toBeNull();
  });
});

describe("/connectors: a card per connector and per template of a plugin on in the org", () => {
  const ITEM = "11111111-1111-4111-8111-111111111111";
  const ICON = `/api/v1/orgs/o1/catalog/${ITEM}/icon?v=0.1.0`;
  const SETUP = `/plugins/${ITEM}/connectors?from=connectors`;
  /** An offered connector template (Slack, shipped off: defaultEnabled false). */
  const template = (over: Record<string, unknown> = {}) => ({
    kind: "connector_template",
    id: "t-slack",
    name: "slack",
    displayName: { zh: "Slack 工作区", en: "Slack workspace" },
    description: "Read and post Slack messages.",
    plugin: "slack",
    itemId: ITEM,
    version: "0.1.0-rc.4",
    scopeMode: "follow",
    switch: null,
    on: false,
    locked: false,
    pluginOn: true,
    switchable: true,
    platformDefault: false,
    linkedIds: [],
    owner: { kind: "platform" },
    icon: ICON,
    ...over,
  });
  const OAUTH = {
    type: "oauth_code",
    ownership: "personal",
    discovery: "manual",
    client: "manual",
  };
  const cardOf = async (name: string, label = en.connectors.title) => {
    const list = await screen.findByRole("list", { name: label });
    const card = within(list)
      .getAllByRole("listitem")
      .find((li) => within(li).queryByText(name, { exact: true }) !== null);
    if (card === undefined) throw new Error(`no card ${name}`);
    return card as HTMLElement;
  };
  const imageOf = (card: HTMLElement) =>
    card.querySelector('[data-part="mark-image"]')?.getAttribute("src") ?? null;

  it.each(LOCALES)(
    "an org admin sees a template that is off as a card: display name, plugin icon, 未启用 and 启用 (%s)",
    async (locale) => {
      const m = msgs[locale];
      const browser = expectNoFirstPaintFetch();
      await renderRouteWithCache(
        "/connectors",
        {
          "GET /api/v1/orgs/o1/connectors": () => json(200, { connectors: [] }),
          [COMPONENTS]: () => json(200, { components: [template()] }),
        },
        { locale },
      );
      const name = locale === "zh" ? "Slack 工作区" : "Slack workspace";
      const card = await cardOf(name, m.connectors.title);
      expect(screen.queryByText(m.connectors.empty)).toBeNull();
      expect(imageOf(card)).toBe(ICON);
      expect(card.textContent).toContain(m.orgComponents.kind.connector_template);
      expect(card.textContent).toContain("slack");
      expect(within(card).getByText(m.orgComponents.state.off)).toBeTruthy();
      expect(
        within(card).getByRole("button", { name: m.orgComponents.action.enable }),
      ).toBeTruthy();
      await settle();
      expect(browser).toEqual([]);
    },
  );

  it("启用 switches the template on, then goes straight to entering its input (补充配置, back to /connectors)", async () => {
    let on = false;
    const calls = stubApi({
      "GET /api/v1/orgs/o1/connectors": () => json(200, { connectors: [] }),
      [COMPONENTS]: () => json(200, { components: [template({ on, switch: on || null })] }),
      "PUT /api/v1/orgs/o1/components/connector_template/t-slack/switch": () => {
        on = true;
        return json(200, { component: { ...template(), on: true, switch: true } });
      },
    });
    await renderList();
    const card = await cardOf("Slack workspace");
    await userEvent
      .setup()
      .click(within(card).getByRole("button", { name: en.orgComponents.action.enable }));
    await vi.waitFor(() => expect(router.push).toHaveBeenCalledWith(SETUP));
    expect(bodyOf(calls.find((c) => c.method === "PUT"))).toEqual({ enabled: true });
    expect(
      await screen.findByText(en.orgComponents.toast.enabled.replace("{name}", "Slack workspace")),
    ).toBeTruthy();
  });

  it("on without a connector: 需要配置 with 配置; a template with a connector is that connector's card", async () => {
    stubApi({
      "GET /api/v1/orgs/o1/connectors": () =>
        json(200, {
          connectors: [
            summary({ id: "c-gh", name: "GitHub", platformTemplateId: "t-gh", icon: ICON }),
          ],
        }),
      [COMPONENTS]: () =>
        json(200, {
          components: [
            template({ on: true, switch: true }),
            template({ id: "t-gh", name: "gh", displayName: { zh: "GitHub", en: "GitHub" } }),
            // a plugin that is off in the org: no card
            template({
              id: "t-crm",
              name: "crm",
              displayName: { zh: "CRM", en: "CRM" },
              pluginOn: false,
            }),
          ],
        }),
    });
    await renderList();
    const slack = await cardOf("Slack workspace");
    expect(within(slack).getByText(en.connectors.templates.needsConfig)).toBeTruthy();
    expect(
      within(slack)
        .getByRole("link", { name: en.connectors.templates.configure })
        .getAttribute("href"),
    ).toBe(SETUP);
    const list = screen.getByRole("list", { name: en.connectors.title });
    expect(within(list).getAllByText("GitHub")).toHaveLength(1);
    expect(within(list).queryByText("CRM")).toBeNull();
    const gh = await cardOf("GitHub");
    expect(within(gh).getByRole("link", { name: "GitHub" }).getAttribute("href")).toBe(
      "/connectors/c-gh",
    );
    expect(imageOf(gh)).toBe(ICON);
  });

  it("members read the template cards without actions", async () => {
    stubApi({
      "GET /api/v1/orgs/o1/connectors": () => json(200, { connectors: [] }),
      [COMPONENTS]: () =>
        json(200, {
          components: [
            template(),
            template({
              id: "t-gh",
              name: "gh",
              displayName: { zh: "GitHub", en: "GitHub" },
              on: true,
            }),
          ],
        }),
    });
    await renderList({ me: MEMBER });
    const slack = await cardOf("Slack workspace");
    expect(within(slack).getByText(en.orgComponents.state.off)).toBeTruthy();
    expect(within(slack).queryByRole("button")).toBeNull();
    const gh = await cardOf("GitHub");
    expect(within(gh).getByText(en.connectors.templates.needsConfig)).toBeTruthy();
    expect(within(gh).queryByRole("link", { name: en.connectors.templates.configure })).toBeNull();
  });

  it("a personal OAuth connector: 连接 starts the connect flow; once connected the card offers 权限", async () => {
    let connected = false;
    const personal = summary({ id: "c-slack", name: "Slack", auth: OAUTH, icon: ICON });
    const calls = stubApi({
      "GET /api/v1/orgs/o1/connectors": () => json(200, { connectors: [personal] }),
      "GET /api/v1/orgs/o1/connectors/c-slack": () =>
        json(200, {
          connector: {
            ...detail(),
            ...personal,
            credential: { ownership: "personal", status: connected ? "connected" : "missing" },
          },
        }),
      [COMPONENTS]: () => json(200, { components: [] }),
      "POST /api/v1/orgs/o1/connectors/c-slack/connect": () =>
        json(200, { authorizationUrl: "https://slack.example/oauth?x=1" }),
    });
    await renderList({ me: MEMBER });
    const card = await cardOf("Slack");
    expect(within(card).getByText(en.connectors.cards.notConnected)).toBeTruthy();
    await userEvent
      .setup()
      .click(within(card).getByRole("button", { name: en.connectors.cards.connect }));
    await vi.waitFor(() =>
      expect(navigateBrowser).toHaveBeenCalledWith("https://slack.example/oauth?x=1"),
    );
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/connect"))).toBe(true);
    cleanup();
    connected = true;
    await renderRouteWithCache("/connectors", lastStubRoutes(), { me: MEMBER });
    const again = await cardOf("Slack");
    expect(within(again).getByText(en.connectors.cards.connected)).toBeTruthy();
    expect(
      within(again).getByRole("button", { name: en.connectors.cards.permissions }),
    ).toBeTruthy();
  });

  it("权限: three choices per tool with the default marked, org locks shown, only changes saved", async () => {
    const personal = summary({ id: "c-slack", name: "Slack", auth: OAUTH });
    const P = en.connectors.permissions;
    const calls = stubApi({
      "GET /api/v1/orgs/o1/connectors": () => json(200, { connectors: [personal] }),
      "GET /api/v1/orgs/o1/connectors/c-slack": () =>
        json(200, {
          connector: {
            ...detail(),
            ...personal,
            credential: { ownership: "personal", status: "connected" },
          },
        }),
      [COMPONENTS]: () => json(200, { components: [] }),
      "GET /api/v1/orgs/o1/connectors/c-slack/tool-policies/me": () =>
        json(200, {
          tools: [
            {
              name: "send_message",
              key: "mcp__slack__send_message",
              title: "Send message",
              description: "Send.",
              defaultPolicy: "ask",
              annotationPolicy: "ask",
              policy: null,
              locked: null,
            },
            {
              name: "delete_message",
              key: "mcp__slack__delete_message",
              title: "Delete message",
              description: "Delete.",
              defaultPolicy: "ask",
              annotationPolicy: "ask",
              policy: null,
              locked: "disabled",
            },
          ],
        }),
      "PUT /api/v1/orgs/o1/connectors/c-slack/tool-policies/me": () => json(200, { tools: [] }),
    });
    await renderList();
    const user = userEvent.setup();
    await user.click(
      within(await cardOf("Slack")).getByRole("button", { name: en.connectors.cards.permissions }),
    );
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByText(P.hint)).toBeTruthy();
    const list = await within(sheet).findByRole("list", { name: P.listLabel });
    const send = within(list).getByRole("group", { name: "Send message" });
    expect(within(send).getByText(P.defaultMark.replace("{label}", P.ask))).toBeTruthy();
    // the org turned delete_message off: locked, no choices
    expect(within(list).getByText(P.locked.disabled)).toBeTruthy();
    expect(within(list).queryByRole("group", { name: "Delete message" })).toBeNull();
    await user.click(within(send).getByRole("radio", { name: P.deny }));
    await user.click(within(sheet).getByRole("button", { name: P.save }));
    await vi.waitFor(() =>
      expect(bodyOf(calls.find((c) => c.method === "PUT"))).toEqual({
        tools: { send_message: "deny" },
      }),
    );
    expect(await screen.findByText(P.saved)).toBeTruthy();
  });

  it("the connector detail leads with its template's plugin icon", async () => {
    stubApi({
      "GET /api/v1/orgs/o1/connectors/app1": () => json(200, { connector: detail({ icon: ICON }) }),
    });
    await renderDetail();
    expect(await screen.findByRole("heading", { level: 1, name: "Fixture" })).toBeTruthy();
    const mark = document.querySelector('[data-part="object-mark"]');
    expect(mark?.querySelector('[data-part="mark-image"]')?.getAttribute("src")).toBe(ICON);
  });

  it("guests see the connectors only: no template read", async () => {
    const GUEST_ME: Me = {
      ...ME,
      memberships: [{ orgId: "o1", slug: "acme", name: "Acme", role: "guest" }],
    };
    const calls = stubApi({
      "GET /api/v1/orgs/o1/connectors": () =>
        json(200, { connectors: [summary({ platformTemplateId: "t-gh", icon: ICON })] }),
      [COMPONENTS]: () => json(200, { components: [template()] }),
    });
    await renderList({ me: GUEST_ME });
    expect(imageOf(await cardOf("Fixture"))).toBe(ICON);
    await settle();
    expect(screen.queryByText("Slack workspace")).toBeNull();
    expect(calls.map((c) => c.url)).not.toContain(
      "/api/v1/orgs/o1/components?kind=connector_template",
    );
  });
});

describe("连接器详情（DetailPage）", () => {
  it.each(LOCALES)("工具页签：改默认策略与启停 → PATCH tools（%s）", async (locale) => {
    const m = msgs[locale];
    const calls = stubApi({
      "GET /api/v1/orgs/o1/connectors/app1": () => json(200, { connector: detail() }),
      "PATCH /api/v1/orgs/o1/connectors/app1": (c) => {
        const body = bodyOf(c) as { tools: Record<string, Record<string, string>> };
        const patch = body.tools.delete_item ?? {};
        return json(200, {
          connector: detail({
            tools: [tool("search", { defaultPolicy: "allow" }), tool("delete_item", patch)],
          }),
        });
      },
    });
    const { container } = await renderDetail({ locale });
    expect(container.querySelector('[data-template="DetailPage"]')).not.toBeNull();
    const policy = await screen.findByRole("combobox", {
      name: m.connectors.tools.policyLabel.replace("{tool}", "mcp__fixture__delete_item"),
    });
    const tabs = screen.getByRole("tablist", { name: m.connectors.detail.tabsLabel });
    expect(
      within(tabs)
        .getAllByRole("tab")
        .map((x) => x.textContent),
    ).toEqual([
      `${m.connectors.detail.tabs.tools}2`,
      m.connectors.detail.tabs.review,
      m.connectors.detail.tabs.credentials,
      m.connectors.detail.tabs.settings,
    ]);
    const user = userEvent.setup();
    await pickOption(policy, "deny", user);
    expect(bodyOf(calls.find((c) => c.method === "PATCH"))).toEqual({
      tools: { delete_item: { defaultPolicy: "deny" } },
    });
    await user.click(
      screen.getByRole("switch", {
        name: m.connectors.tools.enabledLabel.replace("{tool}", "mcp__fixture__delete_item"),
      }),
    );
    expect(bodyOf(calls.filter((c) => c.method === "PATCH")[1])).toEqual({
      tools: { delete_item: { status: "disabled" } },
    });
    // the facts are the column's first block (no right pane): connector, endpoint, auth,
    // credential; the slug is the head's count and is not repeated
    expect(screen.queryByRole("complementary")).toBeNull();
    const facts = document.querySelector('[data-part="detail-facts"]') as HTMLElement;
    expect(document.querySelector('[data-part="content"]')?.firstElementChild).toBe(facts);
    expect(within(facts).getByText("http://127.0.0.1:9/mcp")).toBeTruthy();
    expect(facts.querySelectorAll('[data-part="key-value-row"]')).toHaveLength(4);
    expect(within(facts).queryByText("fixture")).toBeNull();
  });

  it.each(LOCALES)(
    "凭据页签：组织凭据未设置 → 填令牌保存 PUT credentials/org（%s）",
    async (locale) => {
      const m = msgs[locale];
      const calls = stubApi({
        "GET /api/v1/orgs/o1/connectors/app1": () =>
          json(200, {
            connector: detail({
              auth: { type: "bearer", ownership: "org" },
              credential: { ownership: "org", status: "missing" },
            }),
          }),
        "PUT /api/v1/orgs/o1/connectors/app1/credentials/org": () => noContent(),
      });
      await renderDetail({ locale });
      const user = userEvent.setup();
      await user.click(
        await screen.findByRole("tab", { name: m.connectors.detail.tabs.credentials }),
      );
      expect(
        screen.getByText(m.connectors.credential.missing, { selector: "[data-status]" }),
      ).toBeTruthy();
      await user.type(screen.getByLabelText(m.connectors.form.tokenLabel), "tok");
      await user.click(screen.getByRole("button", { name: m.connectors.credential.save }));
      const put = calls.find((c) => c.method === "PUT");
      expect(bodyOf(put)).toEqual({ token: "tok" });
      // saving a credential invalidates the connector: its status is read again
      await vi.waitFor(() =>
        expect(
          calls.filter((c) => c.method === "GET" && c.url === "/api/v1/orgs/o1/connectors/app1"),
        ).toHaveLength(1),
      );
      // 保存成功后清空输入框（凭据值不留在页面上）
      await vi.waitFor(() =>
        expect(screen.getByLabelText(m.connectors.form.tokenLabel)).toHaveProperty("value", ""),
      );
    },
  );

  it.each(LOCALES)(
    "设置页签：删除需输入连接器名确认（DangerConfirm），删除后回到列表（%s）",
    async (locale) => {
      const m = msgs[locale];
      const calls = stubApi({
        "GET /api/v1/orgs/o1/connectors/app1": () => json(200, { connector: detail() }),
        "DELETE /api/v1/orgs/o1/connectors/app1": () => noContent(),
      });
      await renderDetail({ locale });
      const user = userEvent.setup();
      await user.click(await screen.findByRole("tab", { name: m.connectors.detail.tabs.settings }));
      await user.click(screen.getByRole("button", { name: m.connectors.settings.delete }));
      const dialog = await screen.findByRole("dialog");
      const confirm = within(dialog).getByRole("button", { name: m.connectors.settings.delete });
      expect(confirm).toHaveProperty("disabled", true);
      await user.type(within(dialog).getByRole("textbox"), "Fixture");
      await user.click(confirm);
      expect(calls.some((c) => c.method === "DELETE")).toBe(true);
      await vi.waitFor(() => expect(router.push).toHaveBeenCalledWith("/connectors"));
    },
  );

  it("普通成员：工具策略只读，没有删除", async () => {
    stubApi({ "GET /api/v1/orgs/o1/connectors/app1": () => json(200, { connector: detail() }) });
    await renderDetail({ me: MEMBER });
    expect(await screen.findByText(en.connectors.policy.allow)).toBeTruthy();
    expect(screen.queryByRole("combobox")).toBeNull();
    await userEvent
      .setup()
      .click(screen.getByRole("tab", { name: en.connectors.detail.tabs.settings }));
    expect(screen.queryByRole("button", { name: en.connectors.settings.delete })).toBeNull();
  });
});

describe("连接器详情：复核页签（漂移检测）", () => {
  const changed = tool("getPet", {
    key: "mcp__fixture__getPet",
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
    key: "mcp__fixture__newOne",
    status: "pending_review",
    description: "Brand new",
    connectorData: null,
    reviewedAt: null,
    pending: null,
  });
  const gone = tool("oldOne", { key: "mcp__fixture__oldOne", status: "disabled", missing: true });

  it.each(LOCALES)(
    "列出新旧定义（描述、inputSchema、注解、路由数据）；批准 / 拒绝 → POST review（%s）",
    async (locale) => {
      const m = msgs[locale];
      const r = m.connectors.review;
      let tools = [changed, added, gone, tool("search")];
      const calls = stubApi({
        "GET /api/v1/orgs/o1/connectors/app1": () => json(200, { connector: detail({ tools }) }),
        "POST /api/v1/orgs/o1/connectors/app1/tools/getPet/review": () => {
          tools = tools.map((x) =>
            x.name === "getPet" ? { ...x, status: "enabled", pending: null } : x,
          );
          return json(200, { connector: detail({ tools }) });
        },
        "POST /api/v1/orgs/o1/connectors/app1/tools/newOne/review": () =>
          json(409, { error: { code: "connector.tool_not_pending", message: "x" } }),
      });
      await renderDetail({ locale });
      const user = userEvent.setup();
      // 工具页签：待复核的工具显示状态而不是开关；不再提供的工具标注出来
      expect(await screen.findAllByText(`${m.connectors.tools.pendingReview}`)).toHaveLength(2);
      expect(screen.getByText(m.connectors.tools.missing)).toBeTruthy();
      expect(
        screen.getByRole("switch", {
          name: m.connectors.tools.enabledLabel.replace("{tool}", "mcp__fixture__oldOne"),
        }),
      ).toHaveProperty("disabled", true);
      await user.click(screen.getByRole("tab", { name: `${m.connectors.detail.tabs.review}2` }));

      const card = screen.getByRole("region", { name: "mcp__fixture__getPet" });
      expect(within(card).getByText(`${r.changedTool}`)).toBeTruthy();
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
      const fresh = screen.getByRole("region", { name: "mcp__fixture__newOne" });
      expect(within(fresh).getByText(`${r.newTool}`)).toBeTruthy();
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
      expect(screen.getByText("mcp__fixture__oldOne")).toBeTruthy();

      await user.click(
        within(card).getByRole("button", {
          name: r.approveLabel.replace("{tool}", "mcp__fixture__getPet"),
        }),
      );
      expect(bodyOf(calls.find((c) => c.url.endsWith("/tools/getPet/review")))).toEqual({
        action: "approve",
      });
      await vi.waitFor(() =>
        expect(screen.queryByRole("region", { name: "mcp__fixture__getPet" })).toBeNull(),
      );
      await user.click(
        screen.getByRole("button", {
          name: r.rejectLabel.replace("{tool}", "mcp__fixture__newOne"),
        }),
      );
      expect(bodyOf(calls.find((c) => c.url.endsWith("/tools/newOne/review")))).toEqual({
        action: "reject",
      });
      expect(await screen.findByText(m.errors.connector.tool_not_pending)).toBeTruthy();
    },
  );

  it.each(LOCALES)(
    "从未复核过的工具按新工具显示完整定义（不对比）；被拒的新工具仍可批准、不能在工具页签启用；不合规的新定义只能拒绝（%s）",
    async (locale) => {
      const m = msgs[locale];
      const r = m.connectors.review;
      const legacy = tool("fresh", {
        key: "mcp__fixture__fresh",
        status: "pending_review",
        description: "Fresh v1",
        reviewedAt: null,
        pending: {
          description: "Fresh v2",
          inputSchema: {},
          annotations: null,
          connectorData: null,
          specHash: "h3",
        },
      });
      const rejected = tool("nope", {
        key: "mcp__fixture__nope",
        status: "disabled",
        description: "Rejected once",
        reviewedAt: null,
        pending: null,
      });
      const broken = tool("broken", {
        key: "mcp__fixture__broken",
        status: "disabled",
        reviewedAt: T,
        issue: "Tool inputSchema must be an object",
        pending: {
          description: "Broken",
          inputSchema: [],
          annotations: null,
          connectorData: null,
          specHash: "h4",
        },
      });
      stubApi({
        "GET /api/v1/orgs/o1/connectors/app1": () =>
          json(200, { connector: detail({ tools: [legacy, rejected, broken] }) }),
      });
      await renderDetail({ locale });
      const user = userEvent.setup();
      expect(await screen.findByText(m.connectors.tools.neverReviewed)).toBeTruthy();
      expect(
        screen.getByRole("switch", {
          name: m.connectors.tools.enabledLabel.replace("{tool}", "mcp__fixture__nope"),
        }),
      ).toHaveProperty("disabled", true);
      // 页签计数：待复核的，加上带待复核新定义而停用的（不合规的 broken），让管理员注意到
      await user.click(screen.getByRole("tab", { name: `${m.connectors.detail.tabs.review}2` }));

      const fresh = screen.getByRole("region", { name: "mcp__fixture__fresh" });
      expect(within(fresh).getByText(`${r.newTool}`)).toBeTruthy();
      expect(
        (
          within(fresh).getByRole("textbox", {
            name: `${r.description} · ${r.new}`,
          }) as HTMLTextAreaElement
        ).value,
      ).toBe("Fresh v2");
      expect(
        within(fresh).queryByRole("textbox", { name: `${r.description} · ${r.current}` }),
      ).toBeNull();

      const rej = screen.getByRole("region", { name: "mcp__fixture__nope" });
      expect(within(rej).getByText(new RegExp(`${r.rejectedNewTool}$`))).toBeTruthy();
      expect(
        within(rej).getByRole("button", {
          name: r.approveLabel.replace("{tool}", "mcp__fixture__nope"),
        }),
      ).toBeTruthy();
      expect(
        within(rej).queryByRole("button", {
          name: r.rejectLabel.replace("{tool}", "mcp__fixture__nope"),
        }),
      ).toBeNull();

      const bad = screen.getByRole("region", { name: "mcp__fixture__broken" });
      expect(within(bad).getByText("Tool inputSchema must be an object")).toBeTruthy();
      expect(
        within(bad).getByRole("button", {
          name: r.approveLabel.replace("{tool}", "mcp__fixture__broken"),
        }),
      ).toHaveProperty("disabled", true);
      expect(
        within(bad).getByRole("button", {
          name: r.rejectLabel.replace("{tool}", "mcp__fixture__broken"),
        }),
      ).toHaveProperty("disabled", false);
    },
  );

  it("普通成员：只看对比，没有批准 / 拒绝；没有待复核时显示空状态", async () => {
    stubApi({
      "GET /api/v1/orgs/o1/connectors/app1": () =>
        json(200, { connector: detail({ tools: [added] }) }),
    });
    await renderDetail({ me: MEMBER });
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("tab", { name: `${en.connectors.detail.tabs.review}1` }),
    );
    expect(screen.getByRole("region", { name: "mcp__fixture__newOne" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: en.connectors.review.approve })).toBeNull();
    cleanup();
    stubApi({ "GET /api/v1/orgs/o1/connectors/app1": () => json(200, { connector: detail() }) });
    await renderDetail();
    await user.click(await screen.findByRole("tab", { name: en.connectors.detail.tabs.review }));
    expect(screen.getByText(en.connectors.review.empty)).toBeTruthy();
  });
});

describe("连接器详情：OAuth 客户端轮换", () => {
  it.each(LOCALES)(
    "客户端凭据流：填 client id 与密钥（密码框）→ PUT credentials/org；成功后清空（%s）",
    async (locale) => {
      const m = msgs[locale];
      const calls = stubApi({
        "GET /api/v1/orgs/o1/connectors/app1": () =>
          json(200, {
            connector: detail({
              auth: { type: "oauth_client", ownership: "org", tokenUrl: "https://a/token" },
              credential: { ownership: "org", status: "connected" },
            }),
          }),
        "PUT /api/v1/orgs/o1/connectors/app1/credentials/org": () => noContent(),
      });
      await renderDetail({ locale });
      const user = userEvent.setup();
      await user.click(
        await screen.findByRole("tab", { name: m.connectors.detail.tabs.credentials }),
      );
      expect(screen.getByText(m.connectors.credential.rotateVerified)).toBeTruthy();
      const rotate = screen.getByRole("button", { name: m.connectors.credential.rotate });
      expect(rotate).toHaveProperty("disabled", true);
      await user.type(
        screen.getByRole("textbox", { name: m.connectors.oauth.clientIdLabel }),
        "cid2",
      );
      // 客户端凭据流必须带密钥
      expect(rotate).toHaveProperty("disabled", true);
      const secret = screen.getByLabelText(new RegExp(`^${m.connectors.oauth.clientSecretLabel}`));
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
        "GET /api/v1/orgs/o1/connectors/app1": () =>
          json(200, {
            connector: detail({
              auth: code(client),
              credential: { ownership: "personal", status: "missing" },
            }),
          }),
        "PUT /api/v1/orgs/o1/connectors/app1/credentials/org": () => noContent(),
      });
      const { container } = await renderDetail({ locale });
      const user = userEvent.setup();
      await user.click(
        await screen.findByRole("tab", { name: m.connectors.detail.tabs.credentials }),
      );
      expect(screen.getByText(m.connectors.credential.rotateUnverified)).toBeTruthy();
      expect(screen.getByText(m.connectors.credential.personalHint)).toBeTruthy();
      expect(container.querySelectorAll('[data-variant="primary"]').length).toBeLessThanOrEqual(1);
      await user.type(
        screen.getByRole("textbox", { name: m.connectors.oauth.clientIdLabel }),
        "pub",
      );
      await user.click(screen.getByRole("button", { name: m.connectors.credential.rotate }));
      expect(bodyOf(calls.find((c) => c.method === "PUT"))).toEqual({ clientId: "pub" });

      cleanup();
      client = "dcr";
      await renderDetail({ locale });
      await user.click(
        await screen.findByRole("tab", { name: m.connectors.detail.tabs.credentials }),
      );
      expect(screen.getByText(m.connectors.credential.clientDcr)).toBeTruthy();
      expect(screen.queryByRole("button", { name: m.connectors.credential.rotate })).toBeNull();
    },
  );
});

describe("个人连接（SettingsPage）", () => {
  it.each(LOCALES)(
    "只列个人凭据型连接器；填写保存 PUT credentials/me，已连接可清除（%s）",
    async (locale) => {
      const m = msgs[locale];
      let connected = false;
      const personal = { auth: { type: "basic", ownership: "personal" } };
      const calls = stubApi({
        "GET /api/v1/orgs/o1/connectors": () =>
          json(200, { connectors: [summary(personal), summary({ id: "app2", name: "Org app" })] }),
        "GET /api/v1/orgs/o1/connectors/app1": () =>
          json(200, {
            connector: detail({
              ...personal,
              credential: { ownership: "personal", status: connected ? "connected" : "missing" },
            }),
          }),
        "PUT /api/v1/orgs/o1/connectors/app1/credentials/me": () => {
          connected = true;
          return noContent();
        },
        "DELETE /api/v1/orgs/o1/connectors/app1/credentials/me": () => {
          connected = false;
          return noContent();
        },
      });
      const { container } = await renderRouteWithCache("/account/connections", lastStubRoutes(), {
        locale,
      });
      expect(container.querySelector('[data-template="SettingsPage"]')).not.toBeNull();
      const section = await screen.findByRole("region", { name: "Fixture" });
      // 每个连接器一个分组：页面上没有多个主操作
      expect(
        container.querySelectorAll('[data-variant="primary"], .cb-btn-link-primary').length,
      ).toBeLessThanOrEqual(1);
      expect(screen.queryByText("Org app")).toBeNull();
      expect(within(section).getByText(`${m.connections.missing}`)).toBeTruthy();
      const user = userEvent.setup();
      await user.type(within(section).getByLabelText(m.connectors.form.usernameLabel), "me");
      await user.type(within(section).getByLabelText(m.connectors.form.passwordLabel), "pw");
      await user.click(within(section).getByRole("button", { name: m.connections.save }));
      expect(bodyOf(calls.find((c) => c.method === "PUT"))).toEqual({
        username: "me",
        password: "pw",
      });
      await vi.waitFor(() =>
        expect(within(section).getByLabelText(m.connectors.form.passwordLabel)).toHaveProperty(
          "value",
          "",
        ),
      );
      expect(within(section).getByLabelText(m.connectors.form.usernameLabel)).toHaveProperty(
        "value",
        "",
      );
      const clear = await screen.findByRole("button", { name: m.connections.clear });
      await user.click(clear);
      expect(calls.some((c) => c.method === "DELETE")).toBe(true);
      await vi.waitFor(() =>
        expect(screen.queryByRole("button", { name: m.connections.clear })).toBeNull(),
      );
    },
  );
});

describe("连接器详情的工具栏刷新", () => {
  it("刷新期间按钮为加载中且不可再点；完成后用返回的连接器替换", async () => {
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
        if (method === "POST" && String(input) === "/api/v1/orgs/o1/connectors/app1/refresh") {
          return refreshed;
        }
        if (String(input) === "/api/v1/orgs/o1/connectors/app1")
          return json(200, { connector: detail() });
        throw new Error(`unexpected ${method} ${String(input)}`);
      }),
    );
    await renderDetail();
    const button = await screen.findByRole("button", { name: en.connectors.detail.refresh });
    await userEvent.setup().click(button);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button).toHaveProperty("disabled", true);
    await act(async () =>
      resolve(
        json(200, { connector: detail({ tools: [tool("search")] }), issues: [], changes: {} }),
      ),
    );
    await vi.waitFor(() => expect(button.getAttribute("aria-busy")).toBeNull());
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(screen.queryByText("mcp__fixture__delete_item")).toBeNull();
  });
});

describe("连接器详情切换组织", () => {
  it("switching org opens the new org's home with a full navigation; the old connector is never read with the new org", async () => {
    resetNavigation("/connectors/app1");
    const me = (current: string) => ({
      ...ME,
      currentOrgId: current,
      memberships: [...ME.memberships, { orgId: "o2", slug: "b", name: "Beta", role: "owner" }],
    });
    const calls = stubApi({
      "PUT /api/v1/me/current-org": () => noContent(),
      "GET /api/v1/orgs/o1/connectors/app1": () => json(200, { connector: detail() }),
    });
    const { element } = await onServer(detailPage, lastStubRoutes(), { me: me("o1") });
    renderFrame(shellOf(me("o1")), element, {
      locale: "en",
      version: "v0",
    });
    expect(await screen.findByRole("heading", { name: "Fixture" })).toBeTruthy();
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: /^Current organization: .*, switch organization$/ }),
    );
    // jsdom has no layout: pick the item with the keyboard (see design menu-submenu tests)
    (await screen.findByRole("menuitemradio", { name: "Beta" })).focus();
    await user.keyboard("{Enter}");
    await vi.waitFor(() => expect(navigateBrowser).toHaveBeenCalledWith("/"));
    expect(router.push).not.toHaveBeenCalled();
    // the old org's page stays until the new document replaces it
    expect(screen.getByRole("heading", { name: "Fixture" })).toBeTruthy();
    expect(calls.some((c) => c.url.includes("/orgs/o2/connectors"))).toBe(false);
  });
});

describe("the connectors pages render on the server (web-SSR spec §6)", () => {
  const GUEST = {
    ...ME,
    account: { ...ME.account, isSuperAdmin: false },
    memberships: [{ orgId: "o1", slug: "acme", name: "Acme", role: "guest" }],
  };
  const routes = {
    "GET /api/v1/orgs/o1/connectors": () => json(200, { connectors: [summary()] }),
    "GET /api/v1/orgs/o1/connectors/app1": () => json(200, { connector: detail() }),
    "GET /api/v1/orgs/o1/components?kind=connector_template": () => json(200, { components: [] }),
  };

  it("/connectors: a first render from the hydrated cache makes no browser read (guests too)", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRouteWithCache("/connectors", routes, { me: GUEST });
    expect(within(screen.getByRole("list", { name: en.connectors.title })).getByText("Fixture"));
    await settle();
    expect(browser).toEqual([]);
  });

  it("/connectors: an empty cache shows the template's loading state, then the data", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    await renderRouteEmptyCache("/connectors", {
      "GET /api/v1/orgs/o1/connectors": async () => {
        await held;
        return json(200, { connectors: [summary()] });
      },
    });
    await vi.waitFor(() => {
      if (document.querySelector('[data-template="ListPage"]') === null) throw new Error("no page");
    });
    expect(document.querySelector("[aria-busy='true']")).not.toBeNull();
    expect(screen.queryByText("Fixture")).toBeNull();
    await act(async () => release());
    expect(await screen.findByText("Fixture")).toBeTruthy();
    await vi.waitFor(() => expect(document.querySelector("[aria-busy='true']")).toBeNull());
  });

  it("/connectors: no org renders nothing; setup goes home", async () => {
    const none = await renderRouteWithCache("/connectors", routes, {
      me: { ...ME, currentOrgId: null },
    });
    expect(none.calls.map((c) => c.url)).toEqual(["/api/v1/me"]);
    expect(document.body.textContent).toBe("");
    cleanup();
    await renderRouteWithCache("/connectors", routes, { readiness: NOT_READY });
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith("/"));
  });

  it("/connectors/<id>: a first render from the hydrated cache makes no browser read (guests too)", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRouteWithCache("/connectors/app1", routes, { me: GUEST });
    expect(screen.getByRole("heading", { level: 1, name: "Fixture" })).toBeTruthy();
    await settle();
    expect(browser).toEqual([]);
  });

  it("/connectors/<id>: an empty cache shows the template's loading state, then the data", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    await renderRouteEmptyCache("/connectors/app1", {
      "GET /api/v1/orgs/o1/connectors/app1": async () => {
        await held;
        return json(200, { connector: detail() });
      },
    });
    await vi.waitFor(() => {
      if (document.querySelector('[data-template="DetailPage"]') === null)
        throw new Error("no page");
    });
    expect(document.querySelector("[aria-busy='true']")).not.toBeNull();
    expect(screen.queryByRole("heading", { level: 1, name: "Fixture" })).toBeNull();
    // the facts block's four rows, then the tools tab's table: its header and, for a manager,
    // the refresh button (disabled); no generic cards
    const page = document.querySelector('[data-template="DetailPage"]') as HTMLElement;
    expect(page.querySelector('[data-empty="loading"]')).not.toBeNull();
    expect(within(page).getByText(en.connectors.tools.columns.policy)).toBeTruthy();
    const refresh = within(page).getByRole("button", {
      name: en.connectors.detail.refresh,
    }) as HTMLButtonElement;
    expect(refresh.disabled).toBe(true);
    expect(page.querySelectorAll('[data-part="loading-card"]')).toHaveLength(0);
    expect(page.querySelector(".cb-body-inspector")).toBeNull();
    expect(
      page.querySelectorAll('[data-part="detail-facts"] [data-part="key-value-row"]'),
    ).toHaveLength(4);
    await act(async () => release());
    expect(await screen.findByRole("heading", { level: 1, name: "Fixture" })).toBeTruthy();
    await vi.waitFor(() => expect(document.querySelector("[aria-busy='true']")).toBeNull());
  });

  it("/connectors/<id>: a connector the kernel does not find is the not-found state in the shell", async () => {
    expectNoFirstPaintFetch();
    await renderRouteWithCache("/connectors/app1", {
      "GET /api/v1/orgs/o1/connectors/app1": () =>
        json(404, { error: { code: "connector.not_found", message: "x" } }),
    });
    expect(screen.getByRole("heading", { level: 1, name: en.notFound.title })).toBeTruthy();
  });

  it("/connectors/<id>: no org renders nothing; setup goes home", async () => {
    const none = await renderRouteWithCache("/connectors/app1", routes, {
      me: { ...ME, currentOrgId: null },
    });
    expect(none.calls.map((c) => c.url)).toEqual(["/api/v1/me"]);
    expect(document.body.textContent).toBe("");
    cleanup();
    await renderRouteWithCache("/connectors/app1", routes, { readiness: NOT_READY });
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith("/"));
  });
});

describe("connector mutations update the cache", () => {
  const listState = (client: {
    getQueryState(k: unknown[]): { isInvalidated: boolean } | undefined;
  }) => client.getQueryState(["org", "o1", "connectors"])?.isInvalidated;

  it("saving the settings sets the cached connector and invalidates connectors", async () => {
    const calls = stubApi({
      "GET /api/v1/orgs/o1/connectors/app1": () => json(200, { connector: detail() }),
      "PATCH /api/v1/orgs/o1/connectors/app1": (c) =>
        json(200, { connector: detail(bodyOf(c) as Record<string, unknown>) }),
    });
    const { client } = await renderDetail();
    // the list is cached (as after a visit to /connectors)
    client.setQueryData(["org", "o1", "connectors"], { connectors: [summary()] });
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: en.connectors.detail.tabs.settings }));
    const name = screen.getByRole("textbox", {
      name: new RegExp(`^${en.connectors.form.nameLabel}`),
    });
    await user.clear(name);
    await user.type(name, "Renamed");
    await user.click(screen.getByRole("button", { name: en.connectors.settings.save }));
    await vi.waitFor(() =>
      expect(
        (client.getQueryData(["org", "o1", "connector", "app1"]) as { name: string }).name,
      ).toBe("Renamed"),
    );
    // the connector comes from the answer: it is not read again
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "PATCH /api/v1/orgs/o1/connectors/app1",
    ]);
    expect(listState(client)).toBe(true);
  });

  it("deleting a connector invalidates connectors and forgets it once the page is left", async () => {
    const calls = stubApi({
      "GET /api/v1/orgs/o1/connectors/app1": () => json(200, { connector: detail() }),
      "DELETE /api/v1/orgs/o1/connectors/app1": () => noContent(),
    });
    const { client, unmount } = await renderDetail();
    client.setQueryData(["org", "o1", "connectors"], { connectors: [summary()] });
    const s = en.connectors.settings;
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: en.connectors.detail.tabs.settings }));
    await user.click(screen.getByRole("button", { name: s.delete }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByRole("textbox"), "Fixture");
    await user.click(within(dialog).getByRole("button", { name: s.delete }));
    await vi.waitFor(() => expect(router.push).toHaveBeenCalledWith("/connectors"));
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "DELETE /api/v1/orgs/o1/connectors/app1",
    ]);
    expect(listState(client)).toBe(true);
    // still cached while the page shows (no read before the navigation), gone once it is left
    expect(client.getQueryData(["org", "o1", "connector", "app1"])).toBeDefined();
    unmount();
    expect(client.getQueryState(["org", "o1", "connector", "app1"])).toBeUndefined();
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "DELETE /api/v1/orgs/o1/connectors/app1",
    ]);
  });
});
