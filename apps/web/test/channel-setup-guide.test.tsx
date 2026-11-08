import { findNestedBoxes } from "@capybara-hq/design/reference";
import { act, cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { bodyOf, json, lastStubRoutes, stubApi } from "./support/api";
import { resetNavigation } from "./support/navigation";
import { renderRouteWithCache } from "./support/query";
import { pickOption } from "./support/select";

// Plugin setup guides on the channel pages (spec 2026-11-08-plugin-setup-guides-design.md §5, §6).

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

/** The kernel's rendered guide for a mode (`webhook` has its own file and an unresolved URL). */
const rendered = (mode: string, name = "Acme Bot") => ({
  itemId: "item1",
  plugin: "slack",
  version: "0.2.0",
  id: "app",
  place: "channel-connection",
  title: { en: "Create the Slack app", zh: "创建 Slack 应用" },
  modes: ["long_connection", "webhook"],
  mode,
  steps: [{ en: "Open `https://api.slack.com/apps`.", zh: "打开 `https://api.slack.com/apps`。" }],
  files: [
    {
      title: { en: "App manifest", zh: "应用 manifest" },
      language: "yaml",
      fileName: mode === "webhook" ? "manifest.webhook.yaml" : "manifest.socket.yaml",
      content:
        mode === "webhook"
          ? 'request_url: "{{webhookUrl}}"\n'
          : `display_information:\n  name: "${name}"\nsettings:\n  socket_mode_enabled: true\n`,
    },
  ],
  unresolved: mode === "webhook" ? ["webhookUrl"] : [],
  hash: mode === "webhook" ? "b".repeat(64) : "a".repeat(64),
});

const guideRoute = (call: { url: string }) => {
  const q = new URL(call.url, "http://x").searchParams;
  return json(200, { guide: rendered(q.get("mode") ?? "long_connection", q.get("name") ?? "") });
};

const settle = () => act(() => new Promise((r) => setTimeout(r, 20)));

beforeEach(() => resetNavigation("/channels"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("新建渠道: 接入指南 once the plugin is picked", () => {
  it("shows the steps, the filled-in manifest with 复制, and switches mode", async () => {
    const calls = stubApi({
      [`GET ${BASE}/extensions`]: () => json(200, { extensions: PLUGINS }),
      [`GET ${BASE}/agents`]: () => json(200, { agents: AGENTS }),
      [`GET ${BASE}/channels/schema/slack`]: () =>
        json(200, { plugin: "slack", schema: SCHEMA, guide: { itemId: "item1", guideId: "app" } }),
      [`GET ${GUIDE_URL}`]: guideRoute,
    });
    const { container } = await renderRouteWithCache("/channels/new", lastStubRoutes(), {
      locale: "zh",
    });
    const g = zh.channels.guide;
    // nothing before a plugin is picked
    expect(screen.queryByText(g.title)).toBeNull();
    const user = userEvent.setup();
    await pickOption(
      await screen.findByRole("combobox", { name: new RegExp(`^${zh.channels.form.pluginLabel}`) }),
      "slack",
      user,
    );
    expect(await screen.findByText("创建 Slack 应用")).toBeTruthy();
    const steps = screen.getByRole("list", { name: g.stepsLabel });
    expect(within(steps).getByText("https://api.slack.com/apps").tagName).toBe("CODE");
    // the name typed so far fills the manifest (sent as `name`)
    await user.type(
      screen.getByRole("textbox", { name: new RegExp(`^${zh.channels.form.nameLabel}`) }),
      "Sales",
    );
    await vi.waitFor(() => expect(screen.getByText(/name: "Sales"/)).toBeTruthy(), {
      timeout: 2000,
    });
    expect(calls.some((c) => c.url === `${GUIDE_URL}?name=Sales`)).toBe(true);
    await user.click(screen.getByRole("button", { name: "复制" }));
    // user-event's clipboard stands in for the browser's
    expect(await navigator.clipboard.readText()).toContain('name: "Sales"');
    expect(screen.getByRole("button", { name: "已复制" })).toBeTruthy();
    // the webhook mode: its file, and the unresolved URL said once
    await user.click(screen.getByRole("radio", { name: zh.channels.inboundMode.webhook }));
    expect(await screen.findByText(/request_url/)).toBeTruthy();
    expect(screen.getByText(/\{\{webhookUrl\}\} 现在还没有值/)).toBeTruthy();
    expect(findNestedBoxes(container)).toEqual([]);
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
    expect(screen.queryByText(en.channels.guide.title)).toBeNull();
  });
});

describe("channel detail: 接入指南 and the drift notice", () => {
  it("shows the guide for the connection and the notice; 我已更新 records the shown hash", async () => {
    const calls = stubApi({
      [`GET ${BASE}/channels/ch1`]: () => json(200, { channel: CHANNEL }),
      [`GET ${BASE}/agents`]: () => json(200, { agents: AGENTS }),
      [`GET ${BASE}/channels/schema/slack`]: () =>
        json(200, { plugin: "slack", schema: SCHEMA, guide: { itemId: "item1", guideId: "app" } }),
      [`GET ${GUIDE_URL}`]: guideRoute,
      [`POST ${BASE}/channels/ch1/guide-ack`]: () =>
        json(200, { channel: { ...CHANNEL, guideDrift: null } }),
    });
    const { container } = await renderRouteWithCache("/channels/ch1", lastStubRoutes(), {
      locale: "zh",
    });
    const g = zh.channels.guide;
    const notice = await screen.findByText(
      "Slack 插件更新了接入配置（v0.1.0 → v0.2.0）：需要在 Slack 应用里更新 manifest 并重新安装。",
    );
    expect(notice).toBeTruthy();
    expect(await screen.findByText("创建 Slack 应用")).toBeTruthy();
    // read for the connection (its mode by default)
    expect(calls.some((c) => c.url === `${GUIDE_URL}?connectionId=ch1`)).toBe(true);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "我已更新 Slack 应用" }));
    await vi.waitFor(() =>
      expect(bodyOf(calls.find((c) => c.method === "POST"))).toEqual({ hash: "a".repeat(64) }),
    );
    await vi.waitFor(() => expect(screen.queryByRole("button", { name: /我已更新/ })).toBeNull());
    expect(screen.getByText(g.title)).toBeTruthy();
    expect(findNestedBoxes(container)).toEqual([]);
  });

  it("no setup guide: no section, no notice", async () => {
    stubApi({
      [`GET ${BASE}/channels/ch1`]: () =>
        json(200, { channel: { ...CHANNEL, setupGuide: null, guideDrift: null } }),
      [`GET ${BASE}/agents`]: () => json(200, { agents: AGENTS }),
      [`GET ${BASE}/channels/schema/slack`]: () =>
        json(200, { plugin: "slack", schema: SCHEMA, guide: null }),
    });
    await renderRouteWithCache("/channels/ch1", lastStubRoutes(), { locale: "en" });
    expect(await screen.findByText(en.channels.detail.statusTitle)).toBeTruthy();
    await settle();
    expect(screen.queryByText(en.channels.guide.title)).toBeNull();
    expect(screen.queryByRole("button", { name: /I updated/ })).toBeNull();
  });
});
