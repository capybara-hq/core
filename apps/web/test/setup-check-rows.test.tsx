import { findNestedBoxes } from "@capybara-hq/design/reference";
import { act, cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import type { Me } from "../src/lib/session";
import { bodyOf, type Call, json, lastStubRoutes, stubApi } from "./support/api";
import { resetNavigation } from "./support/navigation";
import { renderRouteWithCache } from "./support/query";
import { ME } from "./support/render";
import { pickOption } from "./support/select";
import { expectNoFirstPaintFetch } from "./support/server";

// Live setup check rows (setup guides v2 spec §10.3, §10.4): the cached states first, a run for
// each row without a fresh result, polling while one runs elsewhere, 重新检查 with `force` and its
// cooldown, the per-account limit, and the places that stay without live rows.

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
const CHECKS_URL = `${GUIDE_URL}/checks`;
const RUN_URL = `${CHECKS_URL}/app-token/run`;
const KERNEL_RUN_URL = `${CHECKS_URL}/capybara%3Apublic-url/run`;
const T = "2026-11-09T00:00:00.000Z";
const settle = (ms = 30) => act(() => new Promise((r) => setTimeout(r, ms)));
const D = { zh: { recheck: "重新检查" }, en: { recheck: "Re-check" } };

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
  guideDrift: null,
  createdBy: "a1",
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
};

/** A rendered channel guide (spec §7.2) with a plugin check and a kernel check. */
const rendered = (target: { kind: string; id: string } | null = null) => ({
  itemId: "item1",
  plugin: "slack",
  version: "0.2.0",
  id: "app",
  place: "channel-connection",
  locale: "zh",
  title: "创建 Slack 应用",
  modes: ["long_connection", "webhook"],
  mode: "long_connection",
  audiences: [],
  audience: "admin",
  blocks: [
    { kind: "markdown", text: "## 1. 复制令牌" },
    { kind: "check", id: "app-token", label: "应用令牌有效" },
    { kind: "check", id: "capybara:public-url", label: "已设置公网地址" },
  ],
  checks: [
    { id: "app-token", label: "应用令牌有效", source: "plugin" },
    { id: "capybara:public-url", label: "已设置公网地址", source: "kernel" },
  ],
  unresolved: [],
  hash: "a".repeat(64),
  target,
});

const OK = {
  status: "ok",
  reason: { en: "The app token works.", zh: "应用令牌可用。" },
  checkedAt: T,
};
const PUBLIC_OK = { status: "ok", reason: { en: "The public URL is set." }, checkedAt: T };

type Handler = (c: Call) => Response;

function detailRoutes(o: { states: Handler; run?: Handler; kernelRun?: Handler }) {
  return {
    [`GET ${BASE}/channels/ch1`]: () => json(200, { channel: CHANNEL }),
    [`GET ${BASE}/agents`]: () => json(200, { agents: AGENTS }),
    [`GET ${BASE}/channels/schema/slack`]: () =>
      json(200, { plugin: "slack", schema: SCHEMA, guide: { itemId: "item1", guideId: "app" } }),
    [`GET ${GUIDE_URL}`]: () =>
      json(200, { guide: rendered({ kind: "channel-connection", id: "ch1" }) }),
    [`GET ${CHECKS_URL}`]: o.states,
    [`POST ${RUN_URL}`]: o.run ?? (() => json(200, { result: OK })),
    [`POST ${KERNEL_RUN_URL}`]: o.kernelRun ?? (() => json(200, { result: PUBLIC_OK })),
  };
}

async function openDetail(o: Parameters<typeof detailRoutes>[0], locale: "zh" | "en" = "zh") {
  const calls = stubApi(detailRoutes(o));
  const view = await renderRouteWithCache("/channels/ch1", lastStubRoutes(), { locale });
  await screen.findByText("创建 Slack 应用");
  return { ...view, calls, user: userEvent.setup() };
}

const row = (label: string) => screen.getByRole("group", { name: label });
const posts = (calls: Call[], url = RUN_URL) =>
  calls.filter((c) => c.method === "POST" && c.url === url);
const gets = (calls: Call[]) =>
  calls.filter((c) => c.method === "GET" && c.url.startsWith(CHECKS_URL));

