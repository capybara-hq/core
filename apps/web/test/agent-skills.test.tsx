import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import EditAgentPage from "../src/app/[locale]/(app)/agents/[id]/page";
import NewAgentPage from "../src/app/[locale]/(app)/agents/new/page";
import { bodyOf, json, noContent, stubApi } from "./support/api";
import { resetNavigation, router } from "./support/navigation";
import { ME, renderPage } from "./support/render";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("next/navigation", () => ({ useParams: () => ({ id: "ag1" }) }));

const msgs = { zh, en } as const;
const T = "2026-10-20T08:00:00.000Z";
const ORG = "/api/v1/orgs/o1";

const CAPS = { tools: true, vision: false, reasoning: false };
const MODELS = {
  providers: [
    {
      provider: "model-fake",
      models: [{ id: "fake-1", displayName: "Fake 1", capabilities: CAPS, parameters: [] }],
    },
  ],
};

const orgSkill = (id: string, name: string) => ({
  id,
  scope: "org",
  agentId: null,
  name,
  description: `Use for ${name}.`,
  currentVersion: 1,
  createdBy: "a1",
  createdAt: T,
  updatedAt: T,
});

const agent = (over: Record<string, unknown> = {}) => ({
  id: "ag1",
  orgId: "o1",
  ownerAccountId: "a1",
  visibility: "org",
  currentVersion: 3,
  memberIds: null,
  needsReassignment: false,
  createdAt: T,
  updatedAt: T,
  definition: {
    name: "Helper",
    instructions: "Be helpful.",
    model: { provider: "model-fake", model: "fake-1" },
    fallback: null,
    modelParams: {},
    fallbackParams: {},
    tools: [
      { kind: "builtin", name: "ask_user" },
      { kind: "plugin", plugin: "todo", name: "write" },
    ],
    toolPolicies: {},
    skills: { orgSkills: ["s1", "gone"] },
    // 表单不认识的字段：保存时原样带回
    futureField: { keep: true },
  },
  ...over,
});

const ownSkill = {
  ...orgSkill("k1", "notes-style"),
  scope: "agent",
  agentId: "ag1",
  currentVersion: 2,
};

