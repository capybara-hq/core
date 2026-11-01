import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import NewAgentPage from "../src/app/(app)/agents/new/page";
import AgentsPage from "../src/app/(app)/agents/page";
import { SetupContext } from "../src/components/shell/setup";
import { agentFormDefaults, renderEditAgent, renderNewAgent } from "./support/agents";
import { json as apiJson, stubApi } from "./support/api";
import { resetNavigation, router } from "./support/navigation";
import { ME, renderPage } from "./support/render";
import { expectNoFirstPaintFetch, onServer, renderRoute } from "./support/server";
import { NOT_READY } from "./support/shell";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const CAPS = {
  tools: true,
  vision: false,
  reasoning: false,
  caching: false,
  midConversationSystem: false,
};
const MODELS = {
  providers: [
    {
      provider: "model-fake",
      models: [{ id: "fake-1", displayName: "Fake 1", capabilities: CAPS, parameters: [] }],
    },
    {
      provider: "other",
      models: [{ id: "o-1", displayName: "O 1", capabilities: CAPS, parameters: [] }],
    },
  ],
};

/**
 * The browser answers only the create (`posts`); the server reads the models from the same routes.
 */
function stub(warnings: string[], models: unknown = MODELS) {
  const posts: unknown[] = [];
  stubApi({
    "GET /api/v1/orgs/o1/models": () => json(200, models),
    "POST /api/v1/orgs/o1/agents": (c) => {
      posts.push(JSON.parse(String(c.body)));
      return json(201, { agent: { id: "ag1" }, warnings });
    },
  });
  return posts;
}

/** 兜底模型下拉框的名称带「可选」后缀。 */
const startsWith = (label: string) => (name: string) => name.startsWith(label);

