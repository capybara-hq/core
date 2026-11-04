import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { renderEditAgent } from "./support/agents";
import { bodyOf, json, noContent, stubApi } from "./support/api";
import { resetNavigation, router } from "./support/navigation";
import { ME } from "./support/render";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

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
  profile: {
    avatar: null,
    description: "",
    quickActions: [],
    updatedAt: "2026-11-04T10:00:00.000Z",
  },
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
      { kind: "builtin", name: "AskUserQuestion" },
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
    const { container } = await renderEditAgent({ section: "skills" });
    expect(container.querySelector('[data-template="SettingsPage"]')).not.toBeNull();
    const group = await screen.findByRole("group", { name: en.agents.form.orgSkillsLabel });
    const live = await within(group).findByRole("checkbox", { name: /pdf-tools/ });
    expect(live).toHaveProperty("checked", true);
    const deleted = within(group).getByRole("checkbox", {
      name: en.agents.form.deletedSkill.replace("{id}", "gone"),
    });
    expect(deleted).toHaveProperty("checked", true);
    expect(screen.getByRole("heading", { level: 1, name: "Helper" })).toBeTruthy();
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
      { kind: "builtin", name: "AskUserQuestion" },
      { kind: "plugin", plugin: "todo", name: "write" },
    ]);
    expect(body.definition.instructions).toBe("Be helpful.");
    // 没改可见性：不发
    expect(body.visibility).toBeUndefined();
    // the section's save stays on the page
    expect(router.push).not.toHaveBeenCalled();
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
      await renderEditAgent({ locale, section: "skills" });
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
      // the delete invalidates the agent's own skills: they are read again
      const after = () => calls.slice(calls.findIndex((c) => c.method === "DELETE"));
      await vi.waitFor(() =>
        expect(after().map((c) => `${c.method} ${c.url}`)).toContain(
          `GET ${ORG}/agents/ag1/skills`,
        ),
      );
      expect(await within(list).findByText(m.agents.form.noOwnSkills)).toBeTruthy();
    },
  );

  it("a skills save keeps the tool order, merges skills (unknown keys kept) and sends expectedVersion", async () => {
    const tools = [
      { kind: "plugin", plugin: "todo", name: "write" },
      { kind: "builtin", name: "ReadToolOutput" },
      { kind: "builtin", name: "AskUserQuestion" },
    ];
    const def = agent().definition;
    const calls = stubApi({
      ...routes({ definition: { ...def, tools, skills: { orgSkills: ["s1"], future: 1 } } }),
      [`PATCH ${ORG}/agents/ag1`]: () => json(200, { agent: agent(), warnings: [] }),
    });
    await renderEditAgent({ section: "skills" });
    const group = await screen.findByRole("group", { name: en.agents.form.orgSkillsLabel });
    const user = userEvent.setup();
    // the save row appears with a change: drop the one org skill
    await user.click(await within(group).findByRole("checkbox", { name: /pdf-tools/ }));
    await user.click(screen.getByRole("button", { name: en.agents.form.submit }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const body = bodyOf(calls.find((c) => c.method === "PATCH")) as {
      definition: Record<string, unknown>;
      expectedVersion?: number;
    };
    expect(body.definition.tools).toEqual(tools);
    expect(body.definition.skills).toEqual({ orgSkills: [], future: 1 });
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
      await renderEditAgent({ locale, section: "skills" });
      const m = msgs[locale];
      const group = await screen.findByRole("group", { name: m.agents.form.orgSkillsLabel });
      const user = userEvent.setup();
      await user.click(await within(group).findByRole("checkbox", { name: /pdf-tools/ }));
      await user.click(screen.getByRole("button", { name: m.agents.form.submit }));
      expect(await screen.findByText(new RegExp(m.errors.agent.version_conflict))).toBeTruthy();
      expect(router.push).not.toHaveBeenCalled();
    },
  );

  it("「运行记录」入口：负责人与组织管理员可见，指向按该 agent 筛选的运行记录", async () => {
    // 组织 owner（管理员）且是负责人
    stubApi(routes());
    await renderEditAgent({ section: "skills" });
    const link = await screen.findByRole("link", { name: en.agents.runHistory });
    expect(link.getAttribute("href")).toBe("/trajectories?agentId=ag1");
    cleanup();
    // 普通成员、是负责人：可见
    const member = {
      ...ME,
      memberships: [{ orgId: "o1", slug: "acme", name: "Acme", role: "member" }],
    };
    stubApi(routes());
    await renderEditAgent({ me: member });
    expect(await screen.findByRole("link", { name: en.agents.runHistory })).toBeTruthy();
    cleanup();
    // a member who doesn't own it gets the read-only view, without the entry
    stubApi(routes({ ownerAccountId: "someone-else" }));
    await renderEditAgent({ me: member });
    await screen.findByText(en.agents.readOnly);
    expect(screen.queryByRole("link", { name: en.agents.runHistory })).toBeNull();
  });

  it("编辑：共享 agent 没有确认开关；私有 agent 已是 ask 时勾选，取消勾选去掉 writePolicy 键", async () => {
    stubApi(routes());
    await renderEditAgent({ section: "skills" });
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
    await renderEditAgent({ section: "skills" });
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
    await renderEditAgent({ section: "skills" });
    const list = await screen.findByRole("group", { name: en.agents.form.ownSkillsLabel });
    await within(list).findByText("notes-style · v2");
    expect(within(list).queryByRole("button")).toBeNull();
  });

  it("an agent the kernel does not find is the not-found state in the shell", async () => {
    stubApi({
      ...routes(),
      [`GET ${ORG}/agents/ag1`]: () =>
        json(404, { error: { code: "agent.not_found", message: "x" } }),
    });
    await renderEditAgent({ locale: "zh" });
    expect(screen.getByRole("heading", { level: 1, name: zh.notFound.title })).toBeTruthy();
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

  it("when the agent's own skills cannot be read, no pinned skill shows as deleted (batch-3 I1)", async () => {
    const f = en.agents.form;
    // A failed read keeps the pins as they are and marks none deleted.
    stubApi({
      ...editRoutes({ orgSkills: ["s1"], pinned: ["s1", "k1"] }),
      [`GET ${ORG}/agents/ag1/skills`]: () =>
        json(500, { error: { code: "internal", message: "x" } }),
    });
    await renderEditAgent({ section: "skills" });
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
    await renderEditAgent({ section: "skills" });
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
    // a skill that is not suggested for pinning: the save has a change but still no pins
    await user.click(within(org).getByRole("checkbox", { name: /brainstorming/ }));
    await user.click(screen.getByRole("button", { name: f.submit }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const body = bodyOf(calls.find((c) => c.method === "PATCH")) as {
      definition: Record<string, unknown>;
    };
    expect(body.definition.skills).toEqual({ orgSkills: ["s3", "s2"] });
  });

  it("a fourth pin is disabled with the tooMany hint; the token estimate sums the pinned skills", async () => {
    const f = en.agents.form;
    stubApi(editRoutes({ orgSkills: ["s1", "s2", "s3", "s4"], pinned: ["s1", "s2", "s3"] }));
    await renderEditAgent({ section: "skills" });
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
    await renderEditAgent({ section: "skills" });
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
      expect(await screen.findByText(line)).toBeTruthy();
    }
    const top = screen.getByText(en.errors.agent.pinned_invalid);
    // the fail tone carries the circle-x icon, not a character
    expect(top.querySelector('[data-icon="circle-x"]')).not.toBeNull();
  });

  it.each(["zh", "en"] as const)(
    "phase D: manual and sub-agent skills are tagged; a manual one is not pinnable; one that became manual warns (%s)",
    async (locale) => {
      const f = msgs[locale].agents.form;
      const skills = [
        { ...pinSkill("s1", "using-superpowers"), manual: false, fork: false },
        { ...pinSkill("s2", "release-check"), manual: true, fork: false },
        { ...pinSkill("s3", "review"), manual: false, fork: true },
        { ...pinSkill("s4", "old-pin"), manual: true, fork: false },
      ];
      stubApi({
        ...editRoutes({ orgSkills: ["s1", "s2", "s3", "s4"], pinned: ["s4"] }),
        [`GET ${ORG}/skills`]: () => json(200, { skills }),
      });
      await renderEditAgent({ locale, section: "skills" });
      const org = await screen.findByRole("group", { name: f.orgSkillsLabel });
      await within(org).findByRole("checkbox", { name: /release-check/ });
      // release-check and old-pin are manual, review runs as a sub-agent
      expect(within(org).getAllByText(f.skillTag.manual)).toHaveLength(2);
      expect(within(org).getAllByText(f.skillTag.fork)).toHaveLength(1);
      expect(within(org).getByText(f.manualHint)).toBeTruthy();
      const pinned = screen.getByRole("group", { name: f.pinnedLabel });
      const manual = within(pinned).getByRole("checkbox", {
        name: fill(f.pinSkill, { name: "release-check" }),
      });
      expect(manual).toHaveProperty("disabled", true);
      expect(within(pinned).getByText(f.manualNotPinnable)).toBeTruthy();
      // a pinned skill whose new version is manual-only: kept ticked (to be unticked), with a warning
      const old = within(pinned).getByRole("checkbox", {
        name: fill(f.pinSkill, { name: "old-pin" }),
      });
      expect(old).toHaveProperty("checked", true);
      expect(old).toHaveProperty("disabled", false);
      expect(within(pinned).getByText(fill(f.pinnedManualOnly, { name: "old-pin" }))).toBeTruthy();
    },
  );

  it("phase D: the kernel's manual_only refusal names the skill", async () => {
    const f = en.agents.form;
    stubApi({
      ...editRoutes({ orgSkills: ["s3"], pinned: [] }),
      [`PATCH ${ORG}/agents/ag1`]: () =>
        json(400, {
          error: {
            code: "agent.pinned_invalid",
            message: "x",
            details: [{ skill: "s3", reason: "manual_only" }],
          },
        }),
    });
    await renderEditAgent({ section: "skills" });
    const pinned = await screen.findByRole("group", { name: f.pinnedLabel });
    const user = userEvent.setup();
    await user.click(
      within(pinned).getByRole("checkbox", { name: fill(f.pinSkill, { name: "pdf-tools" }) }),
    );
    await user.click(screen.getByRole("button", { name: f.submit }));
    expect(
      await screen.findByText(fill(f.pinnedError.manual_only, { name: "pdf-tools" })),
    ).toBeTruthy();
  });
});
