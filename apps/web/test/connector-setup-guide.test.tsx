import { findNestedBoxes } from "@capybara-hq/design/reference";
import { act, cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import type { Me } from "../src/lib/session";
import { bodyOf, json, lastStubRoutes, stubApi } from "./support/api";
import { footControls, MORE, openCardMenu } from "./support/cards";
import { resetNavigation } from "./support/navigation";
import { renderRouteWithCache } from "./support/query";
import { ME } from "./support/render";
import { expectNoFirstPaintFetch, type Routes } from "./support/server";

// Setup guides on the connector template place (setup guides v2 spec §9.3, §11): the admin text
// above a needs_config template connector's input (its configure form), the connector's setup
// guide tab with the drift notice and ack, the member's "How to connect" sheet (with the admin link
// for org admins) and the super admin's template page.

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

const ORG = "/api/v1/orgs/o1";
const ITEM = "11111111-1111-4111-8111-111111111111";
const GUIDE_URL = `${ORG}/catalog/${ITEM}/guides/slack-connector`;
const ADMIN_GUIDE_URL = `/api/v1/admin/catalog/${ITEM}/guides/slack-connector`;
const T = "2026-11-09T00:00:00.000Z";
const G = en.setupGuide;
const MEMBER: Me = {
  ...ME,
  account: { ...ME.account, isSuperAdmin: false },
  memberships: [{ orgId: "o1", slug: "acme", name: "Acme", role: "member" }],
};
const settle = () => act(() => new Promise((r) => setTimeout(r, 20)));

/** The kernel's rendered connector-template guide (spec §7.2) for an audience. */
const rendered = (
  audience: "admin" | "member",
  o: { connectorId?: string | null; hash?: string; audiences?: string[]; locale?: string } = {},
) => ({
  itemId: ITEM,
  plugin: "slack",
  version: "0.2.0",
  id: "slack-connector",
  place: "connector-template",
  locale: o.locale ?? "en",
  title: audience === "admin" ? "Create the Slack OAuth app" : "Connect your Slack account",
  modes: [],
  mode: null,
  audiences: o.audiences ?? ["admin", "member"],
  audience,
  blocks:
    audience === "admin"
      ? [
          { kind: "markdown", text: "## 1. Create the OAuth app\n\nRegister the redirect URL." },
          {
            kind: "code",
            language: "text",
            title: "Redirect URL",
            text: "https://capybara.example/api/v1/oauth/callback\n",
          },
          { kind: "check", id: "oauth-client", label: "OAuth client works" },
        ]
      : [
          { kind: "markdown", text: "Press **Connect** and approve the app in Slack." },
          { kind: "check", id: "capybara:connected", label: "Your account is connected" },
        ],
  checks:
    audience === "admin"
      ? [{ id: "oauth-client", label: "OAuth client works", source: "plugin" }]
      : [{ id: "capybara:connected", label: "Your account is connected", source: "kernel" }],
  unresolved:
    o.connectorId === undefined || o.connectorId === null
      ? [{ name: "connectorName", reason: "no_connector" }]
      : [],
  hash: o.hash ?? "a".repeat(64),
  target:
    o.connectorId === undefined || o.connectorId === null
      ? null
      : { kind: "connector", id: o.connectorId },
});

/** The org guide route: renders for the audience and connector asked for. */
const guideRoute =
  (o: { audiences?: string[]; hash?: string } = {}) =>
  (call: { url: string }) => {
    const q = new URL(call.url, "http://x").searchParams;
    return json(200, {
      guide: rendered((q.get("audience") as "admin" | "member" | null) ?? "admin", {
        connectorId: q.get("connectorId"),
        locale: q.get("locale") ?? "en",
        ...o,
      }),
    });
  };

const SETUP_GUIDE = { itemId: ITEM, guideId: "slack-connector", version: "0.2.0" };
const OAUTH = { type: "oauth_code", ownership: "personal", discovery: "manual", client: "manual" };
const connector = (over: Record<string, unknown> = {}) => ({
  id: "app1",
  slug: "slack",
  name: "Slack",
  connector: "connector-mcp",
  endpoint: { url: "https://slack.example.test/mcp" },
  auth: OAUTH,
  status: "active",
  platformTemplateId: "t-slack",
  icon: null,
  setupGuide: SETUP_GUIDE,
  guideDrift: null,
  createdAt: T,
  updatedAt: T,
  tools: [],
  credential: { ownership: "personal", status: "missing" },
  ...over,
});

const ORG_ITEM = {
  id: ITEM,
  name: "slack",
  publisher: "capybara-hq",
  displayName: { en: "Slack", zh: "Slack" },
  description: "Slack",
  scope: "optional",
  builtin: false,
  disabled: false,
  latestVersion: "0.2.0",
  versions: ["0.2.0"],
  source: "npm",
  updatedAt: T,
  state: "needs_config",
  switchable: true,
  notDeployed: false,
  installed: { pluginInstallId: "i1", version: "0.2.0", upgradeAvailable: null },
  request: null,
  componentCounts: { extension: 1, skills: 0, connectorTemplates: 1, agentTemplates: 0 },
  sourceFormat: "capybara",
};
const TEMPLATE = {
  id: "slack",
  displayName: { en: "Slack workspace", zh: "Slack 工作区" },
  description: "",
  plugin: "slack",
  connector: "connector-mcp",
  endpoint: { url: "https://slack.example.test/mcp" },
  editableEndpoint: [],
  auth: OAUTH,
  ownership: "personal",
  guide: { itemId: ITEM, guideId: "slack-connector" },
};
const orgDetail = (template: Record<string, unknown> = TEMPLATE) => ({
  item: ORG_ITEM,
  hasIcon: false,
  extension: "slack",
  templates: [template],
  dependencies: [],
  skills: [],
  agents: [],
});

beforeEach(() => resetNavigation("/connectors"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("配置: a needs_config template connector's form shows the admin guide above its input", () => {
  /** The template the connector was made from, as the org's components list offers it. */
  const component = {
    kind: "connector_template",
    id: "t-slack",
    name: "slack",
    displayName: TEMPLATE.displayName,
    description: null,
    plugin: "slack",
    itemId: ITEM,
    version: "0.2.0",
    scopeMode: "follow",
    switch: null,
    on: true,
    locked: false,
    pluginOn: true,
    switchable: true,
    owner: { kind: "platform" },
    guide: { itemId: ITEM, guideId: "slack-connector" },
  };
  const routes = (
    over: Record<string, unknown> = {},
    template: Record<string, unknown> = TEMPLATE,
  ): Routes => ({
    [`GET ${ORG}/connectors/app1`]: () =>
      json(200, { connector: connector({ setup: "needs_config", ...over }) }),
    [`GET ${ORG}/components?kind=connector_template`]: () => json(200, { components: [component] }),
    [`GET ${ORG}/catalog/${ITEM}`]: () => json(200, orgDetail(template)),
    [`GET ${GUIDE_URL}`]: guideRoute(),
    [`GET ${GUIDE_URL}/checks`]: () => json(200, { results: {} }),
    [`PUT ${ORG}/connectors/app1/credentials/org`]: () => new Response(null, { status: 204 }),
    [`PATCH ${ORG}/connectors/app1`]: () =>
      json(200, { connector: connector({ setup: "needs_config", ...over }) }),
    [`POST ${ORG}/connectors/app1/guide-ack`]: () =>
      json(200, { connector: connector({ setup: "ready", ...over }) }),
  });

  it("配置 opens the 凭据 tab: the admin guide, then the client fields; saving records the guide", async () => {
    resetNavigation("/connectors/app1");
    const calls = stubApi(routes());
    const { container } = await renderRouteWithCache(
      "/connectors/app1?tab=credentials",
      lastStubRoutes(),
      { locale: "en" },
    );
    // the guide card: the hint and the admin text, read for this connector
    const section = (await screen.findByText(G.connectorHint)).closest("section") as HTMLElement;
    expect(await within(section).findByText("Create the Slack OAuth app")).toBeTruthy();
    const clientField = await screen.findByLabelText(/client id/i);
    expect(
      section.compareDocumentPosition(clientField) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const user = userEvent.setup();
    await user.type(clientField, "cid");
    await user.click(screen.getByRole("button", { name: en.connectors.credential.saveClient }));
    await vi.waitFor(() =>
      expect(bodyOf(calls.find((c) => c.method === "PUT"))).toEqual({ clientId: "cid" }),
    );
    // the guide shown is the one the connector is now set up with
    await vi.waitFor(() =>
      expect(bodyOf(calls.find((c) => c.url.endsWith("/guide-ack")))).toEqual({
        hash: "a".repeat(64),
      }),
    );
    expect(findNestedBoxes(container)).toEqual([]);
  });

  it("only the template's editable endpoint fields; saving PATCHes the endpoint and records the guide", async () => {
    resetNavigation("/connectors/app1");
    const calls = stubApi(
      routes(
        {
          endpoint: { url: "https://slack.example.test/mcp", headers: { "X-Team": "t1" } },
          auth: { type: "bearer", ownership: "org" },
          credential: { ownership: "org", status: "missing" },
        },
        {
          ...TEMPLATE,
          endpoint: { url: "https://slack.example.test/mcp", headers: { "X-Team": "t1" } },
          editableEndpoint: ["url"],
          auth: { type: "bearer", ownership: "org" },
          ownership: "org",
        },
      ),
    );
    await renderRouteWithCache("/connectors/app1?tab=credentials", lastStubRoutes(), {
      locale: "zh",
    });
    const url = (await screen.findByRole("textbox", { name: "url" })) as HTMLInputElement;
    expect(url.value).toBe("https://slack.example.test/mcp");
    // a path the template does not open to the org is not offered
    expect(screen.queryByRole("textbox", { name: "headers.X-Team" })).toBeNull();
    const user = userEvent.setup();
    await user.clear(url);
    await user.type(url, "https://slack.acme.test/mcp");
    await user.click(screen.getByRole("button", { name: zh.connectors.endpointEdit.save }));
    await vi.waitFor(() =>
      expect(bodyOf(calls.find((c) => c.method === "PATCH"))).toEqual({
        endpoint: { url: "https://slack.acme.test/mcp" },
      }),
    );
    await vi.waitFor(() =>
      expect(bodyOf(calls.find((c) => c.url.endsWith("/guide-ack")))).toEqual({
        hash: "a".repeat(64),
      }),
    );
  });

  it("an endpoint the kernel refuses (400) shows why and records no guide", async () => {
    resetNavigation("/connectors/app1");
    const calls = stubApi({
      ...routes(
        {
          auth: { type: "bearer", ownership: "org" },
          credential: { ownership: "org", status: "missing" },
        },
        { ...TEMPLATE, editableEndpoint: ["url"], auth: { type: "bearer", ownership: "org" } },
      ),
      [`PATCH ${ORG}/connectors/app1`]: () =>
        json(400, {
          error: {
            code: "validation_failed",
            message: "x",
            details: [{ path: "endpoint.url", message: "bad" }],
          },
        }),
    });
    await renderRouteWithCache("/connectors/app1?tab=credentials", lastStubRoutes(), {
      locale: "en",
    });
    await screen.findByText("Create the Slack OAuth app");
    const url = (await screen.findByRole("textbox", { name: "url" })) as HTMLInputElement;
    const user = userEvent.setup();
    await user.clear(url);
    await user.type(url, "https://bad.test/mcp");
    await user.click(screen.getByRole("button", { name: en.connectors.endpointEdit.save }));
    expect(await screen.findByText(en.errors.validation_failed, { exact: false })).toBeTruthy();
    await settle();
    expect(calls.some((c) => c.url.endsWith("/guide-ack"))).toBe(false);
  });

  it("a refused guide ack after a saved client says the guide was not recorded", async () => {
    resetNavigation("/connectors/app1");
    stubApi({
      ...routes(),
      [`POST ${ORG}/connectors/app1/guide-ack`]: () =>
        json(409, { error: { code: "connector.guide_changed", message: "x" } }),
    });
    await renderRouteWithCache("/connectors/app1?tab=credentials", lastStubRoutes(), {
      locale: "zh",
    });
    await screen.findByText("Create the Slack OAuth app");
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/client id/i), "cid");
    await user.click(screen.getByRole("button", { name: zh.connectors.credential.saveClient }));
    expect(
      await screen.findByText(zh.connectors.setup.guideNotRecorded, { exact: false }),
    ).toBeTruthy();
  });

  it("saving waits until the guide shown has been read (its hash is what gets recorded)", async () => {
    resetNavigation("/connectors/app1");
    stubApi({ ...routes(), [`GET ${GUIDE_URL}`]: () => new Promise<Response>(() => {}) });
    await renderRouteWithCache("/connectors/app1?tab=credentials", lastStubRoutes(), {
      locale: "en",
    });
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/client id/i), "cid");
    expect(
      screen.getByRole("button", { name: en.connectors.credential.saveClient }),
    ).toHaveProperty("disabled", true);
  });

  it("a template without a guide shows its input alone", async () => {
    resetNavigation("/connectors/app1");
    stubApi(routes({ setupGuide: null }, { ...TEMPLATE, guide: null }));
    await renderRouteWithCache("/connectors/app1?tab=credentials", lastStubRoutes(), {
      locale: "en",
    });
    await screen.findByLabelText(/client id/i);
    await settle();
    expect(screen.queryByText(G.connectorHint)).toBeNull();
  });

  it("install from a template is a review: no guide and no input (the guide waits for 配置)", async () => {
    resetNavigation("/connectors/install");
    await renderRouteWithCache(
      `/connectors/install?template=${ITEM}`,
      {
        [`GET ${ORG}/catalog/${ITEM}`]: () =>
          json(200, orgDetail({ ...TEMPLATE, defaultOff: false, connected: false })),
        [`GET ${GUIDE_URL}`]: guideRoute(),
        [`GET ${ORG}/extensions`]: () => json(200, { extensions: [] }),
      },
      { locale: "zh" },
    );
    expect(await screen.findByRole("button", { name: "启用" })).toBeTruthy();
    await settle();
    expect(screen.queryByRole("region", { name: zh.setupGuide.title })).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});

describe("connector detail: 接入指南 with the drift notice", () => {
  const routes = (over: Record<string, unknown> = {}): Routes => ({
    [`GET ${ORG}/connectors/app1`]: () => json(200, { connector: connector(over) }),
    [`GET ${ORG}/catalog/${ITEM}`]: () => json(200, orgDetail()),
    [`GET ${GUIDE_URL}`]: guideRoute(),
    // the live rows' cached states (a fresh result: nothing runs)
    [`GET ${GUIDE_URL}/checks`]: () =>
      json(200, { results: { "oauth-client": { status: "ok", checkedAt: T } } }),
  });

  it("connector detail shows drift and acks", async () => {
    resetNavigation("/connectors/app1");
    const calls = stubApi({
      ...routes({ guideDrift: { from: "0.1.0", to: "0.2.0" } }),
      [`POST ${ORG}/connectors/app1/guide-ack`]: () =>
        json(200, { connector: connector({ guideDrift: null }) }),
    });
    const { container } = await renderRouteWithCache("/connectors/app1", lastStubRoutes(), {
      locale: "zh",
    });
    const notice =
      "Slack 插件更新了连接器的接入配置（v0.1.0 → v0.2.0）：需要在 Slack 应用里更新 manifest。";
    // on the tools tab: the notice leads to 接入指南
    expect(await screen.findByText(notice)).toBeTruthy();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: zh.setupGuide.openGuide }));
    expect(
      (await screen.findByRole("tab", { name: zh.connectors.detail.tabs.guide })).getAttribute(
        "aria-selected",
      ),
    ).toBe("true");
    expect(await screen.findByText("Create the Slack OAuth app")).toBeTruthy();
    // read for the connector, admin text, in the UI language
    expect(
      calls.some((c) => c.url === `${GUIDE_URL}?audience=admin&locale=zh&connectorId=app1`),
    ).toBe(true);
    // a saved target: live rows, no 保存后检查
    const row = screen.getByRole("group", { name: "OAuth client works" });
    expect(row).toBeTruthy();
    expect(screen.queryByText(zh.setupGuide.checksAfterSave)).toBeNull();
    expect(screen.getAllByText(notice)).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "我已更新 Slack 应用" }));
    await vi.waitFor(() =>
      expect(bodyOf(calls.find((c) => c.method === "POST"))).toEqual({ hash: "a".repeat(64) }),
    );
    await vi.waitFor(() => expect(screen.queryByText(notice)).toBeNull());
    expect(findNestedBoxes(container)).toEqual([]);
  });

  it("a first load of ?tab=guide with drift paints the guide and the notice", async () => {
    resetNavigation("/connectors/app1");
    const browser = expectNoFirstPaintFetch();
    await renderRouteWithCache(
      "/connectors/app1?tab=guide",
      routes({ guideDrift: { from: "0.1.0", to: "0.2.0" } }),
      { locale: "en" },
    );
    expect(await screen.findByText("Create the Slack OAuth app")).toBeTruthy();
    expect(screen.getByText(/changed the connector's setup/)).toBeTruthy();
    await settle();
    expect(browser).toEqual([]);
  });

  it("the notice names the plugin by its guide when the catalog item is unreadable", async () => {
    resetNavigation("/connectors/app1");
    stubApi({
      ...routes({ guideDrift: { from: "0.1.0", to: "0.2.0" } }),
      [`GET ${ORG}/catalog/${ITEM}`]: () =>
        json(404, { error: { code: "catalog.item_not_found", message: "Catalog item not found" } }),
    });
    await renderRouteWithCache("/connectors/app1", lastStubRoutes(), { locale: "en" });
    expect(
      await screen.findByText(
        "The slack plugin changed the connector's setup (v0.1.0 → v0.2.0): update the manifest in your slack app.",
      ),
    ).toBeTruthy();
  });

  it("?tab=guide opens 接入指南; no drift, no notice", async () => {
    resetNavigation("/connectors/app1");
    stubApi(routes());
    await renderRouteWithCache("/connectors/app1?tab=guide", lastStubRoutes(), { locale: "en" });
    expect(await screen.findByText("Create the Slack OAuth app")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /I updated/ })).toBeNull();
  });

  it("members get no 接入指南 tab, even with drift", async () => {
    resetNavigation("/connectors/app1");
    const calls = stubApi(routes({ guideDrift: { from: "0.1.0", to: "0.2.0" } }));
    await renderRouteWithCache("/connectors/app1?tab=guide", lastStubRoutes(), {
      locale: "en",
      me: MEMBER,
    });
    expect(
      await screen.findByRole("tab", { name: new RegExp(`^${en.connectors.detail.tabs.tools}`) }),
    ).toBeTruthy();
    await settle();
    expect(screen.queryByRole("tab", { name: en.connectors.detail.tabs.guide })).toBeNull();
    expect(screen.queryByText(/changed the connector's setup/)).toBeNull();
    expect(calls.some((c) => c.url.startsWith(GUIDE_URL))).toBe(false);
  });
});

