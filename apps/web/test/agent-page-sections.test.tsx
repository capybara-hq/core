import { describeNestedBox, findNestedBoxes } from "@capybara-hq/design/reference";
import { act, cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { keys } from "../src/lib/query/keys";
import { agentFormDefaults, renderEditAgent } from "./support/agents";
import { bodyOf, type Call, json, stubApi } from "./support/api";
import { resetNavigation, router } from "./support/navigation";
import { renderRouteEmptyCache } from "./support/query";
import { ME } from "./support/render";
import { pickOption } from "./support/select";
import { expectNoFirstPaintFetch, sessionRoutes } from "./support/server";
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

const ORG = "/api/v1/orgs/o1";
const T = "2026-10-20T08:00:00.000Z";
const F = en.agents.form;
const PR = en.agents.page.prompt;

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

const FILES = [
  { name: "AGENTS.md", content: "Be helpful." },
  { name: "STYLE.md", content: "Be brief." },
];
const JOINED = "# AGENTS.md\n\nBe helpful.\n\n# STYLE.md\n\nBe brief.";

type Over = {
  owner?: string;
  visibility?: string;
  version?: number;
  files?: { name: string; content: string }[] | null;
  instructions?: string;
  definition?: Record<string, unknown>;
};
/** An agent saved with prompt files (`files: null`: an old agent without them). */
const agent = (over: Over = {}) => {
  const files = over.files === undefined ? FILES : over.files;
  return {
    id: "ag1",
    orgId: "o1",
    ownerAccountId: over.owner ?? "a1",
    visibility: over.visibility ?? "org",
    currentVersion: over.version ?? 1,
    memberIds: null,
    needsReassignment: false,
    createdAt: T,
    updatedAt: T,
    profile: {
      avatar: null,
      description: "",
      quickActions: [],
      updatedAt: "2026-11-04T10:00:00.000Z",
    },
    definition: {
      name: "Helper",
      instructions: over.instructions ?? (files === null ? "Be helpful." : JOINED),
      ...(files === null ? {} : { instructionFiles: files }),
      model: { provider: "model-fake", model: "fake-1" },
      fallback: null,
      modelParams: {},
      fallbackParams: {},
      // tools default-on: the agent turns off one builtin and one extension tool
      disabledTools: [
        { kind: "builtin", name: "AskUserQuestion" },
        { kind: "plugin", plugin: "todo", tools: ["write"] },
      ],
      toolPolicies: {},
      // a field the web does not know: every section's save sends it back as it is
      futureField: { keep: true },
      ...over.definition,
    },
  };
};
type AgentJson = ReturnType<typeof agent>;
/** The saved definition as every section's save starts from it: without the prompt files. */
const sent = (a: AgentJson) => {
  const { instructionFiles: _files, ...rest } = a.definition as Record<string, unknown>;
  return rest;
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

const ok = (body: unknown) => () => json(200, body);
type Handler = (c: Call) => Response | Promise<Response>;
function routes(a: AgentJson = agent(), over: Record<string, Handler> = {}) {
  return {
    ...sessionRoutes(),
    ...agentFormDefaults(),
    [`GET ${ORG}/agents/ag1`]: ok({ agent: a }),
    [`GET ${ORG}/models`]: ok(MODELS),
    [`GET ${ORG}/skills`]: ok({ skills: [orgSkill("s1", "pdf-tools")] }),
    [`PATCH ${ORG}/agents/ag1`]: ok({ agent: a, warnings: [] }),
    ...over,
  };
}
const patches = (calls: Call[]) =>
  calls.filter((c) => c.method === "PATCH" && c.url === `${ORG}/agents/ag1`).map(bodyOf);
const save = () => screen.getByRole("button", { name: F.submit });
const fileList = () => screen.getByRole("group", { name: PR.filesLabel });
const nameBox = () => screen.getByRole("textbox", { name: PR.nameLabel }) as HTMLInputElement;
const contentBox = () =>
  screen.getByRole("textbox", { name: PR.contentLabel }) as HTMLTextAreaElement;
const settle = () => act(() => new Promise((r) => setTimeout(r, 20)));
const as = (role: "guest" | "member" | "admin") => ({
  ...ME,
  account: { ...ME.account, isSuperAdmin: false },
  memberships: [{ orgId: "o1", slug: "acme", name: "Acme", role }],
});

beforeEach(() => resetNavigation("/agents/ag1"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the agent page's sections with their own saves (agent profile design §3.2–3.3)", () => {
  it("prompt: an old agent without instructionFiles shows one AGENTS.md holding its instructions", async () => {
    stubApi(routes(agent({ files: null })));
    await renderEditAgent({ section: "prompt" });
    expect(
      within(fileList())
        .getAllByRole("group")
        .map((g) => g.getAttribute("aria-label")),
    ).toEqual(["AGENTS.md"]);
    expect(nameBox().value).toBe("AGENTS.md");
    expect(contentBox().value).toBe("Be helpful.");
    // nothing changed: no action row
    expect(document.querySelector('[data-part="action-row"]')).toBeNull();
  });

  it("prompt: list + editor without an editor card (one box is enough, acceptance item AB)", async () => {
    stubApi(routes(agent({ files: null })));
    await renderEditAgent({ section: "prompt" });
    const section = screen.getByRole("region", { name: en.agents.page.sections.prompt });
    // the columns split by a hairline; the open file's name is an h3 over its fields
    expect(
      section.querySelector('[data-columns="list-detail"]')?.getAttribute("data-divided"),
    ).toBe("true");
    expect(within(section).getByRole("heading", { level: 3, name: "AGENTS.md" })).toBeTruthy();
    expect(section.querySelector('[data-part="card"]')).toBeNull();
    expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
  });

  it("prompt: add WORKFLOW.md, reorder, save sends instructionFiles in order", async () => {
    const calls = stubApi(routes(agent({ files: null })));
    await renderEditAgent({ section: "prompt" });
    const user = userEvent.setup();
    await user.click(within(fileList()).getByRole("button", { name: PR.add }));
    // the new file opens in the editor
    expect(nameBox().value).toBe("untitled.md");
    await user.clear(nameBox());
    await user.type(nameBox(), "WORKFLOW.md");
    await user.type(contentBox(), "Plan, then act.");
    await user.click(within(fileList()).getByRole("button", { name: "Move WORKFLOW.md up" }));
    expect(
      within(fileList())
        .getAllByRole("group")
        .map((g) => g.getAttribute("aria-label")),
    ).toEqual(["WORKFLOW.md", "AGENTS.md"]);
    // the other file opens with its own content
    await user.click(within(fileList()).getByRole("button", { name: "AGENTS.md" }));
    expect(contentBox().value).toBe("Be helpful.");
    await user.click(save());
    await vi.waitFor(() => expect(patches(calls)).toHaveLength(1));
    const { instructions: _i, ...rest } = sent(agent({ files: null }));
    expect(patches(calls)[0]).toEqual({
      definition: {
        ...rest,
        instructionFiles: [
          { name: "WORKFLOW.md", content: "Plan, then act." },
          { name: "AGENTS.md", content: "Be helpful." },
        ],
      },
      expectedVersion: 1,
    });
  });

  it("prompt: the last file can't be deleted", async () => {
    stubApi(routes(agent({ files: null })));
    await renderEditAgent({ section: "prompt" });
    const remove = within(fileList()).getByRole("button", {
      name: "Remove AGENTS.md",
    }) as HTMLButtonElement;
    expect(remove.disabled).toBe(true);
    const user = userEvent.setup();
    await user.click(within(fileList()).getByRole("button", { name: PR.add }));
    expect(
      (within(fileList()).getByRole("button", { name: "Remove AGENTS.md" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("prompt: a duplicate name is refused before save", async () => {
    const calls = stubApi(routes());
    await renderEditAgent({ section: "prompt" });
    const user = userEvent.setup();
    await user.click(within(fileList()).getByRole("button", { name: PR.add }));
    await user.clear(nameBox());
    // names are compared ignoring case, as the kernel does
    await user.type(nameBox(), "style.md");
    await user.click(save());
    await settle();
    expect(patches(calls)).toEqual([]);
    expect(nameBox().getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText(PR.nameDuplicate)).toBeTruthy();
    // a name without .md is refused the same way
    await user.clear(nameBox());
    await user.type(nameBox(), "notes.txt");
    await user.click(save());
    await settle();
    expect(screen.getByText(PR.nameInvalid)).toBeTruthy();
    expect(patches(calls)).toEqual([]);
  });

  it("prompt: name errors show on blur or on save, not while typing", async () => {
    stubApi(routes());
    await renderEditAgent({ section: "prompt" });
    const user = userEvent.setup();
    await user.click(within(fileList()).getByRole("button", { name: PR.add }));
    await user.clear(nameBox());
    await user.type(nameBox(), "Style");
    // mid-typing: nothing yet, though "Style" is not a valid name
    expect(screen.queryByText(PR.nameInvalid)).toBeNull();
    await user.type(nameBox(), ".md");
    expect(screen.queryByText(PR.nameDuplicate)).toBeNull();
    // leaving the field shows it: a case variant of STYLE.md
    await user.tab();
    expect(screen.getByText(PR.nameDuplicate)).toBeTruthy();
    expect(nameBox().getAttribute("aria-invalid")).toBe("true");
    // typing again hides it until the field is left
    await user.type(nameBox(), "x");
    expect(screen.queryByText(PR.nameInvalid)).toBeNull();
    await user.type(nameBox(), "{Backspace}");
    // a save shows every file's problem: STYLE.md is a duplicate of Style.md too
    await user.click(save());
    await user.click(within(fileList()).getByRole("button", { name: "STYLE.md" }));
    expect(nameBox().value).toBe("STYLE.md");
    expect(screen.getByText(PR.nameDuplicate)).toBeTruthy();
  });

  it("prompt: a titled section whose loading frame has the loaded shape", async () => {
    stubApi(routes());
    await renderEditAgent({ section: "prompt" });
    const section = screen.getByRole("region", { name: en.agents.page.sections.prompt });
    expect(within(section).getByRole("heading", { level: 2 }).textContent).toBe(
      en.agents.page.sections.prompt,
    );
    expect(within(section).getByText(PR.hint)).toBeTruthy();
    // stacked: the head above a full-width card, so the editor has the content's width
    expect(section.getAttribute("data-layout")).toBe("stacked");
    const grid = section.querySelector('[data-columns="list-detail"]');
    expect(grid?.children).toHaveLength(2);
    // the other sections keep the two columns
    expect(document.querySelectorAll('[data-part="form-section"][data-layout]')).toHaveLength(1);
    cleanup();

    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    await renderRouteEmptyCache("/agents/ag1?s=prompt", {
      ...routes(),
      [`GET ${ORG}/agents/ag1`]: async () => {
        await held;
        return json(200, { agent: agent() });
      },
    });
    const loading = await vi.waitFor(() => {
      const el = document.querySelector('[data-part="loading-list-editor"]');
      if (el === null) throw new Error("no loading frame yet");
      return el;
    });
    // the same title and description, the same grid: a list row beside an editor card
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe(
      en.agents.page.sections.prompt,
    );
    expect(screen.getByText(PR.hint)).toBeTruthy();
    expect(loading.getAttribute("data-columns")).toBe("list-detail");
    expect(loading.closest('[data-part="form-section"]')?.getAttribute("data-layout")).toBe(
      "stacked",
    );
    expect(loading.querySelectorAll('[data-part="loading-repeater-item"]')).toHaveLength(1);
    expect(loading.querySelector('[data-box="textarea"]')?.getAttribute("style")).toContain(
      "--cb-skeleton-rows: 16",
    );
    await act(async () => release());
    expect(await screen.findByRole("textbox", { name: PR.nameLabel })).toBeTruthy();
  });

  it("prompt: the counts show the joined characters against 100 000 and the files against 20", async () => {
    stubApi(routes());
    await renderEditAgent({ section: "prompt" });
    expect(screen.getByText(`${JOINED.length} / 100,000 characters · 2 / 20 files`)).toBeTruthy();
  });

  it("prompt: editing an agent saved with prompt files sends instructionFiles only", async () => {
    const calls = stubApi(routes());
    await renderEditAgent({ section: "prompt" });
    const user = userEvent.setup();
    await user.click(within(fileList()).getByRole("button", { name: "STYLE.md" }));
    await user.type(contentBox(), " More.");
    await user.click(save());
    await vi.waitFor(() => expect(patches(calls)).toHaveLength(1));
    const body = patches(calls)[0] as { definition: Record<string, unknown> };
    // a stale instructions next to the files would be 400 agent.instructions_mismatch
    expect(body.definition).not.toHaveProperty("instructions");
    expect(body.definition.instructionFiles).toEqual([
      FILES[0],
      { name: "STYLE.md", content: "Be brief. More." },
    ]);
  });

  it("each section's save sends only its fields", async () => {
    const saved = agent();
    const calls = stubApi(routes(saved));
    const view = await renderEditAgent({ section: "model" });
    const user = userEvent.setup();
    const base = sent(saved);

    await pickOption(
      screen.getByRole("combobox", { name: (n) => n.startsWith(F.fallbackLabel) }),
      "other/o-1",
      user,
    );
    await user.click(save());
    await vi.waitFor(() => expect(patches(calls)).toHaveLength(1));
    expect(patches(calls)[0]).toEqual({
      definition: { ...base, fallback: { provider: "other", model: "o-1" }, fallbackParams: {} },
      expectedVersion: 1,
    });

    await view.navigate("/agents/ag1?s=tools");
    await user.click(screen.getByRole("checkbox", { name: F.builtin.SkillWrite }));
    await user.click(save());
    await vi.waitFor(() => expect(patches(calls)).toHaveLength(2));
    expect(patches(calls)[1]).toEqual({
      definition: {
        ...base,
        // unticking a builtin that is on writes it off
        disabledTools: [...saved.definition.disabledTools, { kind: "builtin", name: "SkillWrite" }],
      },
      expectedVersion: 1,
    });

    await view.navigate("/agents/ag1?s=skills");
    await user.click(await screen.findByRole("checkbox", { name: /pdf-tools/ }));
    await user.click(save());
    await vi.waitFor(() => expect(patches(calls)).toHaveLength(3));
    expect(patches(calls)[2]).toEqual({
      definition: { ...base, skills: { orgSkills: ["s1"] } },
      expectedVersion: 1,
    });

    await view.navigate("/agents/ag1?s=subagents");
    await user.click(screen.getByRole("checkbox", { name: F.subagents.agentTool }));
    await user.click(save());
    await vi.waitFor(() => expect(patches(calls)).toHaveLength(4));
    expect(patches(calls)[3]).toEqual({
      definition: {
        ...base,
        // the Agent tool is on by default: unticking it writes it off
        disabledTools: [...saved.definition.disabledTools, { kind: "builtin", name: "Agent" }],
      },
      expectedVersion: 1,
    });
  });

  it("an unrelated section's save keeps the prompt files: their join goes as instructions", async () => {
    // the kernel keeps the files when `instructions` equals their join (instruction-files.test.ts:
    // "an unrelated save sending the joined text keeps the files")
    const calls = stubApi(routes());
    await renderEditAgent({ section: "tools" });
    const user = userEvent.setup();
    await user.click(screen.getByRole("checkbox", { name: F.builtin.SkillWrite }));
    await user.click(save());
    await vi.waitFor(() => expect(patches(calls)).toHaveLength(1));
    const body = patches(calls)[0] as { definition: Record<string, unknown> };
    expect(body.definition.instructions).toBe(JOINED);
    expect(body.definition).not.toHaveProperty("instructionFiles");
  });

  it("skills writePolicy shows only for a saved private agent", async () => {
    const confirm = { name: F.confirmSkillWrite };
    stubApi(routes(agent({ visibility: "org" })));
    await renderEditAgent({ section: "skills" });
    expect(screen.queryByRole("checkbox", confirm)).toBeNull();
    cleanup();
    const calls = stubApi(routes(agent({ visibility: "private" })));
    await renderEditAgent({ section: "skills" });
    const user = userEvent.setup();
    await user.click(screen.getByRole("checkbox", confirm));
    await user.click(save());
    await vi.waitFor(() => expect(patches(calls)).toHaveLength(1));
    expect((patches(calls)[0] as { definition: { skills: unknown } }).definition.skills).toEqual({
      orgSkills: [],
      writePolicy: "ask",
    });
  });

  it("a stale expectedVersion shows the reload action", async () => {
    let current = agent();
    const calls = stubApi(
      routes(current, {
        [`GET ${ORG}/agents/ag1`]: () => json(200, { agent: current }),
        [`PATCH ${ORG}/agents/ag1`]: () =>
          json(409, { error: { code: "agent.version_conflict", message: "x" } }),
      }),
    );
    await renderEditAgent({ section: "model" });
    const user = userEvent.setup();
    await pickOption(
      screen.getByRole("combobox", { name: (n) => n.startsWith(F.fallbackLabel) }),
      "other/o-1",
      user,
    );
    // someone else saves version 2 meanwhile
    current = agent({ version: 2, definition: { model: { provider: "other", model: "o-1" } } });
    await user.click(save());
    const reload = await screen.findByRole("button", { name: en.agents.page.reload });
    expect(patches(calls)[0]).toMatchObject({ expectedVersion: 1 });
    await user.click(reload);
    // the section starts over from the newer version
    await vi.waitFor(() =>
      expect(
        (screen.getByRole("combobox", { name: F.modelLabel }) as HTMLButtonElement).value,
      ).toBe("other/o-1"),
    );
    expect(
      (
        screen.getByRole("combobox", {
          name: (n) => n.startsWith(F.fallbackLabel),
        }) as HTMLButtonElement
      ).value,
    ).toBe("");
    expect(document.querySelector('[data-part="action-row"]')).toBeNull();
  });

  it("typed edits survive a refetch; a clean section shows the newer saved version", async () => {
    const calls = stubApi(routes());
    const view = await renderEditAgent({ section: "prompt" });
    const user = userEvent.setup();
    await user.type(contentBox(), " Typed.");
    const newer = agent({
      version: 2,
      files: [{ name: "AGENTS.md", content: "Newer." }],
      instructions: "Newer.",
    });
    await act(async () => view.client.setQueryData(keys.org("o1").agent("ag1"), newer));
    expect(contentBox().value).toBe("Be helpful. Typed.");
    // the save is over the version the edit was made on
    await user.click(save());
    await vi.waitFor(() => expect(patches(calls)).toHaveLength(1));
    expect(patches(calls)[0]).toMatchObject({ expectedVersion: 1 });
    cleanup();

    stubApi(routes());
    const clean = await renderEditAgent({ section: "model" });
    await act(async () =>
      clean.client.setQueryData(
        keys.org("o1").agent("ag1"),
        agent({ version: 2, definition: { fallback: { provider: "other", model: "o-1" } } }),
      ),
    );
    expect(
      (
        screen.getByRole("combobox", {
          name: (n) => n.startsWith(F.fallbackLabel),
        }) as HTMLButtonElement
      ).value,
    ).toBe("other/o-1");
  });

  const SAME = { fallback: { provider: "model-fake", model: "fake-1" } };
  const hint = () => screen.queryByText(en.agents.warnings.fallback_same_provider);

  it("saving Tools shows no model warning, even when the kernel returns one", async () => {
    const a = agent({ definition: SAME });
    stubApi(
      routes(a, {
        [`PATCH ${ORG}/agents/ag1`]: ok({ agent: a, warnings: ["fallback_same_provider"] }),
      }),
    );
    await renderEditAgent({ section: "tools" });
    const user = userEvent.setup();
    await user.click(screen.getByRole("checkbox", { name: F.builtin.SkillWrite }));
    await user.click(save());
    await vi.waitFor(() => expect(document.querySelector('[data-part="action-row"]')).toBeNull());
    expect(hint()).toBeNull();
  });

  it("the Model section shows the same-provider hint persistently, live and only then", async () => {
    stubApi(routes(agent({ definition: SAME })));
    await renderEditAgent({ section: "model" });
    const warning = await screen.findByText(en.agents.warnings.fallback_same_provider);
    expect(warning.closest('[data-tone="warn"]')).not.toBeNull();
    cleanup();

    stubApi(routes(agent({ definition: { fallback: { provider: "other", model: "o-1" } } })));
    await renderEditAgent({ section: "model" });
    await screen.findByRole("combobox", { name: (n) => n.startsWith(F.fallbackLabel) });
    expect(hint()).toBeNull();
    // editing the fallback to the model's provider shows it before any save
    await pickOption(
      screen.getByRole("combobox", { name: (n) => n.startsWith(F.fallbackLabel) }),
      "model-fake/fake-1",
    );
    expect(hint()).not.toBeNull();
    cleanup();

    stubApi(routes(agent()));
    await renderEditAgent({ section: "model" });
    await screen.findByRole("combobox", { name: (n) => n.startsWith(F.fallbackLabel) });
    expect(hint()).toBeNull();
  });
});

// Moved from agent-form.test.tsx: the edit page's behaviours, now on the sections.
describe("the agent page lists its channels (spec 3.3.1)", () => {
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
  const channelRoutes = () => ({
    [`GET ${ORG}/agents/ag1`]: ok({ agent: agent() }),
    [`GET ${ORG}/models`]: ok(MODELS),
    [`GET ${ORG}/channels`]: ok({
      channels: [
        channel("c1", "Team Slack", "ag1"),
        channel("c2", "Other bot", "ag2"),
        channel("c3", "Broken bot", "ag1", "error"),
      ],
    }),
  });

  it("lists only this agent's connections; 接入渠道 presets the agent and the way back", async () => {
    stubApi(channelRoutes());
    await renderEditAgent({ locale: "zh", section: "channels" });
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

  it("each card draws its plugin's icon (the name's initial without one), the platform and the unbound mode, no agent", async () => {
    const icon = `${ORG}/catalog/i1/icon?v=1.0.0`;
    stubApi({
      ...channelRoutes(),
      [`GET ${ORG}/channels`]: ok({
        channels: [
          {
            ...channel("c1", "Team Slack", "ag1"),
            pluginIcon: icon,
            pluginDisplayName: { zh: "Slack", en: "Slack" },
          },
          channel("c3", "Broken bot", "ag1"),
        ],
      }),
    });
    await renderEditAgent({ locale: "zh", section: "channels" });
    const section = await screen.findByRole("region", { name: zh.agents.channels.title });
    // the same cards as the org 渠道 page: an ObjectCard per connection in a CardGrid
    const grid = await within(section).findByRole("list", { name: zh.agents.channels.title });
    expect(grid.getAttribute("data-part")).toBe("card-grid");
    const [slack, bare] = within(grid).getAllByRole("listitem") as HTMLElement[];
    expect(slack?.getAttribute("data-part")).toBe("object-card");
    const mark = (c: HTMLElement | undefined) =>
      c?.querySelector('[data-part="object-card-avatar"]') as HTMLElement;
    expect(mark(slack).querySelector('img[data-part="mark-image"]')?.getAttribute("src")).toBe(
      icon,
    );
    expect(mark(bare).querySelector("img")).toBeNull();
    expect(mark(bare).textContent).toBe("B");
    expect(within(slack as HTMLElement).getByRole("link", { name: "Team Slack" })).toBeTruthy();
    // the platform's display name (the plugin id without one) is the description; the meta is the
    // unbound mode alone: the agent is implicit here
    expect(slack?.querySelector('[data-part="object-card-description"]')?.textContent).toBe(
      "Slack",
    );
    expect(bare?.querySelector('[data-part="object-card-description"]')?.textContent).toBe("slack");
    expect(slack?.querySelector('[data-part="object-card-meta"]')?.textContent).toBe(
      zh.channels.policy.bind,
    );
    expect(slack?.querySelector('[data-part="object-card-state"]')?.textContent).toBe(
      zh.channels.status.active,
    );
    // one box only: no section card around the grid; 接入渠道 beside the heading
    expect(section.querySelector('[data-part="form-card"]')).toBeNull();
    expect(within(section).getByRole("heading", { level: 2 }).textContent).toBe(
      zh.agents.channels.title,
    );
    expect(within(section).getByText(zh.agents.channels.hint)).toBeTruthy();
    expect(within(section).getByRole("button", { name: zh.agents.channels.connect })).toBeTruthy();
    expect(findNestedBoxes(document.body)).toEqual([]);
  });

  it.each([
    ["the agent", `GET ${ORG}/agents/ag1`],
    ["the channels", `GET ${ORG}/channels`],
  ])(
    "an empty cache, %s on the way: the section's frame with skeleton cards, then the cards",
    async (_, held) => {
      let release: () => void = () => {};
      const wait = new Promise<void>((r) => {
        release = r;
      });
      const routes: Record<string, unknown> = {
        ...channelRoutes(),
        [`GET ${ORG}/channels`]: ok({ channels: [channel("c1", "Team Slack", "ag1")] }),
      };
      const answer = routes[held] as () => Response | Promise<Response>;
      await renderRouteEmptyCache("/agents/ag1?s=channels", {
        ...(routes as ReturnType<typeof channelRoutes>),
        [held]: async () => {
          await wait;
          return answer();
        },
      });
      const grid = await vi.waitFor(() => {
        const el = document.querySelector('[data-part="card-grid"]');
        if (el === null) throw new Error("no loading frame yet");
        return el as HTMLElement;
      });
      expect(grid.querySelectorAll('[data-skeleton="true"]').length).toBeGreaterThan(0);
      expect(document.querySelector('[data-part="form-card"]')).toBeNull();
      expect(findNestedBoxes(document.body)).toEqual([]);
      await act(async () => release());
      expect(await screen.findByRole("link", { name: "Team Slack" })).toBeTruthy();
    },
  );

  it("members see the cards read-only: no connect button, no links", async () => {
    stubApi(channelRoutes());
    await renderEditAgent({ me: as("member"), section: "channels" });
    const section = await screen.findByRole("region", { name: en.agents.channels.title });
    await within(section).findByText("Team Slack");
    expect(within(section).queryByRole("button", { name: en.agents.channels.connect })).toBeNull();
    expect(within(section).queryByRole("link")).toBeNull();
  });

  it("no connections: the settings area's empty state carries 接入渠道 for an admin, never a loose sentence", async () => {
    stubApi({ ...channelRoutes(), [`GET ${ORG}/channels`]: ok({ channels: [] }) });
    await renderEditAgent({ locale: "zh", section: "channels" });
    const section = await screen.findByRole("region", { name: zh.agents.channels.title });
    const empty = await within(section).findByText(zh.agents.channels.empty);
    const state = empty.closest('[data-part="empty-state"]') as HTMLElement;
    // on the page ground (no card around it): the page style
    expect(state.getAttribute("data-size")).toBe("page");
    // the one 接入渠道 is the empty state's action
    const buttons = within(section).getAllByRole("button", { name: zh.agents.channels.connect });
    expect(buttons).toHaveLength(1);
    expect(state.contains(buttons[0] as HTMLElement)).toBe(true);
    await userEvent.setup().click(buttons[0] as HTMLElement);
    expect(router.push).toHaveBeenCalledWith("/channels/new?agentId=ag1&returnTo=%2Fagents%2Fag1");
  });

  it("/agents/<id>: channels the kernel fails show the section's own error to an admin", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderEditAgent({
      routes: {
        [`GET ${ORG}/agents/ag1`]: ok({ agent: agent() }),
        [`GET ${ORG}/models`]: ok(MODELS),
        [`GET ${ORG}/channels`]: () => json(500, { error: { code: "internal" } }),
      },
      section: "channels",
    });
    expect(screen.getByText(en.agents.channels.loadFailed)).toBeTruthy();
    expect(browser).toEqual([]);
  });
});

describe("the agent page renders on the server (web-SSR spec §6)", () => {
  const withConnector = () =>
    agent({
      definition: { disabledTools: [{ kind: "connector", connectorId: "cn1", tools: ["find"] }] },
    });
  const connector = {
    id: "cn1",
    name: "Tracker",
    status: "active",
    auth: { type: "none" },
    tools: [{ name: "find", key: "mcp__tracker__find", status: "enabled" }],
  };
  const formRoutes = {
    [`GET ${ORG}/models`]: ok(MODELS),
    [`GET ${ORG}/connectors`]: ok({ connectors: [connector] }),
    [`GET ${ORG}/connectors/cn1`]: ok({ connector }),
    [`GET ${ORG}/skills`]: ok({ skills: [orgSkill("s1", "notes-style")] }),
  };
  const template = (name: string) => document.querySelector(`[data-template="${name}"]`);

  it("/agents/<id>?s=tools: the section, the selected connector's tools and the channels are the first paint", async () => {
    const browser = expectNoFirstPaintFetch();
    const view = await renderEditAgent({
      routes: { ...formRoutes, [`GET ${ORG}/agents/ag1`]: ok({ agent: withConnector() }) },
      readiness: NOT_READY,
      section: "tools",
    });
    expect(screen.getByRole("heading", { level: 1, name: "Helper" })).toBeTruthy();
    // the connector's row sums up its tools, read on the server
    expect(screen.getByText("1 off")).toBeTruthy();
    // another section paints from what the first load prefetched
    await view.navigate("/agents/ag1?s=channels");
    expect(screen.getByRole("region", { name: en.agents.channels.title })).toBeTruthy();
    await view.navigate("/agents/ag1?s=prompt");
    expect(nameBox().value).toBe("AGENTS.md");
    await settle();
    expect(browser).toEqual([]);
  });

  it("/agents/<id>: someone who may not change it reads only the agent (read-only view)", async () => {
    const browser = expectNoFirstPaintFetch();
    const { calls } = await renderEditAgent({
      routes: { [`GET ${ORG}/agents/ag1`]: ok({ agent: agent({ owner: "someone" }) }) },
      me: as("member"),
    });
    expect(new Set(calls.map((c) => c.url))).toEqual(
      new Set(["/api/v1/me", `${ORG}/readiness`, `${ORG}/agents/ag1`]),
    );
    expect(screen.getByText(en.agents.readOnly)).toBeTruthy();
    expect(browser).toEqual([]);
  });

  it("/agents/<id>: an agent the kernel does not find is the not-found state in the shell", async () => {
    const browser = expectNoFirstPaintFetch();
    const { calls } = await renderEditAgent({
      routes: {
        [`GET ${ORG}/agents/ag1`]: () =>
          json(404, { error: { code: "agent.not_found", message: "x" } }),
      },
    });
    expect(screen.getByRole("heading", { level: 1, name: en.notFound.title })).toBeTruthy();
    // nothing of the sections is read for an agent that does not exist
    expect(calls.map((c) => c.url)).not.toContain(`${ORG}/models`);
    await settle();
    expect(browser).toEqual([]);
  });

  it("/agents/<id>: a first render from the hydrated cache makes no browser read", async () => {
    const browser = stubApi({});
    await renderEditAgent({
      routes: { ...formRoutes, [`GET ${ORG}/agents/ag1`]: ok({ agent: withConnector() }) },
    });
    expect(screen.getByRole("textbox", { name: F.nameLabel })).toHaveProperty("value", "Helper");
    await settle();
    expect(browser.filter((c) => c.method === "GET")).toEqual([]);
  });

  it("/agents/<id>?s=tools: an empty cache shows the template's loading state, then the data", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    await renderRouteEmptyCache(`/agents/ag1?s=tools`, {
      ...agentFormDefaults(),
      ...formRoutes,
      [`GET ${ORG}/agents/ag1`]: ok({ agent: withConnector() }),
      [`GET ${ORG}/models`]: async () => {
        await held;
        return json(200, MODELS);
      },
    });
    const page = await vi.waitFor(() => {
      const el = template("SettingsPage");
      if (el === null || el.querySelector("[aria-busy='true']") === null)
        throw new Error("no loading page yet");
      return el as HTMLElement;
    });
    // the open section's static frame, as a placeholder; the head is the agent's already
    expect(page.querySelectorAll('[data-part="form-section"]').length).toBe(1);
    expect(screen.getByRole("heading", { level: 1, name: "Helper" })).toBeTruthy();
    expect(screen.queryByRole("list", { name: F.builtinLabel })).toBeNull();
    await act(async () => release());
    expect(await screen.findByRole("list", { name: F.builtinLabel })).toBeTruthy();
    await vi.waitFor(() => expect(document.querySelector("[aria-busy='true']")).toBeNull());
  });

  it("saving basics invalidates the agents list and the agent: the open agent is read again", async () => {
    const browser = stubApi({
      ...routes(withConnector()),
      ...formRoutes,
      [`PATCH ${ORG}/agents/ag1`]: ok({ agent: withConnector(), warnings: [] }),
    });
    await renderEditAgent({
      routes: { ...formRoutes, [`GET ${ORG}/agents/ag1`]: ok({ agent: withConnector() }) },
    });
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox", { name: F.nameLabel }), " 2");
    browser.length = 0;
    await user.click(save());
    await vi.waitFor(() =>
      expect(browser.filter((c) => c.method === "GET").map((c) => c.url)).toContain(
        `${ORG}/agents/ag1`,
      ),
    );
    await settle();
    // the save stays on the page; the active one is read again: the agent (the agents list is
    // invalidated too, but nothing on Basics observes it)
    const reads = browser.filter((c) => c.method === "GET").map((c) => c.url);
    expect(new Set(reads)).toEqual(new Set([`${ORG}/agents/ag1`]));
    expect(router.push).not.toHaveBeenCalled();
  });
});