beforeEach(() => resetNavigation("/channels/ch1"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("channel detail: live check rows", () => {
  it("runs not_run checks once on view", async () => {
    const { calls, container } = await openDetail({
      states: () =>
        json(200, {
          results: { "app-token": { status: "not_run" }, "capybara:public-url": PUBLIC_OK },
        }),
    });
    // the states for the connection and its mode, then a run of the row without a result
    await vi.waitFor(() =>
      expect(within(row("应用令牌有效")).getByText("应用令牌可用。")).toBeTruthy(),
    );
    expect(
      gets(calls).some((c) => c.url === `${CHECKS_URL}?connectionId=ch1&mode=long_connection`),
    ).toBe(true);
    expect(posts(calls).map(bodyOf)).toEqual([{ connectionId: "ch1", mode: "long_connection" }]);
    // the kernel check had a fresh result: not run; its English reason without a Chinese one
    expect(posts(calls, KERNEL_RUN_URL)).toHaveLength(0);
    expect(within(row("已设置公网地址")).getByText("The public URL is set.")).toBeTruthy();
    await settle();
    expect(posts(calls)).toHaveLength(1);
    expect(findNestedBoxes(container)).toEqual([]);
  });

  it("does not rerun fresh results", async () => {
    const { calls } = await openDetail({
      states: () => json(200, { results: { "app-token": OK, "capybara:public-url": PUBLIC_OK } }),
    });
    expect(await screen.findByText("应用令牌可用。")).toBeTruthy();
    expect(within(row("应用令牌有效")).getByText("通过")).toBeTruthy();
    await settle();
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
  });

  it("shows failing with reason and fix, and unknown with its reason", async () => {
    await openDetail(
      {
        states: () =>
          json(200, {
            results: {
              "app-token": {
                status: "failing",
                reason: { en: "Slack rejected the app token." },
                fix: { en: "Copy the app-level token again." },
                checkedAt: T,
              },
              "capybara:public-url": {
                status: "unknown",
                reason: { en: "The check timed out" },
                checkedAt: T,
              },
            },
          }),
      },
      "en",
    );
    const failing = await screen.findByRole("group", { name: "应用令牌有效" });
    expect(within(failing).getByText("Slack rejected the app token.")).toBeTruthy();
    expect(within(failing).getByText("Copy the app-level token again.")).toBeTruthy();
    expect(within(failing).getByText("Failed")).toBeTruthy();
    const unknown = row("已设置公网地址");
    expect(within(unknown).getByText("The check timed out")).toBeTruthy();
    expect(within(unknown).getByText("Unknown")).toBeTruthy();
  });

  it("polls while running and stops", async () => {
    let n = 0;
    const { calls } = await openDetail({
      states: () => {
        n += 1;
        return json(200, {
          results: {
            "app-token": n < 3 ? { status: "running" } : OK,
            "capybara:public-url": PUBLIC_OK,
          },
        });
      },
    });
    // running elsewhere: a spinner, no button, nothing started here
    const running = row("应用令牌有效");
    expect(within(running).getByRole("img", { name: "检查中" })).toBeTruthy();
    expect(within(running).queryByRole("button")).toBeNull();
    await vi.waitFor(() => expect(screen.getByText("应用令牌可用。")).toBeTruthy(), {
      timeout: 4000,
    });
    const settled = gets(calls).length;
    expect(settled).toBe(3);
    await settle(1300);
    expect(gets(calls)).toHaveLength(settled);
    expect(posts(calls)).toHaveLength(0);
  });

  it("a run answered running is polled to its result", async () => {
    let ran = false;
    const { calls } = await openDetail({
      states: () =>
        json(200, {
          results: {
            "app-token": ran ? OK : { status: "not_run" },
            "capybara:public-url": PUBLIC_OK,
          },
        }),
      run: () => {
        // another replica holds the run: its result lands in the cache
        ran = true;
        return json(200, { result: { status: "running" } });
      },
    });
    await vi.waitFor(() => expect(screen.getByText("应用令牌可用。")).toBeTruthy(), {
      timeout: 4000,
    });
    expect(posts(calls)).toHaveLength(1);
  });

  it("recheck sends force and honors cooldownUntil", async () => {
    const later = new Date(Date.now() + 10_000).toISOString();
    const { calls, user } = await openDetail({
      states: () => json(200, { results: { "app-token": OK, "capybara:public-url": PUBLIC_OK } }),
      run: () =>
        json(200, {
          result: {
            status: "ok",
            reason: { en: "Still works.", zh: "仍然可用。" },
            checkedAt: new Date().toISOString(),
            cooldownUntil: later,
          },
        }),
    });
    await screen.findByText("应用令牌可用。");
    const button = within(row("应用令牌有效")).getByRole("button", {
      name: `${D.zh.recheck} 应用令牌有效`,
    });
    expect(button.hasAttribute("disabled")).toBe(false);
    await user.click(button);
    expect(await screen.findByText("仍然可用。")).toBeTruthy();
    expect(posts(calls).map(bodyOf)).toEqual([
      { connectionId: "ch1", mode: "long_connection", force: true },
    ]);
    // within the cooldown the button waits
    expect(
      within(row("应用令牌有效"))
        .getByRole("button", { name: `${D.zh.recheck} 应用令牌有效` })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it("a cached cooldown from the states disables Re-check", async () => {
    const later = new Date(Date.now() + 10_000).toISOString();
    await openDetail(
      {
        states: () =>
          json(200, {
            results: {
              "app-token": { ...OK, cooldownUntil: later },
              "capybara:public-url": PUBLIC_OK,
            },
          }),
      },
      "en",
    );
    await screen.findByText("The app token works.");
    expect(
      within(row("应用令牌有效"))
        .getByRole("button", { name: `${D.en.recheck} 应用令牌有效` })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it("429 keeps the last state with a muted line", async () => {
    const { user } = await openDetail({
      states: () => json(200, { results: { "app-token": OK, "capybara:public-url": PUBLIC_OK } }),
      run: () =>
        json(429, { error: { code: "rate_limited", message: "Too many setup check runs" } }),
    });
    await screen.findByText("应用令牌可用。");
    await user.click(
      within(row("应用令牌有效")).getByRole("button", { name: `${D.zh.recheck} 应用令牌有效` }),
    );
    expect(await screen.findByText(zh.setupGuide.checksRateLimited)).toBeTruthy();
    // the last result stays
    expect(within(row("应用令牌有效")).getByText("应用令牌可用。")).toBeTruthy();
    expect(within(row("应用令牌有效")).getByText("通过")).toBeTruthy();
  });

  it("429 on the first runs stops the rest", async () => {
    const { calls } = await openDetail(
      {
        states: () =>
          json(200, {
            results: {
              "app-token": { status: "not_run" },
              "capybara:public-url": { status: "not_run" },
            },
          }),
        run: () => json(429, { error: { code: "rate_limited", message: "Too many" } }),
        kernelRun: () => json(429, { error: { code: "rate_limited", message: "Too many" } }),
      },
      "en",
    );
    expect(await screen.findByText(en.setupGuide.checksRateLimited)).toBeTruthy();
    await settle();
    // each row asked at most once; both still not checked
    expect(posts(calls).length).toBeLessThanOrEqual(1);
    expect(posts(calls, KERNEL_RUN_URL).length).toBeLessThanOrEqual(1);
    expect(within(row("应用令牌有效")).getByText("Not checked")).toBeTruthy();
  });
});

describe("places without live rows", () => {
  it("new channel page keeps static rows", async () => {
    const calls = stubApi({
      [`GET ${BASE}/extensions`]: () => json(200, { extensions: PLUGINS }),
      [`GET ${BASE}/agents`]: () => json(200, { agents: AGENTS }),
      [`GET ${BASE}/channels/schema/slack`]: () =>
        json(200, { plugin: "slack", schema: SCHEMA, guide: { itemId: "item1", guideId: "app" } }),
      [`GET ${GUIDE_URL}`]: () => json(200, { guide: rendered() }),
    });
    resetNavigation("/channels");
    await renderRouteWithCache("/channels/new", lastStubRoutes(), { locale: "zh" });
    await pickOption(
      await screen.findByRole("combobox", {
        name: new RegExp(`^${zh.channels.form.pluginLabel}`),
      }),
      "slack",
      userEvent.setup(),
    );
    expect(await screen.findByText(zh.setupGuide.checksAfterSave)).toBeTruthy();
    expect(screen.queryByRole("group", { name: "应用令牌有效" })).toBeNull();
    await settle();
    expect(calls.some((c) => c.url.startsWith(CHECKS_URL))).toBe(false);
  });
});

// The connector template place: the admin rows on the connector page, the member rows in the
// 如何连接 sheet (only the member text's checks).
const ITEM = "11111111-1111-4111-8111-111111111111";
const C_GUIDE_URL = `${BASE}/catalog/${ITEM}/guides/slack-connector`;
const C_CHECKS_URL = `${C_GUIDE_URL}/checks`;
const MEMBER: Me = {
  ...ME,
  account: { ...ME.account, isSuperAdmin: false },
  memberships: [{ orgId: "o1", slug: "acme", name: "Acme", role: "member" }],
};
const OAUTH = { type: "oauth_code", ownership: "personal", discovery: "manual", client: "manual" };
const connector = {
  id: "app1",
  slug: "slack",
  name: "Slack",
  connector: "connector-mcp",
  endpoint: { url: "https://slack.example.test/mcp" },
  auth: OAUTH,
  status: "active",
  platformTemplateId: "t-slack",
  icon: null,
  setupGuide: { itemId: ITEM, guideId: "slack-connector", version: "0.2.0" },
  guideDrift: null,
  createdAt: T,
  updatedAt: T,
  tools: [],
  credential: { ownership: "personal", status: "missing" },
};
const connectorGuide = (audience: "admin" | "member") => ({
  itemId: ITEM,
  plugin: "slack",
  version: "0.2.0",
  id: "slack-connector",
  place: "connector-template",
  locale: "en",
  title: audience === "admin" ? "Create the Slack OAuth app" : "Connect your Slack account",
  modes: [],
  mode: null,
  audiences: ["admin", "member"],
  audience,
  blocks:
    audience === "admin"
      ? [{ kind: "check", id: "oauth-client", label: "OAuth client works" }]
      : [{ kind: "check", id: "capybara:connector-connected", label: "Your account is connected" }],
  checks:
    audience === "admin"
      ? [{ id: "oauth-client", label: "OAuth client works", source: "plugin" }]
      : [
          {
            id: "capybara:connector-connected",
            label: "Your account is connected",
            source: "kernel",
          },
        ],
  unresolved: [],
  hash: "a".repeat(64),
  target: { kind: "connector", id: "app1" },
});
const connectorGuideRoute = (c: Call) => {
  const audience = new URL(c.url, "http://x").searchParams.get("audience") as "admin" | "member";
  return json(200, { guide: connectorGuide(audience) });
};

describe("connector template place: live rows", () => {
  it("connector detail reads and shows the admin checks for the connector", async () => {
    resetNavigation("/connectors/app1");
    const calls = stubApi({
      [`GET ${BASE}/connectors/app1`]: () => json(200, { connector }),
      [`GET ${BASE}/catalog/${ITEM}`]: () =>
        json(404, { error: { code: "catalog.item_not_found" } }),
      [`GET ${C_GUIDE_URL}`]: connectorGuideRoute,
      [`GET ${C_CHECKS_URL}`]: () =>
        json(200, {
          results: {
            "oauth-client": {
              status: "ok",
              reason: { en: "The client is accepted." },
              checkedAt: T,
            },
          },
        }),
    });
    await renderRouteWithCache("/connectors/app1", lastStubRoutes(), { locale: "en" });
    await userEvent
      .setup()
      .click(await screen.findByRole("tab", { name: en.connectors.detail.tabs.guide }));
    expect(await screen.findByText("The client is accepted.")).toBeTruthy();
    expect(calls.some((c) => c.url === `${C_CHECKS_URL}?connectorId=app1&audience=admin`)).toBe(
      true,
    );
  });

  it("a first load of ?tab=guide paints the states from the server", async () => {
    resetNavigation("/connectors/app1");
    const browser = expectNoFirstPaintFetch();
    await renderRouteWithCache(
      "/connectors/app1?tab=guide",
      {
        [`GET ${BASE}/connectors/app1`]: () => json(200, { connector }),
        [`GET ${BASE}/catalog/${ITEM}`]: () =>
          json(404, { error: { code: "catalog.item_not_found" } }),
        [`GET ${C_GUIDE_URL}`]: connectorGuideRoute,
        [`GET ${C_CHECKS_URL}`]: () =>
          json(200, {
            results: {
              "oauth-client": {
                status: "ok",
                reason: { en: "The client is accepted." },
                checkedAt: T,
              },
            },
          }),
      },
      { locale: "en" },
    );
    expect(await screen.findByText("The client is accepted.")).toBeTruthy();
    await settle();
    expect(browser).toEqual([]);
  });

  it("members only see the member checks in the sheet", async () => {
    resetNavigation("/account/connections");
    const routes = {
      [`GET ${BASE}/connectors`]: () => json(200, { connectors: [connector] }),
      [`GET ${BASE}/connectors/app1`]: () => json(200, { connector }),
      [`GET ${BASE}/components?kind=connector_template`]: () => json(200, { components: [] }),
      [`GET ${C_GUIDE_URL}`]: connectorGuideRoute,
      [`GET ${C_CHECKS_URL}`]: () =>
        json(200, { results: { "capybara:connector-connected": { status: "not_run" } } }),
      [`POST ${C_CHECKS_URL}/capybara%3Aconnector-connected/run`]: () =>
        json(200, {
          result: {
            status: "failing",
            reason: { en: "You have not connected yet." },
            fix: { en: "Press Connect." },
            checkedAt: T,
          },
        }),
    };
    const calls = stubApi(routes);
    await renderRouteWithCache("/account/connections", lastStubRoutes(), {
      locale: "en",
      me: MEMBER,
    });
    await userEvent
      .setup()
      .click(await screen.findByRole("button", { name: en.setupGuide.howToConnect }));
    const sheet = await screen.findByRole("dialog", { name: "How to connect Slack" });
    expect(await within(sheet).findByText("You have not connected yet.")).toBeTruthy();
    expect(within(sheet).queryByRole("group", { name: "OAuth client works" })).toBeNull();
    expect(calls.some((c) => c.url === `${C_CHECKS_URL}?connectorId=app1&audience=member`)).toBe(
      true,
    );
    expect(calls.some((c) => c.url.includes("audience=admin"))).toBe(false);
    expect(bodyOf(calls.find((c) => c.method === "POST"))).toEqual({
      connectorId: "app1",
      audience: "member",
    });
  });
});
