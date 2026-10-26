import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import ChannelDetailPage from "../src/app/[locale]/(app)/channels/[id]/page";
import NewChannelPage from "../src/app/[locale]/(app)/channels/new/page";
import ChannelsPage from "../src/app/[locale]/(app)/channels/page";
import { bodyOf, json, stubApi } from "./support/api";
import { resetNavigation, router } from "./support/navigation";
import { renderPage } from "./support/render";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("next/navigation", () => ({ useParams: () => ({ id: "ch1" }) }));

const msgs = { zh, en } as const;
const BASE = "/api/v1/orgs/o1";
const SCHEMA = {
  type: "object",
  properties: {
    platformUrl: { type: "string", format: "uri" },
    appId: { type: "string", minLength: 1 },
    tenant: { type: "string", default: "t1" },
    appSecret: { type: "string", minLength: 1, "x-secret": true },
    webhookToken: { type: "string", "x-secret": true },
  },
  required: ["platformUrl", "appId", "appSecret"],
};
const AGENTS = [
  {
    id: "ag1",
    orgId: "o1",
    visibility: "org",
    currentVersion: 1,
    definition: { name: "Helper", instructions: "", model: { provider: "p", model: "m" } },
    updatedAt: "2026-10-01T00:00:00Z",
  },
];
const CHANNEL = {
  id: "ch1",
  orgId: "o1",
  plugin: "fake-im",
  name: "Acme Bot",
  agentId: "ag1",
  unboundPolicy: "bind",
  status: "error",
  inboundMode: "long_connection",
  webhookSupported: true,
  webhookUrl: "https://hooks.example/channels/webhook/ch1",
  lastError: "connect failed with status 503",
  botUserId: "bot-cli_acme",
  tenantId: "t1",
  config: { platformUrl: "http://im.test", appId: "cli_acme", tenant: "t1" },
  secrets: [
    { path: "appSecret", set: true },
    { path: "webhookToken", set: false },
  ],
  createdBy: "a1",
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
};
const PLUGINS = [
  {
    plugin: "fake-im",
    version: "0.1.0",
    enabled: true,
    configurable: true,
    config: null,
    secrets: [],
    permissions: [
      {
        category: "provides",
        sensitive: false,
        items: ["channel@1", "directory@1"],
        entries: [
          { value: "channel@1", sensitive: false },
          { value: "directory@1", sensitive: false },
        ],
      },
    ],
    orgConfigSchema: null,
  },
  {
    plugin: "todo",
    version: "0.1.0",
    enabled: true,
    configurable: false,
    config: null,
    secrets: [],
    permissions: [
      {
        category: "tools",
        sensitive: true,
        items: ["todo_add"],
        entries: [{ value: "todo_add", sensitive: true, reason: "tools" }],
      },
    ],
    orgConfigSchema: null,
  },
  {
    plugin: "slack",
    version: "0.1.0",
    enabled: false,
    configurable: false,
    config: null,
    secrets: [],
    permissions: [
      {
        category: "provides",
        sensitive: false,
        items: ["channel@1"],
        entries: [{ value: "channel@1", sensitive: false }],
      },
    ],
    orgConfigSchema: null,
  },
];