describe("如何连接: the member text in a sheet", () => {
  /** The card's 如何连接, in its ⋯ beside the one primary: the menu item, once the guide is read. */
  const howTo = async (locale: "zh" | "en" = "en") => {
    const more = await screen.findByRole("button", { name: MORE[locale] });
    const items = await openCardMenu(more.closest("li") as HTMLElement, MORE[locale]);
    const label = locale === "zh" ? zh.setupGuide.howToConnect : G.howToConnect;
    return items.find((i) => i.textContent === label) as HTMLElement;
  };
  const routes = (o: { audiences?: string[] } = {}): Routes => ({
    [`GET ${ORG}/connectors`]: () => json(200, { connectors: [connector()] }),
    [`GET ${ORG}/connectors/app1`]: () => json(200, { connector: connector() }),
    [`GET ${ORG}/components?kind=connector_template`]: () => json(200, { components: [] }),
    [`GET ${GUIDE_URL}`]: guideRoute(o),
  });

  it("member sheet shows member text only", async () => {
    resetNavigation("/account/connections");
    const browser = expectNoFirstPaintFetch();
    const view = await renderRouteWithCache("/account/connections", routes(), {
      locale: "en",
      me: MEMBER,
    });
    await screen.findByRole("button", { name: MORE.en });
    await settle();
    // the layout read whether the guide has a member section, the member text
    expect(browser).toEqual([]);
    expect(
      view.calls.some((c) => c.url === `${GUIDE_URL}?audience=member&locale=en&connectorId=app1`),
    ).toBe(true);
    expect(findNestedBoxes(view.container)).toEqual([]);
    const calls = stubApi(routes());
    await userEvent.setup().click(await howTo());
    const sheet = await screen.findByRole("dialog", { name: "How to connect Slack" });
    expect(within(sheet).getByText("Connect your Slack account")).toBeTruthy();
    expect(within(sheet).queryByText("Create the Slack OAuth app")).toBeNull();
    expect(within(sheet).getByRole("group", { name: "Your account is connected" })).toBeTruthy();
    expect(calls.some((c) => c.url.includes("audience=admin"))).toBe(false);
    // members never see the admin link
    expect(within(sheet).queryByRole("link", { name: G.adminGuideLink })).toBeNull();
  });

  it("org admin sees the admin guide link in the sheet", async () => {
    resetNavigation("/account/connections");
    stubApi(routes());
    await renderRouteWithCache("/account/connections", lastStubRoutes(), { locale: "zh" });
    await userEvent.setup().click(await howTo("zh"));
    const sheet = await screen.findByRole("dialog", { name: "如何连接 Slack" });
    // an org admin reads the member text as a member would
    expect(await within(sheet).findByText("Connect your Slack account")).toBeTruthy();
    expect(
      within(sheet).getByRole("link", { name: zh.setupGuide.adminGuideLink }).getAttribute("href"),
    ).toBe("/connectors/app1?tab=guide");
  });

  it("sheet link absent without a member section", async () => {
    resetNavigation("/account/connections");
    stubApi(routes({ audiences: ["admin"] }));
    const first = await renderRouteWithCache("/account/connections", lastStubRoutes(), {
      locale: "en",
      me: MEMBER,
    });
    expect(await screen.findByRole("button", { name: en.connections.oauthConnect })).toBeTruthy();
    await settle();
    // nothing else for a member: 连接 alone, no ⋯
    expect(footControls(screen.getByRole("listitem"))).toEqual([en.connections.oauthConnect]);
    // a connector without a guide reads none
    cleanup();
    stubApi({
      ...routes(),
      [`GET ${ORG}/connectors`]: () => json(200, { connectors: [connector({ setupGuide: null })] }),
      [`GET ${ORG}/connectors/app1`]: () =>
        json(200, { connector: connector({ setupGuide: null }) }),
    });
    const second = await renderRouteWithCache("/account/connections", lastStubRoutes(), {
      locale: "en",
      me: MEMBER,
    });
    await screen.findByRole("button", { name: en.connections.oauthConnect });
    await settle();
    expect(screen.queryByRole("button", { name: G.howToConnect })).toBeNull();
    expect(first.calls.some((c) => c.url.startsWith(GUIDE_URL))).toBe(true);
    expect(second.calls.some((c) => c.url.startsWith(GUIDE_URL))).toBe(false);
  });

  it("the /connectors card offers 如何连接 to members", async () => {
    stubApi(routes());
    await renderRouteWithCache("/connectors", lastStubRoutes(), { locale: "en", me: MEMBER });
    const list = await screen.findByRole("list", { name: en.connectors.title });
    const card = within(list).getByRole("listitem");
    expect(footControls(card)).toEqual([en.connections.oauthConnect, MORE.en]);
    await userEvent.setup().click(await howTo());
    const sheet = await screen.findByRole("dialog", { name: "How to connect Slack" });
    expect(within(sheet).getByText("Connect your Slack account")).toBeTruthy();
    expect(within(sheet).queryByRole("link", { name: G.adminGuideLink })).toBeNull();
  });
});