beforeEach(() => resetNavigation("/agents/new"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("新建 agent：选择组织技能", () => {
  it.each(["zh", "en"] as const)(
    "技能分组列出组织技能，勾选后保存 skills.orgSkills（%s）",
    async (locale) => {
      const m = msgs[locale];
      const calls = stubApi({
        [`GET ${ORG}/models`]: () => json(200, MODELS),
        [`GET ${ORG}/connectors`]: () => json(200, { connectors: [] }),
        [`GET ${ORG}/skills`]: () =>
          json(200, { skills: [orgSkill("s1", "pdf-tools"), orgSkill("s2", "slides")] }),
        [`POST ${ORG}/agents`]: () => json(201, { agent: agent(), warnings: [] }),
      });
      renderPage(<NewAgentPage />, { locale });
      const user = userEvent.setup();
      const group = await screen.findByRole("group", { name: m.agents.form.orgSkillsLabel });
      await user.click(await within(group).findByRole("checkbox", { name: /pdf-tools/ }));
      expect(screen.getByRole("region", { name: m.agents.form.skillsSection })).toBeTruthy();
      await user.type(screen.getByRole("textbox", { name: m.agents.form.nameLabel }), "Echo");
      await user.click(screen.getByRole("button", { name: m.agents.form.submit }));
      await vi.waitFor(() => expect(router.push).toHaveBeenCalledWith("/agents"));
      const body = bodyOf(calls.find((c) => c.method === "POST")) as {
        definition: { skills?: unknown };
      };
      expect(body.definition.skills).toEqual({ orgSkills: ["s1"] });
    },
  );

  it.each(["zh", "en"] as const)(
    "私有 agent 显示 skill_write 确认开关，勾选后保存 writePolicy ask；改成共享后隐藏（%s）",
    async (locale) => {
      const m = msgs[locale];
      const calls = stubApi({
        [`GET ${ORG}/models`]: () => json(200, MODELS),
        [`GET ${ORG}/connectors`]: () => json(200, { connectors: [] }),
        [`GET ${ORG}/skills`]: () => json(200, { skills: [] }),
        [`POST ${ORG}/agents`]: () => json(201, { agent: agent(), warnings: [] }),
      });
      renderPage(<NewAgentPage />, { locale });
      const user = userEvent.setup();
      const sw = await screen.findByRole("checkbox", { name: m.agents.form.confirmSkillWrite });
      expect(sw).toHaveProperty("checked", false);
      await user.click(sw);
      await user.type(screen.getByRole("textbox", { name: m.agents.form.nameLabel }), "Echo");
      await user.click(screen.getByRole("button", { name: m.agents.form.submit }));
      await vi.waitFor(() => expect(router.push).toHaveBeenCalledWith("/agents"));
      const body = bodyOf(calls.find((c) => c.method === "POST")) as {
        definition: { skills?: unknown };
      };
      expect(body.definition.skills).toEqual({ orgSkills: [], writePolicy: "ask" });
    },
  );

  it("可见性改成共享后，确认开关隐藏", async () => {
    stubApi({
      [`GET ${ORG}/models`]: () => json(200, MODELS),
      [`GET ${ORG}/connectors`]: () => json(200, { connectors: [] }),
      [`GET ${ORG}/skills`]: () => json(200, { skills: [] }),
    });
    renderPage(<NewAgentPage />);
    const sw = await screen.findByRole("checkbox", { name: en.agents.form.confirmSkillWrite });
    await userEvent.click(sw);
    const unsaved = () => document.querySelector(".cb-actionrow-unsaved")?.textContent ?? "";
    expect(unsaved()).toMatch(/\b1\b/);
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: en.agents.form.visibilityLabel }),
      "org",
    );
    expect(screen.queryByRole("checkbox", { name: en.agents.form.confirmSkillWrite })).toBeNull();
    // 隐藏的开关不计入改动数：只剩可见性这一项
    expect(unsaved()).toMatch(/\b1\b/);
  });

  it("不选技能：定义里不带 skills", async () => {
    const calls = stubApi({
      [`GET ${ORG}/models`]: () => json(200, MODELS),
      [`GET ${ORG}/connectors`]: () => json(200, { connectors: [] }),
      [`GET ${ORG}/skills`]: () => json(200, { skills: [] }),
      [`POST ${ORG}/agents`]: () => json(201, { agent: agent(), warnings: [] }),
    });
    renderPage(<NewAgentPage />);
    const user = userEvent.setup();
    expect(await screen.findByText(en.agents.form.noOrgSkills)).toBeTruthy();
    await screen.findAllByRole("option", { name: "model-fake / Fake 1", hidden: true });
    await user.type(screen.getByRole("textbox", { name: en.agents.form.nameLabel }), "Echo");
    await user.click(screen.getByRole("button", { name: en.agents.form.submit }));
    await vi.waitFor(() => expect(router.push).toHaveBeenCalled());
    const body = bodyOf(calls.find((c) => c.method === "POST")) as { definition: object };
    expect("skills" in body.definition).toBe(false);
  });
});

