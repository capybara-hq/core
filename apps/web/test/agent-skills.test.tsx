import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import EditAgentPage from "../src/app/[locale]/(app)/agents/[id]/page";
import NewAgentPage from "../src/app/[locale]/(app)/agents/new/page";
import { bodyOf, json, noContent, stubApi } from "./support/api";
import { resetNavigation, router } from "./support/navigation";
import { renderPage } from "./support/render";

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
        [`GET ${ORG}/apps`]: () => json(200, { apps: [] }),
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

  it("不选技能：定义里不带 skills", async () => {
    const calls = stubApi({
      [`GET ${ORG}/models`]: () => json(200, MODELS),
      [`GET ${ORG}/apps`]: () => json(200, { apps: [] }),
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
    [`GET ${ORG}/apps`]: () => json(200, { apps: [] }),
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
    expect(await screen.findByText(`✗ ${zh.errors.agent.not_found}`)).toBeTruthy();
  });
});