describe("/admin/connectors/templates/<id>: the template's guide for the platform", () => {
  const COMPONENT = {
    kind: "connector_template",
    id: "c2",
    name: "slack",
    displayName: { en: "Slack workspace", zh: "Slack 工作区" },
    description: null,
    plugin: "slack",
    itemId: ITEM,
    owner: { kind: "platform" },
    shareable: false,
    promoted: false,
    builtin: false,
    scopeMode: "follow",
    scope: "optional",
    orgs: [],
    disabled: false,
    pluginStopped: false,
    shownToOthers: true,
    version: "0.2.0",
    onIn: [],
  };
  const catalogItem = (setupGuides: unknown[]) => ({
    item: {
      ...ORG_ITEM,
      packageName: "@capybara-hq/plugin-slack",
      deletedAt: null,
      owner: { kind: "platform" },
    },
    versions: [
      {
        version: "0.2.0",
        source: "npm",
        sourceRef: "@capybara-hq/plugin-slack@0.2.0",
        integrity: null,
        contentDigest: null,
        sourceDetail: null,
        manifest: {
          name: "slack",
          version: "0.2.0",
          publisher: "capybara-hq",
          description: "Slack",
          setupGuides,
        },
        size: 1,
        extensionSha256: null,
        importedAt: T,
      },
    ],
    hasIcon: false,
  });
  const routes = (setupGuides: unknown[]): Routes => ({
    "GET /api/v1/admin/orgs": () => json(200, { orgs: [] }),
    "GET /api/v1/admin/components?kind=connector_template": () =>
      json(200, { components: [COMPONENT] }),
    "GET /api/v1/admin/components/connector_template/c2/versions": () =>
      json(200, { versions: [] }),
    [`GET /api/v1/admin/catalog/items/${ITEM}`]: () => json(200, catalogItem(setupGuides)),
    [`GET ${ADMIN_GUIDE_URL}`]: () =>
      json(200, {
        guide: {
          ...rendered("admin"),
          unresolved: [
            { name: "orgName", reason: "no_org" },
            { name: "connectorName", reason: "no_org" },
          ],
        },
      }),
  });

  it("admin template page renders the guide without checks", async () => {
    resetNavigation("/admin/connectors/templates/c2");
    const calls = stubApi(
      routes([
        { id: "slack-app", place: "channel-connection" },
        { id: "slack-connector", place: "connector-template", templates: ["slack"] },
      ]),
    );
    const { container } = await renderRouteWithCache(
      "/admin/connectors/templates/c2",
      lastStubRoutes(),
      { locale: "en" },
    );
    await userEvent
      .setup()
      .click(await screen.findByRole("tab", { name: en.adminComponents.detail.tabs.guide }));
    expect(await screen.findByText("Create the Slack OAuth app")).toBeTruthy();
    expect(screen.getByText(G.platformHint)).toBeTruthy();
    expect(calls.some((c) => c.url === `${ADMIN_GUIDE_URL}?locale=en&templateId=slack`)).toBe(true);
    // no target: no check rows, no notice; the org's names stay as written
    expect(screen.queryByRole("group", { name: "OAuth client works" })).toBeNull();
    expect(screen.queryByText("OAuth client works")).toBeNull();
    expect(screen.queryByRole("button", { name: /I updated/ })).toBeNull();
    // no org to ask an agent in: the platform preview has no 让智能体协助
    expect(screen.queryByRole("button", { name: G.askAgent.action })).toBeNull();
    expect(
      screen.getByText(G.unresolved.no_org.replace("{names}", "{{orgName}}, {{connectorName}}")),
    ).toBeTruthy();
    expect(findNestedBoxes(container)).toEqual([]);
  });

  it("no 接入指南 tab when the plugin has no guide for the template", async () => {
    resetNavigation("/admin/connectors/templates/c2");
    stubApi(routes([{ id: "slack-app", place: "channel-connection" }]));
    await renderRouteWithCache("/admin/connectors/templates/c2", lastStubRoutes(), {
      locale: "en",
    });
    expect(
      await screen.findByRole("tab", { name: en.adminComponents.detail.tabs.versions }),
    ).toBeTruthy();
    await settle();
    expect(screen.queryByRole("tab", { name: en.adminComponents.detail.tabs.guide })).toBeNull();
  });
});