describe("编辑 agent（FormPage）", () => {
  beforeEach(() => resetNavigation("/agents/ag1"));

  const routes = (over: Record<string, unknown> = {}) => ({
    [`GET ${ORG}/agents/ag1`]: () => json(200, { agent: agent(over) }),
    [`GET ${ORG}/models`]: () => json(200, MODELS),
    [`GET ${ORG}/connectors`]: () => json(200, { connectors: [] }),
    [`GET ${ORG}/skills`]: () => json(200, { skills: [orgSkill("s1", "pdf-tools")] }),
    [`GET ${ORG}/agents/ag1/skills`]: () => json(200, { skills: [ownSkill] }),
  });

  it("已删除的组织技能显示为「已删除」，取消勾选即移除；保存 PATCH 时保留表单不认识的字段", async () => {
    const calls = stubApi({
      ...routes(),
      [`PATCH ${ORG}/agents/ag1`]: () => json(200, { agent: agent(), warnings: [] }),
    });
    const { container } = renderPage(<EditAgentPage />);
    expect(container.querySelector('[data-template="FormPage"]')).not.toBeNull();
    const group = await screen.findByRole("group", { name: en.agents.form.orgSkillsLabel });
    const live = await within(group).findByRole("checkbox", { name: /pdf-tools/ });
    expect(live).toHaveProperty("checked", true);
    const deleted = within(group).getByRole("checkbox", {
      name: en.agents.form.deletedSkill.replace("{id}", "gone"),
    });
    expect(deleted).toHaveProperty("checked", true);
    expect(screen.getByRole("textbox", { name: en.agents.form.nameLabel })).toHaveProperty(
      "value",
      "Helper",
    );
    const user = userEvent.setup();
    await user.click(deleted);
    await user.click(screen.getByRole("button", { name: en.agents.form.submit }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const body = bodyOf(calls.find((c) => c.method === "PATCH")) as {
      definition: Record<string, unknown>;
      visibility?: string;
    };
    expect(body.definition.skills).toEqual({ orgSkills: ["s1"] });
    expect(body.definition.futureField).toEqual({ keep: true });
    expect(body.definition.tools).toEqual([
      { kind: "builtin", name: "ask_user" },
      { kind: "plugin", plugin: "todo", name: "write" },
    ]);
    expect(body.definition.instructions).toBe("Be helpful.");
    // 没改可见性：不发
    expect(body.visibility).toBeUndefined();
    expect(router.push).toHaveBeenCalledWith("/agents");
  });

  it.each(["zh", "en"] as const)(
    "agent 自己写的技能只读展示；负责人可删除（二次确认）（%s）",
    async (locale) => {
      const m = msgs[locale];
      let own = [ownSkill];
      const calls = stubApi({
        ...routes(),
        [`GET ${ORG}/agents/ag1/skills`]: () => json(200, { skills: own }),
        [`DELETE ${ORG}/agents/ag1/skills/k1`]: () => {
          own = [];
          return noContent();
        },
      });
      renderPage(<EditAgentPage />, { locale });
      const list = await screen.findByRole("group", { name: m.agents.form.ownSkillsLabel });
      expect(await within(list).findByText("notes-style · v2")).toBeTruthy();
      expect(within(list).queryByRole("checkbox")).toBeNull();
      const user = userEvent.setup();
      await user.click(
        within(list).getByRole("button", {
          name: m.agents.form.deleteOwnSkillLabel.replace("{name}", "notes-style"),
        }),
      );
      const dialog = await screen.findByRole("dialog");
      await user.type(within(dialog).getByRole("textbox"), "notes-style");
      await user.click(within(dialog).getByRole("button", { name: m.agents.form.deleteOwnSkill }));
      await vi.waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
      expect(await within(list).findByText(m.agents.form.noOwnSkills)).toBeTruthy();
    },
  );

  it("不改动直接保存：工具引用保持原顺序、skills 合并（保留不认识的键）、带 expectedVersion", async () => {
    const tools = [
      { kind: "plugin", plugin: "todo", name: "write" },
      { kind: "builtin", name: "read_tool_output" },
      { kind: "builtin", name: "ask_user" },
    ];
    const def = agent().definition;
    const calls = stubApi({
      ...routes({ definition: { ...def, tools, skills: { orgSkills: ["s1"], future: 1 } } }),
      [`PATCH ${ORG}/agents/ag1`]: () => json(200, { agent: agent(), warnings: [] }),
    });
    renderPage(<EditAgentPage />);
    const group = await screen.findByRole("group", { name: en.agents.form.orgSkillsLabel });
    await within(group).findByRole("checkbox", { name: /pdf-tools/ });
    await userEvent.setup().click(screen.getByRole("button", { name: en.agents.form.submit }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const body = bodyOf(calls.find((c) => c.method === "PATCH")) as {
      definition: Record<string, unknown>;
      expectedVersion?: number;
    };
    expect(body.definition.tools).toEqual(tools);
    expect(body.definition.skills).toEqual({ orgSkills: ["s1"], future: 1 });
    expect(body.expectedVersion).toBe(3);
  });

  it.each(["zh", "en"] as const)(
    "别人已保存过新版本：409 agent.version_conflict 显示翻译后的文案（%s）",
    async (locale) => {
      stubApi({
        ...routes(),
        [`PATCH ${ORG}/agents/ag1`]: () =>
          json(409, { error: { code: "agent.version_conflict", message: "changed" } }),
      });
      renderPage(<EditAgentPage />, { locale });
      const m = msgs[locale];
      const group = await screen.findByRole("group", { name: m.agents.form.orgSkillsLabel });
      await within(group).findByRole("checkbox", { name: /pdf-tools/ });
      await userEvent.setup().click(screen.getByRole("button", { name: m.agents.form.submit }));
      expect(await screen.findByText(new RegExp(m.errors.agent.version_conflict))).toBeTruthy();
      expect(router.push).not.toHaveBeenCalled();
    },
  );

  it("「运行记录」入口：负责人与组织管理员可见，指向按该 agent 筛选的运行记录", async () => {
    // 组织 owner（管理员）且是负责人
    stubApi(routes());
    renderPage(<EditAgentPage />);
    const link = await screen.findByRole("link", { name: en.agents.runHistory });
    expect(link.getAttribute("href")).toBe("/trajectories?agentId=ag1");
    cleanup();
    // 普通成员、是负责人：可见
    const member = {
      ...ME,
      memberships: [{ orgId: "o1", slug: "acme", name: "Acme", role: "member" }],
    };
    stubApi(routes());
    renderPage(<EditAgentPage />, { me: member });
    expect(await screen.findByRole("link", { name: en.agents.runHistory })).toBeTruthy();
    cleanup();
    // 普通成员、不是负责人：不可见
    stubApi(routes({ ownerAccountId: "someone-else" }));
    renderPage(<EditAgentPage />, { me: member });
    await screen.findByRole("group", { name: en.agents.form.ownSkillsLabel });
    expect(screen.queryByRole("link", { name: en.agents.runHistory })).toBeNull();
  });

  it("编辑：共享 agent 没有确认开关；私有 agent 已是 ask 时勾选，取消勾选去掉 writePolicy 键", async () => {
    stubApi(routes());
    renderPage(<EditAgentPage />);
    await screen.findByRole("group", { name: en.agents.form.orgSkillsLabel });
    expect(screen.queryByRole("checkbox", { name: en.agents.form.confirmSkillWrite })).toBeNull();
    cleanup();

    const def = agent().definition;
    const calls = stubApi({
      ...routes({
        visibility: "private",
        definition: { ...def, skills: { orgSkills: ["s1"], writePolicy: "ask", future: 1 } },
      }),
      [`PATCH ${ORG}/agents/ag1`]: () => json(200, { agent: agent(), warnings: [] }),
    });
    renderPage(<EditAgentPage />);
    const sw = await screen.findByRole("checkbox", { name: en.agents.form.confirmSkillWrite });
    expect(sw).toHaveProperty("checked", true);
    const user = userEvent.setup();
    await user.click(sw);
    await user.click(screen.getByRole("button", { name: en.agents.form.submit }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const body = bodyOf(calls.find((c) => c.method === "PATCH")) as {
      definition: Record<string, unknown>;
    };
    expect(body.definition.skills).toEqual({ orgSkills: ["s1"], future: 1 });
  });

  it("不是负责人：自己的技能没有删除按钮", async () => {
    stubApi(routes({ ownerAccountId: "someone-else" }));
    renderPage(<EditAgentPage />);
    const list = await screen.findByRole("group", { name: en.agents.form.ownSkillsLabel });
    await within(list).findByText("notes-style · v2");
    expect(within(list).queryByRole("button")).toBeNull();
  });

  it("读不到 agent：显示 agent.not_found 的文案", async () => {
    stubApi({
      ...routes(),
      [`GET ${ORG}/agents/ag1`]: () =>
        json(404, { error: { code: "agent.not_found", message: "x" } }),
    });
    renderPage(<EditAgentPage />, { locale: "zh" });
    expect(await screen.findByText(`${zh.errors.agent.not_found}`)).toBeTruthy();
  });
});

describe("pinned skills (skills.pinned)", () => {
  const fill = (s: string, vars: Record<string, string | number>) =>
    s.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k]));
  const pinSkill = (
    id: string,
    name: string,
    over: { suggestPinned?: boolean; entryBytes?: number } = {},
  ) => ({
    ...orgSkill(id, name),
    plugin: over.suggestPinned ? "superpowers" : null,
    sourceFormat: over.suggestPinned ? "claude-code" : "capybara",
    suggestPinned: over.suggestPinned ?? false,
    entryBytes: over.entryBytes ?? 2000,
    tokenEstimate: Math.ceil((over.entryBytes ?? 2000) / 4),
  });
  const ORG_SKILLS = [
    pinSkill("s1", "using-superpowers", { suggestPinned: true, entryBytes: 4000 }),
    pinSkill("s2", "brainstorming", { entryBytes: 8000 }),
    pinSkill("s3", "pdf-tools"),
    pinSkill("s4", "slides"),
  ];
  const editRoutes = (skills: Record<string, unknown>) => ({
    [`GET ${ORG}/agents/ag1`]: () =>
      json(200, { agent: agent({ definition: { ...agent().definition, skills } }) }),
    [`GET ${ORG}/models`]: () => json(200, MODELS),
    [`GET ${ORG}/connectors`]: () => json(200, { connectors: [] }),
    [`GET ${ORG}/skills`]: () => json(200, { skills: ORG_SKILLS }),
    [`GET ${ORG}/agents/ag1/skills`]: () => json(200, { skills: [] }),
  });

  it.each(["zh", "en"] as const)(
    "selecting a suggested skill ticks pinned by default; the owner can untick it and pin another (%s)",
    async (locale) => {
      const f = msgs[locale].agents.form;
      const calls = stubApi({
        [`GET ${ORG}/models`]: () => json(200, MODELS),
        [`GET ${ORG}/connectors`]: () => json(200, { connectors: [] }),
        [`GET ${ORG}/skills`]: () => json(200, { skills: ORG_SKILLS }),
        [`POST ${ORG}/agents`]: () => json(201, { agent: agent(), warnings: [] }),
      });
      renderPage(<NewAgentPage />, { locale });
      const user = userEvent.setup();
      const org = await screen.findByRole("group", { name: f.orgSkillsLabel });
      const pinned = screen.getByRole("group", { name: f.pinnedLabel });
      expect(within(pinned).getByText(f.noPinnable)).toBeTruthy();
      await user.click(await within(org).findByRole("checkbox", { name: /using-superpowers/ }));
      await user.click(within(org).getByRole("checkbox", { name: /brainstorming/ }));
      const using = within(pinned).getByRole("checkbox", {
        name: fill(f.pinSkill, { name: "using-superpowers" }),
      });
      expect(using).toHaveProperty("checked", true);
      expect(within(pinned).getByText(f.suggested)).toBeTruthy();
      const brain = within(pinned).getByRole("checkbox", {
        name: fill(f.pinSkill, { name: "brainstorming" }),
      });
      expect(brain).toHaveProperty("checked", false);
      await user.click(using);
      await user.click(brain);
      await user.type(screen.getByRole("textbox", { name: f.nameLabel }), "Echo");
      await user.click(screen.getByRole("button", { name: f.submit }));
      await vi.waitFor(() => expect(router.push).toHaveBeenCalledWith("/agents"));
      const body = bodyOf(calls.find((c) => c.method === "POST")) as {
        definition: { skills?: unknown };
      };
      expect(body.definition.skills).toEqual({ orgSkills: ["s1", "s2"], pinned: ["s2"] });
    },
  );

  it("while the agent's own skills load, or when they cannot be read, no pinned skill shows as deleted (batch-3 I1)", async () => {
    const f = en.agents.form;
    let release: (r: Response) => void = () => {};
    stubApi({
      ...editRoutes({ orgSkills: ["s1"], pinned: ["s1", "k1"] }),
      [`GET ${ORG}/agents/ag1/skills`]: () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    });
    renderPage(<EditAgentPage />);
    const pinned = await screen.findByRole("group", { name: f.pinnedLabel });
    // The org skills are in; the own skills are not: nothing is "deleted" yet.
    await within(await screen.findByRole("group", { name: f.orgSkillsLabel })).findByRole(
      "checkbox",
      { name: /using-superpowers/ },
    );
    expect(within(pinned).queryByRole("checkbox", { name: /k1/ })).toBeNull();
    expect(within(pinned).getByText(f.pinnedLoading)).toBeTruthy();
    release(json(200, { skills: [ownSkill] }));
    expect(
      await within(pinned).findByRole("checkbox", {
        name: fill(f.pinSkill, { name: "notes-style" }),
      }),
    ).toHaveProperty("checked", true);
    expect(within(pinned).queryByText(fill(f.deletedSkill, { id: "k1" }))).toBeNull();
    cleanup();
    vi.unstubAllGlobals();

    // A failed read keeps the pins as they are and marks none deleted.
    stubApi({
      ...editRoutes({ orgSkills: ["s1"], pinned: ["s1", "k1"] }),
      [`GET ${ORG}/agents/ag1/skills`]: () =>
        json(500, { error: { code: "internal", message: "x" } }),
    });
    renderPage(<EditAgentPage />);
    const again = await screen.findByRole("group", { name: f.pinnedLabel });
    expect(await within(again).findByText(f.pinnedUnavailable)).toBeTruthy();
    expect(within(again).queryByRole("checkbox", { name: /k1/ })).toBeNull();
  });

  it("deselecting a skill unpins it; a definition without pinned is saved without skills.pinned", async () => {
    const f = en.agents.form;
    const calls = stubApi({
      ...editRoutes({ orgSkills: ["s3"] }),
      [`PATCH ${ORG}/agents/ag1`]: () => json(200, { agent: agent(), warnings: [] }),
    });
    renderPage(<EditAgentPage />);
    const user = userEvent.setup();
    const org = await screen.findByRole("group", { name: f.orgSkillsLabel });
    const pinned = screen.getByRole("group", { name: f.pinnedLabel });
    // selecting the suggested one ticks it, deselecting it unpins it again
    await user.click(await within(org).findByRole("checkbox", { name: /using-superpowers/ }));
    expect(
      within(pinned).getByRole("checkbox", {
        name: fill(f.pinSkill, { name: "using-superpowers" }),
      }),
    ).toHaveProperty("checked", true);
    await user.click(within(org).getByRole("checkbox", { name: /using-superpowers/ }));
    expect(
      within(pinned).queryByRole("checkbox", {
        name: fill(f.pinSkill, { name: "using-superpowers" }),
      }),
    ).toBeNull();
    await user.click(screen.getByRole("button", { name: f.submit }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const body = bodyOf(calls.find((c) => c.method === "PATCH")) as {
      definition: Record<string, unknown>;
    };
    expect(body.definition.skills).toEqual({ orgSkills: ["s3"] });
  });

  it("a fourth pin is disabled with the tooMany hint; the token estimate sums the pinned skills", async () => {
    const f = en.agents.form;
    stubApi(editRoutes({ orgSkills: ["s1", "s2", "s3", "s4"], pinned: ["s1", "s2", "s3"] }));
    renderPage(<EditAgentPage />);
    const pinned = await screen.findByRole("group", { name: f.pinnedLabel });
    const slides = await within(pinned).findByRole("checkbox", {
      name: fill(f.pinSkill, { name: "slides" }),
    });
    expect(slides).toHaveProperty("checked", false);
    expect(slides).toHaveProperty("disabled", true);
    expect(within(pinned).getByText(fill(f.tooMany, { max: 3 }))).toBeTruthy();
    // 1000 + 2000 + 500 tokens
    expect(
      within(pinned).getByText(fill(f.pinnedTotal, { count: 3, max: 3, n: 3500 })),
    ).toBeTruthy();
  });

  it("an unchanged pinned set over 32 KB is a warning only; the kernel's error lines map per reason", async () => {
    const f = en.agents.form;
    const big = [
      pinSkill("s1", "using-superpowers", { entryBytes: 20000 }),
      pinSkill("s2", "brainstorming", { entryBytes: 20000 }),
      pinSkill("s3", "pdf-tools"),
    ];
    const calls = stubApi({
      ...editRoutes({ orgSkills: ["s1", "s2", "s3"], pinned: ["s1", "s2"] }),
      [`GET ${ORG}/skills`]: () => json(200, { skills: big }),
      [`PATCH ${ORG}/agents/ag1`]: () =>
        json(400, {
          error: {
            code: "agent.pinned_invalid",
            message: "x",
            details: [
              { skill: "s3", reason: "not_selected" },
              { skill: "gone", reason: "not_found" },
              { skill: "s1", reason: "duplicate" },
              { skill: "s3", reason: "too_many" },
              { skill: "s2", reason: "too_large", totalBytes: 40000 },
            ],
          },
        }),
    });
    renderPage(<EditAgentPage />);
    const pinned = await screen.findByRole("group", { name: f.pinnedLabel });
    expect(
      await within(pinned).findByText(fill(f.overLimit, { bytes: 40000, max: 32768 })),
    ).toBeTruthy();
    expect(within(pinned).getByText(f.overLimitKept)).toBeTruthy();
    const user = userEvent.setup();
    // changing the list: saving is refused until it fits
    await user.click(
      within(pinned).getByRole("checkbox", { name: fill(f.pinSkill, { name: "pdf-tools" }) }),
    );
    expect(within(pinned).getByText(f.overLimitRefused)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: f.submit }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const e = f.pinnedError;
    for (const line of [
      fill(e.not_selected, { name: "pdf-tools" }),
      fill(e.not_found, { name: "gone" }),
      fill(e.duplicate, { name: "using-superpowers" }),
      fill(e.too_many, { name: "pdf-tools", max: 3 }),
      fill(e.too_large, { name: "brainstorming", bytes: 40000, max: 32768 }),
    ]) {
      expect(await screen.findByText(`✗ ${line}`)).toBeTruthy();
    }
    expect(screen.getByText(`✗ ${en.errors.agent.pinned_invalid}`)).toBeTruthy();
  });
});