beforeEach(() => resetNavigation("/channels"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("渠道连接列表（ListPage）", () => {
  it.each(["zh", "en"] as const)("列出连接、agent 名与状态；点一行进详情（%s）", async (locale) => {
    const m = msgs[locale].channels;
    stubApi({
      [`GET ${BASE}/channels`]: () => json(200, { channels: [CHANNEL] }),
      [`GET ${BASE}/agents`]: () => json(200, { agents: AGENTS }),
    });
    const { container } = renderPage(<ChannelsPage />, { locale });
    expect(container.querySelector('[data-template="ListPage"]')).not.toBeNull();
    const table = await screen.findByRole("table", { name: m.title });
    const row = await within(table).findByRole("row", { name: /Acme Bot/ });
    expect(within(row).getByText("Helper")).toBeTruthy();
    expect(within(row).getByText(`✗ ${m.status.error}`)).toBeTruthy();
    expect(within(row).getByText("connect failed with status 503")).toBeTruthy();
    expect(screen.getByRole("link", { name: m.new }).getAttribute("href")).toBe("/channels/new");
    await userEvent.setup().click(within(row).getByText("Acme Bot"));
    expect(router.push).toHaveBeenCalledWith("/channels/ch1");
  });
});

describe("新建渠道连接（FormPage）", () => {
  it("只列已启用的渠道插件；按 schema 填表 → POST channels，密钥随创建提交", async () => {
    const calls = stubApi({
      [`GET ${BASE}/extensions`]: () => json(200, { extensions: PLUGINS }),
      [`GET ${BASE}/agents`]: () => json(200, { agents: AGENTS }),
      [`GET ${BASE}/channels/schema/fake-im`]: () =>
        json(200, { plugin: "fake-im", schema: SCHEMA }),
      [`POST ${BASE}/channels`]: (c) =>
        json(201, { channel: { ...CHANNEL, ...(bodyOf(c) as object) } }),
    });
    const { container } = renderPage(<NewChannelPage />);
    expect(container.querySelector('[data-template="FormPage"]')).not.toBeNull();
    const f = en.channels.form;
    const pluginSelect = await screen.findByRole("combobox", {
      name: new RegExp(`^${f.pluginLabel}`),
    });
    const options = within(pluginSelect)
      .getAllByRole("option")
      .map((o) => o.getAttribute("value"));
    // todo 不提供 channel、slack 未启用
    expect(options).toEqual(["", "fake-im"]);
    const user = userEvent.setup();
    await user.selectOptions(pluginSelect, "fake-im");
    await user.type(
      screen.getByRole("textbox", { name: new RegExp(`^${f.nameLabel}`) }),
      "Acme Bot",
    );
    await user.type(await screen.findByRole("textbox", { name: /^platformUrl/ }), "http://im.test");
    await user.type(screen.getByRole("textbox", { name: /^appId/ }), "cli_acme");
    await user.type(screen.getByLabelText(/^appSecret/), "acme-secret");
    await user.selectOptions(
      screen.getByRole("combobox", { name: new RegExp(`^${f.agentLabel}`) }),
      "ag1",
    );
    await user.click(
      screen.getByRole("radio", { name: new RegExp(`^${en.channels.policy.anonymous}`) }),
    );
    await user.click(screen.getByRole("button", { name: f.submit }));
    await vi.waitFor(() => expect(router.push).toHaveBeenCalledWith("/channels/ch1"));
    expect(bodyOf(calls.find((c) => c.method === "POST"))).toEqual({
      plugin: "fake-im",
      name: "Acme Bot",
      agentId: "ag1",
      config: {
        platformUrl: "http://im.test",
        appId: "cli_acme",
        tenant: "t1",
        appSecret: "acme-secret",
      },
      unboundPolicy: "anonymous",
    });
  });

  it("缺必填时不提交并标出错误；平台拒绝凭据（channel.verify_failed）显示译文", async () => {
    const calls = stubApi({
      [`GET ${BASE}/extensions`]: () => json(200, { extensions: PLUGINS }),
      [`GET ${BASE}/agents`]: () => json(200, { agents: AGENTS }),
      [`GET ${BASE}/channels/schema/fake-im`]: () =>
        json(200, { plugin: "fake-im", schema: SCHEMA }),
      [`POST ${BASE}/channels`]: () =>
        json(502, { error: { code: "channel.verify_failed", message: "x" } }),
    });
    renderPage(<NewChannelPage />, { locale: "zh" });
    const f = zh.channels.form;
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: f.submit }));
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
    expect(screen.getByText(`${f.nameRequired}`)).toBeTruthy();

    await user.selectOptions(
      screen.getByRole("combobox", { name: new RegExp(`^${f.pluginLabel}`) }),
      "fake-im",
    );
    await user.type(screen.getByRole("textbox", { name: new RegExp(`^${f.nameLabel}`) }), "Bot");
    await user.type(await screen.findByRole("textbox", { name: /^platformUrl/ }), "http://im.test");
    await user.type(screen.getByRole("textbox", { name: /^appId/ }), "cli");
    await user.type(screen.getByLabelText(/^appSecret/), "bad-secret");
    await user.selectOptions(
      screen.getByRole("combobox", { name: new RegExp(`^${f.agentLabel}`) }),
      "ag1",
    );
    await user.click(screen.getByRole("button", { name: f.submit }));
    expect(await screen.findByText(`✗ ${zh.errors.channel.verify_failed}`)).toBeTruthy();
  });

  it("没有启用的渠道插件：提示去插件设置", async () => {
    stubApi({
      [`GET ${BASE}/extensions`]: () => json(200, { extensions: [PLUGINS[1]] }),
      [`GET ${BASE}/agents`]: () => json(200, { agents: AGENTS }),
    });
    renderPage(<NewChannelPage />);
    expect(await screen.findByText(en.channels.form.noExtensions)).toBeTruthy();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: en.channels.form.openExtensions }));
    expect(router.push).toHaveBeenCalledWith("/settings/extensions");
  });
});

