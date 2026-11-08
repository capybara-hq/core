import { findNestedBoxes } from "@capybara-hq/design/reference";
import { act, cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { setupGuideQuery } from "../src/lib/query/channels";
import { bodyOf, json, lastStubRoutes, stubApi } from "./support/api";
import { resetNavigation } from "./support/navigation";
import { renderRouteWithCache } from "./support/query";
import { pickOption } from "./support/select";

// Markdown setup guides on the channel pages (setup guides v2 spec §7.3, §8, §9.2, §11).

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

const BASE = "/api/v1/orgs/o1";
const GUIDE_URL = `${BASE}/catalog/item1/guides/app`;
const WJ = "⁠";
/** Prose as a person reads it: the kernel's anti-autolink word joiners are invisible. */
const plain = (s: string | null | undefined) => (s ?? "").replaceAll(WJ, "");
const SCHEMA = {
  type: "object",
  properties: { appId: { type: "string", minLength: 1 } },
  required: ["appId"],
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
const PLUGINS = [
  {
    plugin: "slack",
    displayName: { zh: "Slack", en: "Slack" },
    version: "0.2.0",
    enabled: true,
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
const CHANNEL = {
  id: "ch1",
  orgId: "o1",
  plugin: "slack",
  pluginDisplayName: { zh: "Slack", en: "Slack" },
  pluginIcon: null,
  name: "Acme Bot",
  agentId: "ag1",
  unboundPolicy: "bind",
  status: "active",
  inboundMode: "long_connection",
  webhookSupported: true,
  webhookUrl: null,
  lastError: null,
  botUserId: "B1",
  tenantId: "T1",
  config: { appId: "A1" },
  secrets: [],
  setupGuide: { itemId: "item1", guideId: "app", version: "0.2.0" },
  guideDrift: { from: "0.1.0", to: "0.2.0" },
  createdBy: "a1",
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
};

type Unresolved = { name: string; reason: string }[];

/** The kernel's rendered guide (spec §7.2) for a mode: `webhook` has its own manifest and check. */
const rendered = (
  mode: string,
  o: { name?: string; unresolved?: Unresolved; hash?: string; title?: string } = {},
) => ({
  itemId: "item1",
  plugin: "slack",
  version: "0.2.0",
  id: "app",
  place: "channel-connection",
  locale: "zh",
  title: o.title ?? "创建 Slack 应用",
  modes: ["long_connection", "webhook"],
  mode,
  audiences: ["admin"],
  audience: "admin",
  blocks: [
    {
      kind: "markdown",
      // a name that looks like a URL arrives with a word joiner; a url variable as an explicit link
      text: `## 1. 从 manifest 创建应用\n\n打开 [Slack 应用](https://api.slack.com/apps)，名字 https:${WJ}//evil.example。`,
    },
    mode === "webhook"
      ? {
          kind: "code",
          language: "yaml",
          title: "manifest.webhook.yaml",
          text: 'request_url: "{{webhookUrl}}"\n',
        }
      : {
          kind: "code",
          language: "yaml",
          title: "manifest.socket.yaml",
          text: `display_information:\n  name: "${o.name ?? "Acme Bot"}"\nsettings:\n  socket_mode_enabled: true\n`,
        },
    mode === "webhook"
      ? { kind: "check", id: "capybara:webhook-seen", label: "Slack 已调用回调地址" }
      : { kind: "check", id: "app-token", label: "应用令牌有效" },
  ],
  checks: [
    mode === "webhook"
      ? { id: "capybara:webhook-seen", label: "Slack 已调用回调地址", source: "kernel" }
      : { id: "app-token", label: "应用令牌有效", source: "plugin" },
  ],
  unresolved:
    o.unresolved ?? (mode === "webhook" ? [{ name: "webhookUrl", reason: "not_saved" }] : []),
  hash: o.hash ?? (mode === "webhook" ? "b".repeat(64) : "a".repeat(64)),
  target: null,
});

const guideRoute = (call: { url: string }) => {
  const q = new URL(call.url, "http://x").searchParams;
  return json(200, {
    guide: rendered(q.get("mode") ?? "long_connection", { name: q.get("name") ?? "" }),
  });
};

const settle = () => act(() => new Promise((r) => setTimeout(r, 20)));
const g = zh.setupGuide;
const names = (template: string, ...n: string[]) =>
  template.replace("{names}", n.map((x) => `{{${x}}}`).join(", "));

beforeEach(() => resetNavigation("/channels"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function openNewChannel(routes: Record<string, (c: { url: string }) => Response> = {}) {
  const calls = stubApi({
    [`GET ${BASE}/extensions`]: () => json(200, { extensions: PLUGINS }),
    [`GET ${BASE}/agents`]: () => json(200, { agents: AGENTS }),
    [`GET ${BASE}/channels/schema/slack`]: () =>
      json(200, { plugin: "slack", schema: SCHEMA, guide: { itemId: "item1", guideId: "app" } }),
    [`GET ${GUIDE_URL}`]: guideRoute,
    ...routes,
  });
  const view = await renderRouteWithCache("/channels/new", lastStubRoutes(), { locale: "zh" });
  const user = userEvent.setup();
  expect(screen.queryByText(g.title)).toBeNull();
  await pickOption(
    await screen.findByRole("combobox", { name: new RegExp(`^${zh.channels.form.pluginLabel}`) }),
    "slack",
    user,
  );
  return { ...view, calls, user };
}

describe("新建渠道: 接入指南 once the plugin is picked", () => {
  it("renders blocks with copy buttons", async () => {
    const { calls, user, container } = await openNewChannel();
    expect(await screen.findByText("创建 Slack 应用")).toBeTruthy();
    // read in the UI language
    expect(calls.some((c) => c.url === `${GUIDE_URL}?locale=zh`)).toBe(true);
    // prose as Markdown: the heading, the explicit link, and the word joiner kept as sent
    expect(screen.getByRole("heading", { name: "1. 从 manifest 创建应用" })).toBeTruthy();
    const link = screen.getByRole("link", { name: "Slack 应用" });
    expect(link.getAttribute("href")).toBe("https://api.slack.com/apps");
    const prose = link.closest("p");
    expect(prose?.textContent).toContain(`https:${WJ}//evil.example`);
    expect(plain(prose?.textContent)).toContain("名字 https://evil.example。");
    expect(screen.queryByRole("link", { name: /evil/ })).toBeNull();
    // the code block with its title; the name typed so far fills it (sent as `name`)
    expect(screen.getByText("manifest.socket.yaml")).toBeTruthy();
    await user.type(
      screen.getByRole("textbox", { name: new RegExp(`^${zh.channels.form.nameLabel}`) }),
      "Sales",
    );
    await vi.waitFor(() => expect(screen.getByText(/name: "Sales"/)).toBeTruthy(), {
      timeout: 2000,
    });
    expect(calls.some((c) => c.url === `${GUIDE_URL}?locale=zh&name=Sales`)).toBe(true);
    await user.click(screen.getByRole("button", { name: "复制" }));
    expect(await navigator.clipboard.readText()).toContain('name: "Sales"');
    expect(findNestedBoxes(container)).toEqual([]);
  });

  it("mode switch re-queries with mode", async () => {
    const { calls, user } = await openNewChannel();
    expect(await screen.findByText("manifest.socket.yaml")).toBeTruthy();
    await user.click(screen.getByRole("radio", { name: g.modes.webhook }));
    expect(await screen.findByText("manifest.webhook.yaml")).toBeTruthy();
    expect(calls.some((c) => c.url === `${GUIDE_URL}?mode=webhook&locale=zh`)).toBe(true);
    // the rows follow the mode
    expect(screen.getByRole("group", { name: "Slack 已调用回调地址" })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "应用令牌有效" })).toBeNull();
  });

  it("check rows static with 保存后检查 on 新建渠道", async () => {
    await openNewChannel();
    const row = await screen.findByRole("group", { name: "应用令牌有效" });
    expect(within(row).getByText(g.checkAfterSave)).toBeTruthy();
    expect(within(row).queryByRole("button")).toBeNull();
  });

  it("unresolved lines by reason (not saved yet)", async () => {
    const { user } = await openNewChannel();
    await screen.findByText("manifest.socket.yaml");
    await user.click(screen.getByRole("radio", { name: g.modes.webhook }));
    const line = await screen.findByText(names(g.unresolved.not_saved, "webhookUrl"));
    expect(line.textContent).toContain("保存后显示");
  });

  it("a plugin without a guide shows no section", async () => {
    stubApi({
      [`GET ${BASE}/extensions`]: () => json(200, { extensions: PLUGINS }),
      [`GET ${BASE}/agents`]: () => json(200, { agents: AGENTS }),
      [`GET ${BASE}/channels/schema/slack`]: () =>
        json(200, { plugin: "slack", schema: SCHEMA, guide: null }),
    });
    await renderRouteWithCache("/channels/new", lastStubRoutes(), { locale: "en" });
    await pickOption(
      await screen.findByRole("combobox", { name: new RegExp(`^${en.channels.form.pluginLabel}`) }),
      "slack",
      userEvent.setup(),
    );
    await screen.findByRole("textbox", { name: /^appId/ });
    await settle();
    expect(screen.queryByText(en.setupGuide.title)).toBeNull();
  });
});

describe("channel detail: 接入指南 and the drift notice", () => {
  const detailRoutes = (overrides: Record<string, (c: { url: string }) => Response> = {}) => ({
    [`GET ${BASE}/channels/ch1`]: () => json(200, { channel: CHANNEL }),
    [`GET ${BASE}/agents`]: () => json(200, { agents: AGENTS }),
    [`GET ${BASE}/channels/schema/slack`]: () =>
      json(200, { plugin: "slack", schema: SCHEMA, guide: { itemId: "item1", guideId: "app" } }),
    [`GET ${GUIDE_URL}`]: guideRoute,
    ...overrides,
  });

  it("drift callout and ack posts the shown hash", async () => {
    const calls = stubApi(
      detailRoutes({
        [`POST ${BASE}/channels/ch1/guide-ack`]: () =>
          json(200, { channel: { ...CHANNEL, guideDrift: null } }),
      }),
    );
    const { container } = await renderRouteWithCache("/channels/ch1", lastStubRoutes(), {
      locale: "zh",
    });
    expect(
      await screen.findByText(
        "Slack 插件更新了接入配置（v0.1.0 → v0.2.0）：需要在 Slack 应用里更新 manifest 并重新安装。",
      ),
    ).toBeTruthy();
    expect(await screen.findByText("创建 Slack 应用")).toBeTruthy();
    // read for the connection (its mode by default)
    expect(calls.some((c) => c.url === `${GUIDE_URL}?locale=zh&connectionId=ch1`)).toBe(true);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "我已更新 Slack 应用" }));
    await vi.waitFor(() =>
      expect(bodyOf(calls.find((c) => c.method === "POST"))).toEqual({ hash: "a".repeat(64) }),
    );
    await vi.waitFor(() => expect(screen.queryByRole("button", { name: /我已更新/ })).toBeNull());
    expect(screen.getByText(g.title)).toBeTruthy();
    expect(findNestedBoxes(container)).toEqual([]);
  });

  it("acks the connection's own mode even after switching the view", async () => {
    const calls = stubApi(
      detailRoutes({
        [`POST ${BASE}/channels/ch1/guide-ack`]: () =>
          json(200, { channel: { ...CHANNEL, guideDrift: null } }),
      }),
    );
    await renderRouteWithCache("/channels/ch1", lastStubRoutes(), { locale: "zh" });
    const user = userEvent.setup();
    await screen.findByText("manifest.socket.yaml");
    await user.click(screen.getByRole("radio", { name: g.modes.webhook }));
    await screen.findByText("manifest.webhook.yaml");
    await user.click(screen.getByRole("button", { name: "我已更新 Slack 应用" }));
    await vi.waitFor(() =>
      expect(bodyOf(calls.find((c) => c.method === "POST"))).toEqual({ hash: "a".repeat(64) }),
    );
  });

  it("409 guide_changed refetches and shows the new guide", async () => {
    let version = 1;
    const calls = stubApi(
      detailRoutes({
        [`GET ${GUIDE_URL}`]: () =>
          json(200, {
            guide:
              version === 1
                ? rendered("long_connection")
                : rendered("long_connection", {
                    hash: "c".repeat(64),
                    title: "创建新版 Slack 应用",
                  }),
          }),
        [`POST ${BASE}/channels/ch1/guide-ack`]: () => {
          version = 2;
          return json(409, {
            error: { code: "channel.guide_changed", message: "The setup guide changed" },
          });
        },
      }),
    );
    await renderRouteWithCache("/channels/ch1", lastStubRoutes(), { locale: "zh" });
    const user = userEvent.setup();
    await screen.findByText("创建 Slack 应用");
    await user.click(screen.getByRole("button", { name: "我已更新 Slack 应用" }));
    expect(await screen.findByText("创建新版 Slack 应用")).toBeTruthy();
    // the notice stays; confirming again records the new hash
    await user.click(screen.getByRole("button", { name: "我已更新 Slack 应用" }));
    await vi.waitFor(() =>
      expect(bodyOf(calls.filter((c) => c.method === "POST")[1])).toEqual({
        hash: "c".repeat(64),
      }),
    );
  });

  it("unresolved lines by reason (deployment settings)", async () => {
    stubApi(
      detailRoutes({
        [`GET ${BASE}/channels/ch1`]: () =>
          json(200, { channel: { ...CHANNEL, inboundMode: "webhook", guideDrift: null } }),
        [`GET ${GUIDE_URL}`]: () =>
          json(200, {
            guide: rendered("webhook", {
              unresolved: [
                { name: "publicUrl", reason: "public_url" },
                { name: "webhookUrl", reason: "webhook_base" },
                { name: "signInCallbackUrl", reason: "public_url" },
              ],
            }),
          }),
      }),
    );
    await renderRouteWithCache("/channels/ch1", lastStubRoutes(), { locale: "zh" });
    const pub = await screen.findByText(
      names(g.unresolved.public_url, "publicUrl", "signInCallbackUrl"),
    );
    expect(pub.textContent).toContain("需要超级管理员设置 http.publicUrl");
    expect(screen.getByText(names(g.unresolved.webhook_base, "webhookUrl"))).toBeTruthy();
    expect(screen.queryByText(/保存后显示/)).toBeNull();
  });

  it("a saved connection's checks are not shown as 保存后检查", async () => {
    stubApi(
      detailRoutes({
        [`GET ${BASE}/channels/ch1`]: () =>
          json(200, { channel: { ...CHANNEL, guideDrift: null } }),
      }),
    );
    await renderRouteWithCache("/channels/ch1", lastStubRoutes(), { locale: "zh" });
    const row = await screen.findByRole("group", { name: "应用令牌有效" });
    expect(within(row).queryByText(g.checkAfterSave)).toBeNull();
  });

  it("the guide read is keyed by version, target, mode, audience and language", () => {
    const ref = { itemId: "item1", guideId: "app" };
    const key = (version: string, q: Parameters<typeof setupGuideQuery>[2]) =>
      setupGuideQuery("o1", { ...ref, version }, q).queryKey;
    expect(key("0.2.0", { connectionId: "ch1" })).not.toEqual(
      key("0.3.0", { connectionId: "ch1" }),
    );
    expect(key("0.2.0", { locale: "zh" })).not.toEqual(key("0.2.0", { locale: "en" }));
    expect(key("0.2.0", { audience: "admin" })).not.toEqual(key("0.2.0", { audience: "member" }));
    expect(key("0.2.0", { connectorId: "c1" })).not.toEqual(key("0.2.0", { connectorId: "c2" }));
  });

  it("no setup guide: no section, no notice", async () => {
    stubApi(
      detailRoutes({
        [`GET ${BASE}/channels/ch1`]: () =>
          json(200, { channel: { ...CHANNEL, setupGuide: null, guideDrift: null } }),
        [`GET ${BASE}/channels/schema/slack`]: () =>
          json(200, { plugin: "slack", schema: SCHEMA, guide: null }),
      }),
    );
    await renderRouteWithCache("/channels/ch1", lastStubRoutes(), { locale: "en" });
    expect(await screen.findByText(en.channels.detail.statusTitle)).toBeTruthy();
    await settle();
    expect(screen.queryByText(en.setupGuide.title)).toBeNull();
    expect(screen.queryByRole("button", { name: /I updated/ })).toBeNull();
  });
});
