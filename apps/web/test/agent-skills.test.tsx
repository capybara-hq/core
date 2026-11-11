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
    // an entry for a skill the list does not show (deleted): kept as saved
    disabledSkills: [{ kind: "skill", skillId: "gone" }],
    // a field the form does not know: sent back as saved
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

/** Stub of the direct-to-storage upload: completes with 204 right after send. */
class FakeXhr {
  static instances: FakeXhr[] = [];
  method = "";
  url = "";
  body: unknown;
  status = 0;
  withCredentials = false;
  readonly upload = { onprogress: null as ((e: ProgressEvent) => void) | null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  constructor() {
    FakeXhr.instances.push(this);
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader() {}
  send(body: unknown) {
    this.body = body;
    queueMicrotask(() => {
      this.status = 204;
      this.onload?.();
    });
  }
  abort() {
    this.onabort?.();
  }
}

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

  it("every skill is on by default; unticking one writes disabledSkills, keeping entries not shown and unknown fields", async () => {
    const calls = stubApi({
      ...routes(),
      [`PATCH ${ORG}/agents/ag1`]: () => json(200, { agent: agent(), warnings: [] }),
    });
    const { container } = await renderEditAgent({ section: "skills" });
    expect(container.querySelector('[data-template="SettingsPage"]')).not.toBeNull();
    const group = await screen.findByRole("region", { name: en.agents.form.orgSkillsLabel });
    const live = await within(group).findByRole("checkbox", { name: /pdf-tools/ });
    expect(live).toHaveProperty("checked", true);
    // the hidden entry draws nothing
    expect(within(group).queryByText(/gone/)).toBeNull();
    // the summary: the org skill and the agent's own skill are on
    expect(within(group).getByText("2 skills on")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "Helper" })).toBeTruthy();
    const user = userEvent.setup();
    await user.click(live);
    expect(within(group).getByText("1 skill on · 1 off")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: en.agents.form.submit }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const body = bodyOf(calls.find((c) => c.method === "PATCH")) as {
      definition: Record<string, unknown>;
      visibility?: string;
    };
    expect(body.definition.disabledSkills).toEqual([
      { kind: "skill", skillId: "gone" },
      { kind: "skill", skillId: "s1" },
    ]);
    expect(body.definition.skills).toBeUndefined();
    expect(body.definition.futureField).toEqual({ keep: true });
    expect(body.definition.tools).toEqual([
      { kind: "builtin", name: "AskUserQuestion" },
      { kind: "plugin", plugin: "todo", name: "write" },
    ]);
    expect(body.definition.instructions).toBe("Be helpful.");
    // visibility unchanged: not sent
    expect(body.visibility).toBeUndefined();
    // the section's save stays on the page
    expect(router.push).not.toHaveBeenCalled();
  });

  it("the section says skills are on by default, with no pinning left", async () => {
    stubApi(routes());
    await renderEditAgent({ section: "skills" });
    await screen.findByRole("region", { name: en.agents.form.orgSkillsLabel });
    expect(screen.getByText(en.agents.form.skillsSectionHint)).toBeTruthy();
    expect(zh.agents.form.skillsSectionHint).toBe(
      "组织启用的技能默认对所有智能体开启。需要每次都遵循的内容请写进说明。",
    );
    expect(screen.queryByText(/Pin|pinned/)).toBeNull();
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
      const list = await screen.findByRole("region", { name: m.agents.form.ownSkillsLabel });
      expect(await within(list).findByText("notes-style")).toBeTruthy();
      expect(within(list).getByText("v2")).toBeTruthy();
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

  it("a skills save keeps the tool order and sends expectedVersion", async () => {
    const tools = [
      { kind: "plugin", plugin: "todo", name: "write" },
      { kind: "builtin", name: "ReadToolOutput" },
      { kind: "builtin", name: "AskUserQuestion" },
    ];
    const def = agent().definition;
    const calls = stubApi({
      ...routes({ definition: { ...def, tools, disabledSkills: [] } }),
      [`PATCH ${ORG}/agents/ag1`]: () => json(200, { agent: agent(), warnings: [] }),
    });
    await renderEditAgent({ section: "skills" });
    const group = await screen.findByRole("region", { name: en.agents.form.orgSkillsLabel });
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
    expect(body.definition.disabledSkills).toEqual([{ kind: "skill", skillId: "s1" }]);
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
      const group = await screen.findByRole("region", { name: m.agents.form.orgSkillsLabel });
      const user = userEvent.setup();
      await user.click(await within(group).findByRole("checkbox", { name: /pdf-tools/ }));
      await user.click(screen.getByRole("button", { name: m.agents.form.submit }));
      expect(await screen.findByText(new RegExp(m.errors.agent.version_conflict))).toBeTruthy();
      expect(router.push).not.toHaveBeenCalled();
    },
  );

  it("「运行记录」入口：负责人与组织管理员可见，指向按该 agent 筛选的运行记录", async () => {
    // an org owner (admin) who also owns it: 运行记录 sits in the head's ⋯ menu with Change owner
    stubApi(routes());
    await renderEditAgent({ section: "skills" });
    await userEvent
      .setup()
      .click(await screen.findByRole("button", { name: en.common.moreActions }));
    const link = await screen.findByRole("menuitem", { name: en.agents.runHistory });
    expect(link.getAttribute("href")).toBe("/trajectories?agentId=ag1");
    cleanup();
    // a member who owns it: 运行记录 alone, a button (no menu of one)
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
    await screen.findByRole("region", { name: en.agents.form.orgSkillsLabel });
    expect(
      screen.queryByRole("checkbox", { name: en.agents.form.confirmSkillRegister }),
    ).toBeNull();
    cleanup();

    const def = agent().definition;
    const calls = stubApi({
      ...routes({
        visibility: "private",
        definition: { ...def, skills: { writePolicy: "ask" } },
      }),
      [`PATCH ${ORG}/agents/ag1`]: () => json(200, { agent: agent(), warnings: [] }),
    });
    await renderEditAgent({ section: "skills" });
    const sw = await screen.findByRole("checkbox", { name: en.agents.form.confirmSkillRegister });
    expect(sw).toHaveProperty("checked", true);
    const user = userEvent.setup();
    await user.click(sw);
    await user.click(screen.getByRole("button", { name: en.agents.form.submit }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const body = bodyOf(calls.find((c) => c.method === "PATCH")) as {
      definition: Record<string, unknown>;
    };
    // off = the key removed; nothing else in skills: no skills at all
    expect(body.definition.skills).toBeUndefined();
    expect(body.definition.disabledSkills).toEqual([{ kind: "skill", skillId: "gone" }]);
  });

  it("not the owner: the own skills are listed read-only, with no upload, share or delete", async () => {
    stubApi(routes({ ownerAccountId: "someone-else" }));
    await renderEditAgent({ section: "skills" });
    const list = await screen.findByRole("region", { name: en.agents.form.ownSkillsLabel });
    await within(list).findByText("notes-style");
    expect(within(list).queryByRole("button")).toBeNull();
  });

  it("the owner uploads a skill package: uploads route, direct upload, register route, lists read again", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    FakeXhr.instances = [];
    let own = [ownSkill];
    const calls = stubApi({
      ...routes(),
      [`GET ${ORG}/agents/ag1/skills`]: () => json(200, { skills: own }),
      [`POST ${ORG}/agents/ag1/skills/uploads`]: () =>
        json(201, {
          id: "up1",
          upload: { method: "POST", url: "http://s3.test/b", headers: {}, fields: { key: "k" } },
          expiresAt: T,
        }),
      [`POST ${ORG}/agents/ag1/skills`]: () => {
        own = [...own, { ...ownSkill, id: "k2", name: "fresh-skill", currentVersion: 1 }];
        return json(200, {
          skill: { kind: "version", skillId: "k2", name: "fresh-skill", version: 1, created: true },
        });
      },
    });
    await renderEditAgent({ section: "skills" });
    const list = await screen.findByRole("region", { name: en.agents.form.ownSkillsLabel });
    const user = userEvent.setup();
    await user.click(within(list).getByRole("button", { name: en.agents.form.uploadSkill }));
    const dialog = await screen.findByRole("dialog");
    const input = dialog.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, new File([new Uint8Array(4)], "fresh-skill.zip"));
    expect(
      await screen.findByText(
        en.agents.form.uploadSkillDialog.created.replace("{name}", "fresh-skill"),
      ),
    ).toBeTruthy();
    expect(bodyOf(calls.find((c) => c.url === `${ORG}/agents/ag1/skills/uploads`))).toEqual({
      name: "fresh-skill.zip",
      size: 4,
    });
    expect(FakeXhr.instances[0]?.url).toBe("http://s3.test/b");
    expect(
      bodyOf(calls.find((c) => c.method === "POST" && c.url === `${ORG}/agents/ag1/skills`)),
    ).toEqual({
      uploadId: "up1",
    });
    expect(await within(list).findByText("fresh-skill")).toBeTruthy();
  });

  /** Opens the upload dialog as the owner and returns its parts. */
  async function openUpload(applyAccept = true) {
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    FakeXhr.instances = [];
    await renderEditAgent({ section: "skills" });
    const list = await screen.findByRole("region", { name: en.agents.form.ownSkillsLabel });
    const user = userEvent.setup({ applyAccept });
    await user.click(within(list).getByRole("button", { name: en.agents.form.uploadSkill }));
    const dialog = await screen.findByRole("dialog");
    const input = dialog.querySelector('input[type="file"]') as HTMLInputElement;
    return { user, dialog, input };
  }
  const UPLOADS = `POST ${ORG}/agents/ag1/skills/uploads`;
  const upload = {
    id: "up1",
    upload: { method: "POST", url: "http://s3.test/b", headers: {}, fields: { key: "k" } },
    expiresAt: T,
  };

  it("an upload that is proposed (a shared skill version for an admin to decide) toasts that", async () => {
    stubApi({
      ...routes(),
      [UPLOADS]: () => json(201, upload),
      [`POST ${ORG}/agents/ag1/skills`]: () =>
        json(200, { skill: { kind: "proposed", name: "shared-notes" } }),
    });
    const { user, input } = await openUpload();
    await user.upload(input, new File([new Uint8Array(4)], "shared-notes.zip"));
    expect(
      await screen.findByText(
        en.agents.form.uploadSkillDialog.proposed.replace("{name}", "shared-notes"),
      ),
    ).toBeTruthy();
  });

  it("a rejected package shows the kernel's error and keeps the dialog open", async () => {
    stubApi({
      ...routes(),
      [UPLOADS]: () => json(201, upload),
      [`POST ${ORG}/agents/ag1/skills`]: () =>
        json(409, { error: { code: "skill.agent_cap", message: "cap" } }),
    });
    const { user, dialog, input } = await openUpload();
    await user.upload(input, new File([new Uint8Array(4)], "x.zip"));
    expect(await within(dialog).findByText(en.errors.skill.agent_cap)).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeTruthy();
  });

  it("a file that is not a zip is refused in the browser, before any request", async () => {
    const calls = stubApi({ ...routes(), [UPLOADS]: () => json(201, upload) });
    const { user, dialog, input } = await openUpload(false);
    await user.upload(input, new File([new Uint8Array(4)], "notes.txt"));
    expect(await within(dialog).findByText(en.agents.form.uploadSkillDialog.notZip)).toBeTruthy();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  /** Opens the share dialog of notes-style (owner view) and returns the list region. */
  async function openShare() {
    await renderEditAgent({ section: "skills" });
    const list = await screen.findByRole("region", { name: en.agents.form.ownSkillsLabel });
    const user = userEvent.setup();
    await user.click(
      await within(list).findByRole("button", {
        name: en.agents.form.shareOwnSkillLabel.replace("{name}", "notes-style"),
      }),
    );
    return { list, user, dialog: await screen.findByRole("dialog") };
  }
  const SHARE = `POST ${ORG}/agents/ag1/skills/k1/share`;

  it("a share request: the list marks the skill waiting for an org admin (sharePending from the kernel)", async () => {
    let pending = false;
    const calls = stubApi({
      ...routes(),
      [`GET ${ORG}/agents/ag1/skills`]: () =>
        json(200, { skills: [{ ...ownSkill, sharePending: pending }] }),
      [SHARE]: () => {
        pending = true;
        return json(200, { share: { kind: "requested", requestId: "r1" } });
      },
    });
    const { list, user, dialog } = await openShare();
    // nothing is sent before the confirm
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: en.agents.form.shareConfirm }));
    expect(await within(list).findByText(en.agents.form.shareWaiting)).toBeTruthy();
    expect(within(list).queryByRole("button", { name: /Share skill/ })).toBeNull();
  });

  it("a skill that is already pending shows waiting from the first read", async () => {
    stubApi({
      ...routes(),
      [`GET ${ORG}/agents/ag1/skills`]: () =>
        json(200, { skills: [{ ...ownSkill, sharePending: true }] }),
    });
    await renderEditAgent({ section: "skills" });
    const list = await screen.findByRole("region", { name: en.agents.form.ownSkillsLabel });
    expect(await within(list).findByText(en.agents.form.shareWaiting)).toBeTruthy();
  });

  it("a skill the agent shared stays in its own skills, marked shared and always on, with no share or delete", async () => {
    const f = en.agents.form;
    const shared = { ...orgSkill("k2", "team-notes"), shared: true };
    stubApi({
      ...routes(),
      [`GET ${ORG}/skills`]: () => json(200, { skills: [orgSkill("s1", "pdf-tools"), shared] }),
      [`GET ${ORG}/agents/ag1/skills`]: () =>
        json(200, { skills: [{ ...ownSkill, shared: false }, shared] }),
    });
    await renderEditAgent({ section: "skills" });
    const own = await screen.findByRole("region", { name: f.ownSkillsLabel });
    await within(own).findByText("team-notes");
    expect(within(own).getByText(f.sharedWithOrg)).toBeTruthy();
    // the owner still shares and deletes the own skill, never the shared one
    expect(within(own).getAllByRole("button", { name: /notes-style/ })).toHaveLength(2);
    expect(within(own).queryByRole("button", { name: /team-notes/ })).toBeNull();
    // not offered in the org list: it is always on for the agent that shared it
    const orgPicker = screen.getByRole("region", { name: f.orgSkillsLabel });
    expect(within(orgPicker).queryByRole("checkbox", { name: /team-notes/ })).toBeNull();
    expect(zh.agents.form.sharedWithOrg).toBe("已共享到组织");
  });

  it("an org admin owner: the share answer `shared` toasts at once", async () => {
    stubApi({
      ...routes(),
      [SHARE]: () => json(200, { share: { kind: "shared", skillId: "k1" } }),
    });
    const { user, dialog } = await openShare();
    await user.click(within(dialog).getByRole("button", { name: en.agents.form.shareConfirm }));
    expect(
      await screen.findByText(en.agents.form.ownSkillShared.replace("{name}", "notes-style")),
    ).toBeTruthy();
  });

  it("a 409 skill.share_pending toasts the kernel's message and reads the list again", async () => {
    let reads = 0;
    stubApi({
      ...routes(),
      [`GET ${ORG}/agents/ag1/skills`]: () => {
        reads += 1;
        return json(200, { skills: [{ ...ownSkill, sharePending: reads > 1 }] });
      },
      [SHARE]: () =>
        json(409, { error: { code: "skill.share_pending", message: "Share is pending" } }),
    });
    const { list, user, dialog } = await openShare();
    await user.click(within(dialog).getByRole("button", { name: en.agents.form.shareConfirm }));
    expect(await screen.findByText(en.errors.skill.share_pending)).toBeTruthy();
    expect(await within(list).findByText(en.agents.form.shareWaiting)).toBeTruthy();
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

describe("platform skills in the editor (plugin scope phase 2)", () => {
  beforeEach(() => resetNavigation("/agents/ag1"));
  // a platform skill on in the org, of the plugin docs
  const platform = {
    ...orgSkill("p1", "pdf-tools"),
    origin: "platform",
    linkedIds: ["copy1"],
    plugin: "docs",
  };
  const routes = (disabledSkills: unknown[] = []) => ({
    [`GET ${ORG}/agents/ag1`]: () =>
      json(200, { agent: agent({ definition: { ...agent().definition, disabledSkills } }) }),
    [`GET ${ORG}/models`]: () => json(200, MODELS),
    [`GET ${ORG}/connectors`]: () => json(200, { connectors: [] }),
    [`GET ${ORG}/skills`]: () =>
      json(200, { skills: [platform, { ...orgSkill("s2", "notes"), origin: "org" }] }),
    [`GET ${ORG}/agents/ag1/skills`]: () => json(200, { skills: [] }),
  });

  it("a plugin entry naming the skill turns it off; ticking it again drops the entry", async () => {
    const calls = stubApi({
      ...routes([{ kind: "plugin", plugin: "docs", skills: ["pdf-tools"] }]),
      [`PATCH ${ORG}/agents/ag1`]: () => json(200, { agent: agent(), warnings: [] }),
    });
    await renderEditAgent({ section: "skills" });
    const group = await screen.findByRole("region", { name: en.agents.form.orgSkillsLabel });
    const box = await within(group).findByRole("checkbox", { name: /pdf-tools/ });
    expect(box).toHaveProperty("checked", false);
    expect(within(group).getByText(en.agents.form.skillTag.platform)).toBeTruthy();
    await userEvent.setup().click(box);
    await userEvent.setup().click(screen.getByRole("button", { name: en.agents.form.submit }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const body = bodyOf(calls.find((c) => c.method === "PATCH")) as {
      definition: { disabledSkills: unknown[] };
    };
    expect(body.definition.disabledSkills).toEqual([]);
  });

  it("a builtin plugin's skill shows ticked and disabled with the built-in badge and hint", async () => {
    stubApi({
      ...routes(),
      [`GET ${ORG}/skills`]: () =>
        json(200, {
          skills: [
            { ...orgSkill("g1", "skill-guide"), origin: "platform", builtin: true, plugin: "core" },
            // the org's pinned copy of a builtin skill is always on too
            { ...orgSkill("c1", "core-notes"), origin: "org", builtin: true },
          ],
        }),
    });
    await renderEditAgent({ section: "skills" });
    const group = await screen.findByRole("region", { name: en.agents.form.orgSkillsLabel });
    const box = await within(group).findByRole("checkbox", { name: /skill-guide/ });
    expect(box).toHaveProperty("checked", true);
    expect(box).toHaveProperty("disabled", true);
    // the badge on each row (the group's heading reads 「内置」 too)
    expect(
      within(group).getAllByText(en.agents.form.skillTag.builtin, {
        selector: '[data-part="check-list-marks"] > *',
      }),
    ).toHaveLength(2);
    expect(within(group).getByText(en.agents.form.builtinHint)).toBeTruthy();
    const copy = within(group).getByRole("checkbox", { name: /core-notes/ });
    expect(copy).toHaveProperty("checked", true);
    expect(copy).toHaveProperty("disabled", true);
  });
});

describe("skills on / off, grouped by where they come from (acceptance: 15 Superpowers skills)", () => {
  beforeEach(() => resetNavigation("/agents/ag1"));
  const F = en.agents.form;
  const SP = ["brainstorming", "systematic-debugging", "writing-plans", "using-superpowers"].concat(
    Array.from({ length: 6 }, (_, i) => `sp-extra-${i}`),
  );
  const LONG =
    "Use when starting any conversation - establishes how to find and use skills, requiring Skill tool invocation before ANY response including clarifying questions";
  const skills = [
    ...SP.map((name, i) => ({
      ...orgSkill(`sp${i}`, name),
      description: name === "using-superpowers" ? LONG : `Use for ${name}.`,
      origin: "platform",
      plugin: "superpowers",
    })),
    { ...orgSkill("o1", "csv-report"), origin: "org", plugin: null },
    { ...orgSkill("o2", "tone"), origin: "org", plugin: null },
    { ...orgSkill("g1", "skill-guide"), origin: "platform", builtin: true, plugin: "skills-core" },
  ];
  const routes = (disabledSkills: unknown[] = []) => ({
    [`GET ${ORG}/agents/ag1`]: () =>
      json(200, { agent: agent({ definition: { ...agent().definition, disabledSkills } }) }),
    [`GET ${ORG}/models`]: () => json(200, MODELS),
    [`GET ${ORG}/connectors`]: () => json(200, { connectors: [] }),
    [`GET ${ORG}/skills`]: () => json(200, { skills }),
    [`GET ${ORG}/agents/ag1/skills`]: () => json(200, { skills: [] }),
  });
  const selectAllOf = (group: string) => `Select all in ${group}`;
  const countOf = (list: HTMLElement) =>
    list.parentElement?.querySelector('[data-part="check-list-count"]')?.textContent;
  const sentOff = (calls: Parameters<typeof bodyOf>[0][]) =>
    (
      bodyOf(calls.find((c) => c?.method === "PATCH")) as {
        definition: { disabledSkills: unknown };
      }
    ).definition.disabledSkills;
  const withSave = (disabledSkills: unknown[] = []) =>
    stubApi({
      ...routes(disabledSkills),
      [`PATCH ${ORG}/agents/ag1`]: () => json(200, { agent: agent(), warnings: [] }),
    });
  const save = async (calls: Parameters<typeof bodyOf>[0][]) => {
    await userEvent.setup().click(screen.getByRole("button", { name: F.submit }));
    await vi.waitFor(() => expect(calls.some((c) => c?.method === "PATCH")).toBe(true));
    return sentOff(calls);
  };

  it("one list per plugin, then the org's own, then the built-in ones; every row starts checked", async () => {
    stubApi(routes());
    await renderEditAgent({ section: "skills" });
    const region = await screen.findByRole("region", { name: F.orgSkillsLabel });
    const lists = await within(region).findAllByRole("list");
    expect(lists.map((l) => l.getAttribute("aria-label"))).toEqual([
      "superpowers",
      F.skillGroupOrg,
      F.skillGroupBuiltin,
    ]);
    const sp = within(region).getByRole("checkbox", { name: selectAllOf("superpowers") });
    expect(sp.getAttribute("aria-checked")).toBe("true");
    expect(countOf(lists[0] as HTMLElement)).toBe("10/10");
    expect(countOf(lists[1] as HTMLElement)).toBe("2/2");
    // built-in: always on, no group box, counted apart, with its note
    expect(
      within(region).queryByRole("checkbox", { name: selectAllOf(F.skillGroupBuiltin) }),
    ).toBeNull();
    expect(countOf(lists[2] as HTMLElement)).toBe("1");
    const guide = within(region).getByRole("checkbox", { name: "skill-guide" });
    expect(guide).toHaveProperty("checked", true);
    expect(guide).toHaveProperty("disabled", true);
    expect(within(region).getByText(F.builtinHint)).toBeTruthy();
    expect(within(region).getByText("13 skills on")).toBeTruthy();
  });

  it("a plugin entry naming skills draws the group mixed with its off count", async () => {
    stubApi(routes([{ kind: "plugin", plugin: "superpowers", skills: ["brainstorming"] }]));
    await renderEditAgent({ section: "skills" });
    const region = await screen.findByRole("region", { name: F.orgSkillsLabel });
    const sp = await within(region).findByRole("checkbox", { name: selectAllOf("superpowers") });
    expect(sp.getAttribute("aria-checked")).toBe("mixed");
    expect(countOf(within(region).getAllByRole("list")[0] as HTMLElement)).toBe("9/10");
    expect(within(region).getByRole("checkbox", { name: "brainstorming" })).toHaveProperty(
      "checked",
      false,
    );
    expect(within(region).getByText("1 off")).toBeTruthy();
    expect(within(region).getByText("12 skills on · 1 off")).toBeTruthy();
  });

  it("a row: the name and its badges on the first line, the description a cut second line with the full text on hover", async () => {
    stubApi(routes());
    await renderEditAgent({ section: "skills" });
    const region = await screen.findByRole("region", { name: F.orgSkillsLabel });
    const box = await within(region).findByRole("checkbox", { name: "using-superpowers" });
    const row = box.closest('[data-part="check-list-row"]') as HTMLElement;
    const line = row.querySelector('[data-part="check-list-line"]') as HTMLElement;
    expect(line.contains(box)).toBe(true);
    expect(within(line).getByText(F.skillTag.platform)).toBeTruthy();
    const desc = row.querySelector('[data-part="check-list-description"]') as HTMLElement;
    expect(line.contains(desc)).toBe(false);
    expect(desc.textContent).toBe(LONG);
    expect(desc.getAttribute("title")).toBe(LONG);
    // the badge is not part of the name, nor glued to the description
    expect(box.closest("label")?.textContent).toBe("using-superpowers");
  });

  it("unticking the group head turns the whole plugin off (later skills too), keeping other entries", async () => {
    // an entry for a plugin the org turned off: not shown, kept
    const hidden = { kind: "plugin", plugin: "retired", skills: "all" };
    const calls = withSave([hidden]);
    await renderEditAgent({ section: "skills" });
    const region = await screen.findByRole("region", { name: F.orgSkillsLabel });
    const sp = await within(region).findByRole("checkbox", { name: selectAllOf("superpowers") });
    const user = userEvent.setup();
    await user.click(sp);
    expect(sp.getAttribute("aria-checked")).toBe("false");
    expect(within(region).getByText(F.skillsOffAll)).toBeTruthy();
    expect(zh.agents.form.skillsOffAll).toBe("已关闭全部（含以后新增的）");
    expect(await save(calls)).toEqual([
      hidden,
      { kind: "plugin", plugin: "superpowers", skills: "all" },
    ]);
  });

  it("ticking the head of a plugin turned off as a whole clears its entry", async () => {
    const calls = withSave([{ kind: "plugin", plugin: "superpowers", skills: "all" }]);
    await renderEditAgent({ section: "skills" });
    const region = await screen.findByRole("region", { name: F.orgSkillsLabel });
    expect(await within(region).findByText(F.skillsOffAll)).toBeTruthy();
    await userEvent
      .setup()
      .click(within(region).getByRole("checkbox", { name: selectAllOf("superpowers") }));
    expect(await save(calls)).toEqual([]);
  });

  it("unticking every row one by one collapses to the whole plugin; ticking one back names the rest", async () => {
    const calls = withSave();
    await renderEditAgent({ section: "skills" });
    const region = await screen.findByRole("region", { name: F.orgSkillsLabel });
    await within(region).findByRole("checkbox", { name: "brainstorming" });
    const user = userEvent.setup();
    for (const name of SP) await user.click(within(region).getByRole("checkbox", { name }));
    expect(within(region).getByText(F.skillsOffAll)).toBeTruthy();
    await user.click(within(region).getByRole("checkbox", { name: "brainstorming" }));
    expect(within(region).getByText("9 off")).toBeTruthy();
    expect(await save(calls)).toEqual([
      { kind: "plugin", plugin: "superpowers", skills: SP.slice(1).sort() },
    ]);
  });

  it("the filter narrows by name and description; the head then acts on the shown rows by name", async () => {
    const calls = withSave();
    await renderEditAgent({ section: "skills" });
    const region = await screen.findByRole("region", { name: F.orgSkillsLabel });
    const search = await within(region).findByRole("searchbox", { name: F.searchSkills });
    const user = userEvent.setup();
    // "clarifying" is only in using-superpowers' description
    await user.type(search, "clarifying");
    expect(within(region).getAllByRole("list")).toHaveLength(1);
    expect(within(region).getByRole("checkbox", { name: "using-superpowers" })).toBeTruthy();
    expect(within(region).queryByRole("checkbox", { name: "brainstorming" })).toBeNull();
    await user.clear(search);
    await user.type(search, "writing");
    expect(countOf(within(region).getAllByRole("list")[0] as HTMLElement)).toBe("1/1");
    await user.click(within(region).getByRole("checkbox", { name: selectAllOf("superpowers") }));
    await user.clear(search);
    // only the shown row went off: the group is mixed, never the whole plugin
    expect(
      within(region)
        .getByRole("checkbox", { name: selectAllOf("superpowers") })
        .getAttribute("aria-checked"),
    ).toBe("mixed");
    await user.type(search, "nothing-matches-this");
    expect(within(region).getByText(F.noSkillMatch)).toBeTruthy();
    expect(await save(calls)).toEqual([
      { kind: "plugin", plugin: "superpowers", skills: ["writing-plans"] },
    ]);
  });

  it("the 本组织 head turns its skills off one by one, by id (no whole-group entry)", async () => {
    const calls = withSave();
    await renderEditAgent({ section: "skills" });
    const region = await screen.findByRole("region", { name: F.orgSkillsLabel });
    await userEvent
      .setup()
      .click(await within(region).findByRole("checkbox", { name: selectAllOf(F.skillGroupOrg) }));
    expect(within(region).getByText("2 off")).toBeTruthy();
    expect(await save(calls)).toEqual([
      { kind: "skill", skillId: "o1" },
      { kind: "skill", skillId: "o2" },
    ]);
  });

  it("someone who may not change the agent never reaches the skill switches", async () => {
    stubApi(routes());
    await renderEditAgent({
      section: "skills",
      me: {
        ...ME,
        account: { ...ME.account, id: "someone-else", isSuperAdmin: false },
        memberships: [{ orgId: "o1", slug: "acme", name: "Acme", role: "member" }],
      },
    });
    await screen.findByRole("heading", { level: 1, name: "Helper" });
    expect(screen.queryByRole("region", { name: F.orgSkillsLabel })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /Select all in/ })).toBeNull();
  });
});