describe("渠道连接详情（DetailPage）", () => {
  const routes = (extra: Record<string, Parameters<typeof stubApi>[0][string]> = {}) =>
    stubApi({
      [`GET ${BASE}/channels/ch1`]: () => json(200, { channel: CHANNEL }),
      [`GET ${BASE}/channels/schema/fake-im`]: () =>
        json(200, { plugin: "fake-im", schema: SCHEMA }),
      [`GET ${BASE}/agents`]: () => json(200, { agents: AGENTS }),
      ...extra,
    });

  it("概览：状态与最近错误；停用 → PATCH status", async () => {
    const calls = routes({
      [`PATCH ${BASE}/channels/ch1`]: (c) =>
        json(200, {
          channel: { ...CHANNEL, ...(bodyOf(c) as object), lastError: null },
        }),
    });
    const { container } = renderPage(<ChannelDetailPage />);
    expect(container.querySelector('[data-template="DetailPage"]')).not.toBeNull();
    const d = en.channels.detail;
    expect(await screen.findByText("✗ connect failed with status 503")).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: d.disable }));
    expect(bodyOf(calls.find((c) => c.method === "PATCH"))).toEqual({ status: "disabled" });
    expect(await screen.findByRole("button", { name: d.enable })).toBeTruthy();
    expect(screen.getByText(d.noError)).toBeTruthy();
  });

  it("inbound mode: switching to webhook shows the callback URL and PATCHes inboundMode", async () => {
    const calls = routes({
      [`PATCH ${BASE}/channels/ch1`]: (c) =>
        json(200, { channel: { ...CHANNEL, ...(bodyOf(c) as object) } }),
    });
    renderPage(<ChannelDetailPage />);
    const d = en.channels.detail;
    const user = userEvent.setup();
    const save = await screen.findByRole("button", { name: d.saveInbound });
    expect(save).toHaveProperty("disabled", true);
    expect(screen.queryByDisplayValue(CHANNEL.webhookUrl)).toBeNull();
    await user.click(
      screen.getByRole("radio", { name: new RegExp(`^${en.channels.inboundMode.webhook}`) }),
    );
    const url = screen.getByDisplayValue(CHANNEL.webhookUrl) as HTMLInputElement;
    expect(url.readOnly).toBe(true);
    await user.click(save);
    await vi.waitFor(() =>
      expect(bodyOf(calls.find((c) => c.method === "PATCH"))).toEqual({ inboundMode: "webhook" }),
    );
    expect(await screen.findByText(d.inboundSaved)).toBeTruthy();
  });

  it("inbound mode: no switch without plugin support or webhook base URL", async () => {
    const d = en.channels.detail;
    routes({
      [`GET ${BASE}/channels/ch1`]: () =>
        json(200, { channel: { ...CHANNEL, webhookSupported: false, webhookUrl: null } }),
    });
    renderPage(<ChannelDetailPage />);
    expect(await screen.findByText(d.inboundUnsupported)).toBeTruthy();
    expect(screen.queryByRole("button", { name: d.saveInbound })).toBeNull();
    cleanup();
    routes({
      [`GET ${BASE}/channels/ch1`]: () => json(200, { channel: { ...CHANNEL, webhookUrl: null } }),
    });
    renderPage(<ChannelDetailPage />);
    expect(await screen.findByText(d.inboundNoBaseUrl)).toBeTruthy();
    expect(screen.queryByRole("radiogroup", { name: d.inboundLabel })).toBeNull();
    expect(screen.queryByText(`! ${d.webhookNoUrlWarning}`)).toBeNull();
    cleanup();
    // In webhook mode without a base URL: a warning, and the switch back stays available
    routes({
      [`GET ${BASE}/channels/ch1`]: () =>
        json(200, { channel: { ...CHANNEL, inboundMode: "webhook", webhookUrl: null } }),
    });
    renderPage(<ChannelDetailPage />);
    expect(await screen.findByText(`! ${d.webhookNoUrlWarning}`)).toBeTruthy();
    expect(screen.getByRole("radiogroup", { name: d.inboundLabel })).toBeTruthy();
  });

  it("凭据：已设置的密钥只显示「已设置」；替换 appSecret、其余密钥省略 → PATCH config", async () => {
    const calls = routes({
      [`PATCH ${BASE}/channels/ch1`]: () => json(200, { channel: CHANNEL }),
    });
    renderPage(<ChannelDetailPage />);
    const d = en.channels.detail;
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: d.tabs.credentials }));
    const secret = screen.getByLabelText(/^appSecret/) as HTMLInputElement;
    expect(secret.placeholder).toBe(en.schemaForm.secretSet);
    const save = screen.getByRole("button", { name: d.saveCredentials });
    expect(save).toHaveProperty("disabled", true);
    await user.click(screen.getByRole("button", { name: "Replace appSecret" }));
    await user.type(secret, "rotated-secret");
    await user.click(save);
    await vi.waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(bodyOf(calls.find((c) => c.method === "PATCH"))).toEqual({
      config: {
        platformUrl: "http://im.test",
        appId: "cli_acme",
        tenant: "t1",
        appSecret: "rotated-secret",
      },
    });
  });

  it("设置：改 agent 与策略只提交改动项；删除需输入名称确认", async () => {
    const calls = routes({
      [`PATCH ${BASE}/channels/ch1`]: (c) =>
        json(200, { channel: { ...CHANNEL, ...(bodyOf(c) as object) } }),
      [`DELETE ${BASE}/channels/ch1`]: () => new Response(null, { status: 204 }),
    });
    renderPage(<ChannelDetailPage />);
    const d = en.channels.detail;
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: d.tabs.settings }));
    await user.click(
      screen.getByRole("radio", { name: new RegExp(`^${en.channels.policy.anonymous}`) }),
    );
    await user.click(screen.getByRole("button", { name: d.save }));
    await vi.waitFor(() =>
      expect(bodyOf(calls.find((c) => c.method === "PATCH"))).toEqual({
        unboundPolicy: "anonymous",
      }),
    );
    await user.click(screen.getByRole("button", { name: d.delete }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByRole("textbox"), "Acme Bot");
    await user.click(within(dialog).getByRole("button", { name: d.delete }));
    await vi.waitFor(() => expect(router.push).toHaveBeenCalledWith("/channels"));
    expect(calls.some((c) => c.method === "DELETE")).toBe(true);
  });
});