beforeEach(() => resetNavigation("/agents/new"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("新建 Agent 页（FormPage）", () => {
  it("使用 FormPage 模板，分组「基本信息」「模型」，ActionRow 中「保存」为主操作", async () => {
    stub([]);
    const { container } = await renderNewAgent({ locale: "zh" });
    await screen.findAllByRole("option", { name: "model-fake / Fake 1", hidden: true });
    expect(container.querySelector('[data-template="FormPage"]')).not.toBeNull();
    expect(screen.getByRole("region", { name: zh.agents.form.basicSection })).toBeTruthy();
    expect(screen.getByRole("region", { name: zh.agents.form.modelSection })).toBeTruthy();
    const row = screen.getByRole("region", { name: "待提交改动" });
    const save = within(row).getByRole("button", { name: zh.agents.form.submit });
    expect(save.getAttribute("data-variant")).toBe("primary");
    expect(within(row).getByRole("button", { name: zh.common.cancel })).toBeTruthy();
  });

  it("模型下拉框来自 /models；保存发送定义，没有警告时直接回到列表", async () => {
    const posts = stub([]);
    await renderNewAgent();
    const user = userEvent.setup();
    await screen.findAllByRole("option", { name: "model-fake / Fake 1", hidden: true });
    await user.type(screen.getByRole("textbox", { name: en.agents.form.nameLabel }), "Echo");
    await user.selectOptions(
      screen.getByRole("combobox", { name: en.agents.form.modelLabel }),
      "model-fake/fake-1",
    );
    await user.click(screen.getByRole("button", { name: en.agents.form.submit }));
    expect(posts[0]).toEqual({
      definition: {
        name: "Echo",
        instructions: "",
        model: { provider: "model-fake", model: "fake-1" },
        fallback: null,
        modelParams: {},
        fallbackParams: {},
        // 默认勾选两个内置工具；没有收紧策略
        tools: [
          { kind: "builtin", name: "ask_user" },
          { kind: "builtin", name: "read_tool_output" },
        ],
        toolPolicies: {},
      },
      visibility: "private",
    });
    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith("/agents");
  });

  it("inside the setup layout a saved agent lands on a new conversation with it", async () => {
    stub([]);
    const { element } = await onServer(() => NewAgentPage(), {
      ...agentFormDefaults(),
      "GET /api/v1/orgs/o1/models": () => json(200, MODELS),
    });
    renderPage(
      <SetupContext.Provider
        value={{ active: true, readiness: { kind: "unknown" }, recheck: async () => {} }}
      >
        {element}
      </SetupContext.Provider>,
    );
    const user = userEvent.setup();
    await screen.findAllByRole("option", { name: "model-fake / Fake 1", hidden: true });
    await user.type(screen.getByRole("textbox", { name: en.agents.form.nameLabel }), "Echo");
    await user.selectOptions(
      screen.getByRole("combobox", { name: en.agents.form.modelLabel }),
      "model-fake/fake-1",
    );
    await user.click(screen.getByRole("button", { name: en.agents.form.submit }));
    await vi.waitFor(() => expect(router.push).toHaveBeenCalledWith("/chat?agent=ag1"));
    expect(router.push).toHaveBeenCalledTimes(1);
  });

  it("在名称框按 Enter 即保存（只提交一次）；在指令多行框按 Enter 只换行", async () => {
    // 带数字参数框：表单里有多个单行输入框，浏览器不会做隐式提交
    const temperature = {
      key: "temperature",
      standard: "temperature",
      schema: { type: "number", minimum: 0, maximum: 2 },
      label: { zh: "温度", en: "Temperature" },
    };
    const posts = stub([], {
      providers: [
        {
          provider: "model-fake",
          models: [
            { id: "fake-1", displayName: "Fake 1", capabilities: CAPS, parameters: [temperature] },
          ],
        },
      ],
    });
    await renderNewAgent();
    const user = userEvent.setup();
    await screen.findAllByRole("option", { name: "model-fake / Fake 1", hidden: true });
    await user.type(
      screen.getByRole("textbox", { name: startsWith(en.agents.form.instructionsLabel) }),
      "a{Enter}b",
    );
    expect(posts).toHaveLength(0);
    await user.type(screen.getByRole("textbox", { name: en.agents.form.nameLabel }), "Echo{Enter}");
    await vi.waitFor(() => expect(router.push).toHaveBeenCalledWith("/agents"));
    expect(posts).toHaveLength(1);
    expect(
      (posts[0] as { definition: { name: string; instructions: string } }).definition,
    ).toMatchObject({
      name: "Echo",
      instructions: "a\nb",
    });
  });

  it("名称为空时不提交，名称字段显示错误", async () => {
    const posts = stub([]);
    await renderNewAgent();
    const user = userEvent.setup();
    await screen.findAllByRole("option", { name: "model-fake / Fake 1", hidden: true });
    await user.click(screen.getByRole("button", { name: en.agents.form.submit }));
    expect(posts).toHaveLength(0);
    const name = screen.getByRole("textbox", { name: en.agents.form.nameLabel });
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText(`${en.agents.form.nameRequired}`)).toBeTruthy();
  });

  it.each(["zh", "en"] as const)(
    "保存后在表单顶部列出 warnings，点「继续」才回到列表（%s）",
    async (locale) => {
      const m = locale === "zh" ? zh : en;
      const posts = stub(["fallback_same_provider"]);
      await renderNewAgent({ locale });
      const user = userEvent.setup();
      await screen.findAllByRole("option", { name: "model-fake / Fake 1", hidden: true });
      await user.type(screen.getByRole("textbox", { name: m.agents.form.nameLabel }), "Echo");
      await user.selectOptions(
        screen.getByRole("combobox", { name: startsWith(m.agents.form.fallbackLabel) }),
        "model-fake/fake-1",
      );
      await user.click(screen.getByRole("button", { name: m.agents.form.submit }));
      expect(posts[0]).toMatchObject({ definition: { fallback: { provider: "model-fake" } } });
      const warning = await screen.findByText(`${m.agents.warnings.fallback_same_provider}`);
      expect(warning.closest('[data-tone="danger"]')).not.toBeNull();
      expect(router.push).not.toHaveBeenCalled();
      // 已保存：主操作换成「继续」，不会重复创建
      expect(screen.queryByRole("button", { name: m.agents.form.submit })).toBeNull();
      await user.click(screen.getByRole("button", { name: m.agents.form.continue }));
      expect(router.push).toHaveBeenCalledWith("/agents");
      expect(posts).toHaveLength(1);
    },
  );
});

describe("the agent page lists its channels (spec 3.3.1)", () => {
  const ORG = "/api/v1/orgs/o1";
  const T = "2026-10-20T08:00:00.000Z";
  const AGENT = {
    id: "ag1",
    orgId: "o1",
    ownerAccountId: "a1",
    visibility: "org",
    currentVersion: 1,
    memberIds: null,
    needsReassignment: false,
    createdAt: T,
    updatedAt: T,
    definition: {
      name: "Helper",
      instructions: "",
      model: { provider: "model-fake", model: "fake-1" },
      fallback: null,
      modelParams: {},
      fallbackParams: {},
      tools: [],
      toolPolicies: {},
    },
  };
  const channel = (id: string, name: string, agentId: string, status = "active") => ({
    id,
    orgId: "o1",
    plugin: "slack",
    name,
    agentId,
    unboundPolicy: "bind",
    status,
    inboundMode: "long_connection",
    webhookSupported: false,
    webhookUrl: null,
    lastError: null,
    botUserId: null,
    tenantId: null,
    config: {},
    secrets: [],
    createdBy: "a1",
    createdAt: T,
    updatedAt: T,
  });
  const routes = () => ({
    [`GET ${ORG}/agents/ag1`]: () => apiJson(200, { agent: AGENT }),
    [`GET ${ORG}/models`]: () => apiJson(200, MODELS),
    [`GET ${ORG}/connectors`]: () => apiJson(200, { connectors: [] }),
    [`GET ${ORG}/skills`]: () => apiJson(200, { skills: [] }),
    [`GET ${ORG}/agents/ag1/skills`]: () => apiJson(200, { skills: [] }),
    [`GET ${ORG}/channels`]: () =>
      apiJson(200, {
        channels: [
          channel("c1", "Team Slack", "ag1"),
          channel("c2", "Other bot", "ag2"),
          channel("c3", "Broken bot", "ag1", "error"),
        ],
      }),
  });

  it("lists only this agent's connections; 接入渠道 presets the agent and the way back", async () => {
    stubApi(routes());
    await renderEditAgent({ locale: "zh" });
    const section = await screen.findByRole("region", { name: zh.agents.channels.title });
    const list = await within(section).findByRole("list", { name: zh.agents.channels.title });
    expect(within(list).getByRole("link", { name: "Team Slack" }).getAttribute("href")).toBe(
      "/channels/c1",
    );
    expect(within(list).getByText("Broken bot")).toBeTruthy();
    expect(within(list).queryByText("Other bot")).toBeNull();
    expect(within(list).getByText(zh.channels.status.error)).toBeTruthy();
    await userEvent
      .setup()
      .click(within(section).getByRole("button", { name: zh.agents.channels.connect }));
    expect(router.push).toHaveBeenCalledWith("/channels/new?agentId=ag1&returnTo=%2Fagents%2Fag1");
  });

  it("members see the list read-only: no connect button, no links", async () => {
    stubApi(routes());
    const member = {
      ...ME,
      account: { ...ME.account, isEnterpriseAdmin: false },
      memberships: [{ orgId: "o1", slug: "acme", name: "Acme", role: "member" }],
    };
    await renderEditAgent({ me: member });
    const section = await screen.findByRole("region", { name: en.agents.channels.title });
    await within(section).findByText("Team Slack");
    expect(within(section).queryByRole("button", { name: en.agents.channels.connect })).toBeNull();
    expect(within(section).queryByRole("link")).toBeNull();
  });
});

describe("the agent pages render on the server (web-SSR spec §6)", () => {
  const ORG = "/api/v1/orgs/o1";
  const T = "2026-10-20T08:00:00.000Z";
  const as = (role: "guest" | "member" | "admin") => ({
    ...ME,
    account: { ...ME.account, isEnterpriseAdmin: false },
    memberships: [{ orgId: "o1", slug: "acme", name: "Acme", role }],
  });
  const agent = (id: string, name: string, owner = "a1") => ({
    id,
    orgId: "o1",
    ownerAccountId: owner,
    visibility: "org",
    currentVersion: 1,
    memberIds: null,
    needsReassignment: false,
    createdAt: T,
    updatedAt: T,
    definition: {
      name,
      instructions: "",
      model: { provider: "model-fake", model: "fake-1" },
      fallback: null,
      modelParams: {},
      fallbackParams: {},
      tools: [{ kind: "connector", connectorId: "cn1", tools: "all" }],
      toolPolicies: {},
    },
  });
  const connector = {
    id: "cn1",
    name: "Tracker",
    status: "active",
    tools: [{ key: "tracker__find", status: "enabled" }],
  };
  const ok = (body: unknown) => () => apiJson(200, body);
  const formRoutes = {
    [`GET ${ORG}/models`]: ok(MODELS),
    [`GET ${ORG}/connectors`]: ok({ connectors: [connector] }),
    [`GET ${ORG}/connectors/cn1`]: ok({ connector }),
    [`GET ${ORG}/skills`]: ok({
      skills: [{ id: "s1", name: "notes-style", description: "Notes.", source: "org" }],
    }),
  };
  const template = (name: string) => document.querySelector(`[data-template="${name}"]`);

  it("/agents: the list is the first paint, guests included", async () => {
    const browser = expectNoFirstPaintFetch();
    const { calls } = await renderRoute(
      () => AgentsPage(),
      { [`GET ${ORG}/agents`]: ok({ agents: [agent("ag1", "Echo agent")] }) },
      { me: as("guest") },
    );
    expect(calls.map((c) => c.url)).toContain(`${ORG}/agents`);
    expect(screen.getByText("Echo agent")).toBeTruthy();
    expect(screen.queryByRole("link", { name: en.agents.new })).toBeNull();
    expect(browser).toEqual([]);
  });

  it("/agents: without a current org it renders nothing; while the org is in setup it redirects home", async () => {
    const none = await renderRoute(() => AgentsPage(), {}, { me: { ...ME, currentOrgId: null } });
    expect(none.calls.map((c) => c.url)).toEqual(["/api/v1/me"]);
    expect(template("ListPage")).toBeNull();
    await expect(renderRoute(() => AgentsPage(), {}, { readiness: NOT_READY })).rejects.toThrow(
      "REDIRECT /",
    );
  });

  it("/agents/new: models, connectors and skills are in the first paint", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderNewAgent({ routes: formRoutes });
    expect(
      (screen.getByRole("combobox", { name: en.agents.form.modelLabel }) as HTMLSelectElement)
        .value,
    ).toBe("model-fake/fake-1");
    expect(screen.getByRole("checkbox", { name: /Tracker/ })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: /notes-style/ })).toBeTruthy();
    expect(browser).toEqual([]);
  });

  it("/agents/new: a guest gets no access and nothing is read; it is a setup step", async () => {
    const guest = await renderNewAgent({ routes: formRoutes, me: as("guest") });
    expect(new Set(guest.calls.map((c) => c.url))).toEqual(
      new Set(["/api/v1/me", `${ORG}/readiness`]),
    );
    expect(template("StatusPage")?.getAttribute("data-kind")).toBe("no-access");
    cleanup();
    expectNoFirstPaintFetch();
    await renderNewAgent({ routes: formRoutes, readiness: NOT_READY });
    expect(template("FormPage")).not.toBeNull();
    cleanup();
    const none = await renderNewAgent({ me: { ...ME, currentOrgId: null } });
    expect(none.calls.map((c) => c.url)).toEqual(["/api/v1/me"]);
    expect(template("FormPage")).toBeNull();
  });

  it("/agents/new: a section the kernel fails (agent templates) still renders the form", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderNewAgent({
      routes: {
        ...formRoutes,
        [`GET ${ORG}/agent-templates`]: () => apiJson(500, { error: { code: "internal" } }),
      },
    });
    expect(screen.getByRole("button", { name: en.agents.form.submit })).toBeTruthy();
    expect(browser).toEqual([]);
  });

  it("/agents/<id>: the form, the selected connector's tools and the channels are the first paint", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderEditAgent({
      routes: { ...formRoutes, [`GET ${ORG}/agents/ag1`]: ok({ agent: agent("ag1", "Helper") }) },
      readiness: NOT_READY,
    });
    expect(screen.getByRole("heading", { level: 1, name: "Helper" })).toBeTruthy();
    expect(document.querySelector('[data-policy="tracker__find"]')).not.toBeNull();
    expect(screen.getByRole("region", { name: en.agents.channels.title })).toBeTruthy();
    expect(browser).toEqual([]);
  });

  it("/agents/<id>: someone who may not change it reads only the agent (read-only view)", async () => {
    const browser = expectNoFirstPaintFetch();
    const { calls } = await renderEditAgent({
      routes: { [`GET ${ORG}/agents/ag1`]: ok({ agent: agent("ag1", "Helper", "someone") }) },
      me: as("member"),
    });
    expect(new Set(calls.map((c) => c.url))).toEqual(
      new Set(["/api/v1/me", `${ORG}/readiness`, `${ORG}/agents/ag1`]),
    );
    expect(screen.getByText(en.agents.readOnly)).toBeTruthy();
    expect(browser).toEqual([]);
  });

  it("/agents/<id>: an agent the kernel does not find is the not-found page", async () => {
    await expect(
      renderEditAgent({
        routes: {
          [`GET ${ORG}/agents/ag1`]: () =>
            apiJson(404, { error: { code: "agent.not_found", message: "x" } }),
        },
      }),
    ).rejects.toThrow("NOT_FOUND");
  });

  it("/agents/<id>: channels the kernel fails show the section's own error to an admin", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderEditAgent({
      routes: {
        ...formRoutes,
        [`GET ${ORG}/agents/ag1`]: ok({ agent: agent("ag1", "Helper") }),
        [`GET ${ORG}/channels`]: () => apiJson(500, { error: { code: "internal" } }),
      },
    });
    expect(screen.getByText(en.agents.channels.loadFailed)).toBeTruthy();
    expect(browser).toEqual([]);
  });
});
