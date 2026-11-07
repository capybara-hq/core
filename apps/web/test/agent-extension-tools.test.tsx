import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { renderEditAgent } from "./support/agents";
import { bodyOf, json, stubApi } from "./support/api";
import { resetNavigation } from "./support/navigation";
import { pickOption } from "./support/select";
import { expectNoFirstPaintFetch, sessionRoutes } from "./support/server";

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
const ORG = "/api/v1/orgs/o1";
const T = "2026-11-06T08:00:00.000Z";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const agentWith = (tools: unknown[], toolPolicies: Record<string, string> = {}) => ({
  id: "ag1",
  orgId: "o1",
  ownerAccountId: "a1",
  visibility: "private",
  currentVersion: 2,
  memberIds: null,
  needsReassignment: false,
  createdAt: T,
  updatedAt: T,
  profile: { avatar: null, description: "", quickActions: [], updatedAt: T },
  definition: {
    name: "Grant",
    instructions: "Help.",
    model: { provider: "model-fake", model: "fake-1" },
    fallback: null,
    modelParams: {},
    fallbackParams: {},
    tools,
    toolPolicies,
  },
});

const MODELS = {
  providers: [
    {
      provider: "model-fake",
      models: [
        {
          id: "fake-1",
          displayName: "Fake 1",
          capabilities: { tools: true, vision: false, reasoning: false },
          parameters: [],
        },
      ],
    },
  ],
};

const TODO = {
  plugin: "todo",
  displayName: { zh: "待办", en: "Todo" },
  tools: [
    {
      name: "write",
      key: "plugin__todo__write",
      title: "Write the list",
      description: "Replace the todo list of the conversation.",
      annotations: {},
      defaultPolicy: "allow",
    },
    {
      name: "read",
      key: "plugin__todo__read",
      title: null,
      description: "Read the todo list of the conversation.",
      annotations: {},
      defaultPolicy: "allow",
    },
  ],
};
/** An extension with one untitled tool: its row goes by the extension's name. */
const BOARD = {
  plugin: "board",
  displayName: { zh: "看板", en: "Board" },
  tools: [
    {
      name: "post",
      key: "plugin__board__post",
      title: null,
      description: "Post a card.",
      annotations: {},
      defaultPolicy: "allow",
    },
  ],
};

const ASK = { kind: "builtin", name: "AskUserQuestion" };
const WRITE = { kind: "plugin", plugin: "todo", name: "write" };

const patchBody = (calls: { method: string; body?: unknown }[]) =>
  bodyOf(calls.find((c) => c.method === "PATCH") as never) as {
    definition: { tools: unknown[]; toolPolicies: Record<string, string> };
    expectedVersion: number;
  };

/** Opens the 配置 Sheet of the group `name`. */
async function openGroup(name: string, locale: "zh" | "en" = "en") {
  const m = msgs[locale].agents.form;
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", { name: m.configureGroup.replace("{name}", name) }),
  );
  return screen.findByRole("dialog", { name });
}

const routesWith = (agent: unknown, extensions: unknown[] = [TODO]) => ({
  ...sessionRoutes(),
  [`GET ${ORG}/agents/ag1`]: () => json(200, { agent }),
  [`GET ${ORG}/models`]: () => json(200, MODELS),
  [`GET ${ORG}/tools/extensions`]: () => json(200, { extensions }),
  [`PATCH ${ORG}/agents/ag1`]: () => json(200, { agent, warnings: [] }),
});

describe("agent page Tools section: one row per tool, groups in a Sheet", () => {
  beforeEach(() => resetNavigation("/agents/ag1"));

  it.each(["zh", "en"] as const)(
    "an extension is one row with a summary; its Sheet ticks a tool and the page saves it (%s)",
    async (locale) => {
      const m = msgs[locale].agents.form;
      const calls = stubApi(routesWith(agentWith([ASK])));
      await renderEditAgent({ section: "tools", locale });
      const groups = await screen.findByRole("list", { name: m.groupsLabel });
      const row = within(groups).getByRole("listitem");
      expect(within(row).getByText(TODO.displayName[locale])).toBeTruthy();
      expect(within(row).getByText(m.groupKind.extension)).toBeTruthy();
      expect(
        within(row).getByText(m.groupSummary.replace("{on}", "0").replace("{total}", "2")),
      ).toBeTruthy();
      // the model-facing description and the raw key are not drawn
      expect(screen.queryByText("Replace the todo list of the conversation.")).toBeNull();

      const sheet = await openGroup(TODO.displayName[locale], locale);
      const write = within(sheet).getByRole("checkbox", { name: "Write the list" });
      expect(write).toHaveProperty("checked", false);
      const user = userEvent.setup();
      await user.click(write);
      await user.click(within(sheet).getByRole("button", { name: m.sheetDone }));
      expect(
        within(row).getByText(m.groupSummary.replace("{on}", "1").replace("{total}", "2")),
      ).toBeTruthy();
      await user.click(screen.getByRole("button", { name: m.submit }));
      await vi.waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
      const body = patchBody(calls);
      expect(body.expectedVersion).toBe(2);
      expect(body.definition.tools).toEqual([ASK, WRITE]);
      expect(body.definition.toolPolicies).toEqual({});
    },
  );

  it("a tool's policy sits on its row: disabled while unticked, and the save sends it", async () => {
    const m = en.agents.form;
    const calls = stubApi(routesWith(agentWith([ASK, WRITE])));
    await renderEditAgent({ section: "tools" });
    const sheet = await openGroup("Todo");
    const writePolicy = within(sheet).getByRole("combobox", { name: "Policy for Write the list" });
    expect(writePolicy).toHaveProperty("disabled", false);
    // an untitled tool goes by its name among others; unticked, its select is off
    expect(within(sheet).getByRole("combobox", { name: "Policy for read" })).toHaveProperty(
      "disabled",
      true,
    );
    const user = userEvent.setup();
    await pickOption(writePolicy, m.policy.ask, user);
    await user.click(within(sheet).getByRole("button", { name: m.sheetDone }));
    const row = within(screen.getByRole("list", { name: m.groupsLabel })).getByRole("listitem");
    expect(
      within(row).getByText(
        `${m.groupSummary.replace("{on}", "1").replace("{total}", "2")} · ${m.groupAsk.replace("{count}", "1")}`,
      ),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: m.submit }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(patchBody(calls).definition.tools).toEqual([ASK, WRITE]);
    expect(patchBody(calls).definition.toolPolicies).toEqual({ plugin__todo__write: "ask" });
  });

  it("a builtin's policy sits on its row in the card", async () => {
    const m = en.agents.form;
    const calls = stubApi(routesWith(agentWith([ASK])));
    await renderEditAgent({ section: "tools" });
    const builtins = await screen.findByRole("list", { name: m.builtinLabel });
    expect(
      within(builtins).getByRole("combobox", { name: `Policy for ${m.builtin.SkillWrite}` }),
    ).toHaveProperty("disabled", true);
    const user = userEvent.setup();
    await pickOption(
      within(builtins).getByRole("combobox", { name: `Policy for ${m.builtin.AskUserQuestion}` }),
      m.policy.deny,
      user,
    );
    await user.click(screen.getByRole("button", { name: m.submit }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(patchBody(calls).definition.toolPolicies).toEqual({ AskUserQuestion: "deny" });
  });

  it("select-all in the Sheet ticks every tool of the group", async () => {
    const m = en.agents.form;
    const calls = stubApi(routesWith(agentWith([ASK])));
    await renderEditAgent({ section: "tools" });
    const sheet = await openGroup("Todo");
    const user = userEvent.setup();
    await user.click(within(sheet).getByRole("checkbox", { name: "Select all" }));
    expect(within(sheet).getByRole("checkbox", { name: "read" })).toHaveProperty("checked", true);
    await user.click(within(sheet).getByRole("button", { name: m.sheetDone }));
    await user.click(screen.getByRole("button", { name: m.submit }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(patchBody(calls).definition.tools).toEqual([
      ASK,
      WRITE,
      { kind: "plugin", plugin: "todo", name: "read" },
    ]);
  });

  it("an untitled tool alone in its extension goes by the extension's name", async () => {
    stubApi(routesWith(agentWith([ASK]), [BOARD]));
    await renderEditAgent({ section: "tools" });
    const sheet = await openGroup("Board");
    expect(within(sheet).getByRole("checkbox", { name: "Board" })).toBeTruthy();
    expect(within(sheet).queryByText("post")).toBeNull();
  });

  it("unticking a selected tool drops its reference and its policy", async () => {
    const m = en.agents.form;
    const agent = agentWith([ASK, WRITE], { plugin__todo__write: "ask" });
    const calls = stubApi(routesWith(agent));
    await renderEditAgent({ section: "tools" });
    const sheet = await openGroup("Todo");
    const write = within(sheet).getByRole("checkbox", { name: "Write the list" });
    expect(write).toHaveProperty("checked", true);
    expect(
      within(sheet).getByRole("combobox", { name: "Policy for Write the list" }).textContent,
    ).toContain(m.policy.ask);

    const user = userEvent.setup();
    await user.click(write);
    await user.click(within(sheet).getByRole("button", { name: m.sheetDone }));
    await user.click(screen.getByRole("button", { name: m.submit }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(patchBody(calls).definition.tools).toEqual([ASK]);
    expect(patchBody(calls).definition.toolPolicies).toEqual({});
  });

  it.each(["zh", "en"] as const)(
    "a selected tool of an extension that is off stays listed, ticked and unavailable (%s)",
    async (locale) => {
      const m = msgs[locale].agents.form;
      const calls = stubApi(routesWith(agentWith([ASK, WRITE]), []));
      await renderEditAgent({ section: "tools", locale });
      const groups = await screen.findByRole("list", { name: m.groupsLabel });
      expect(within(groups).getByText(m.groupUnavailable)).toBeTruthy();
      const sheet = await openGroup("todo", locale);
      const write = within(sheet).getByRole("checkbox", { name: "write" });
      expect(write).toHaveProperty("checked", true);
      const reason = m.extensionNotEnabled.replace("{extension}", "todo");
      expect(
        within(sheet).getByText(m.extensionToolUnavailable.replace("{reason}", reason)),
      ).toBeTruthy();
      const user = userEvent.setup();
      await user.click(within(sheet).getByRole("button", { name: m.sheetDone }));

      // saving another change keeps it
      await user.click(screen.getByRole("checkbox", { name: m.builtin.AskUserQuestion }));
      await user.click(screen.getByRole("button", { name: m.submit }));
      await vi.waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
      expect(patchBody(calls).definition.tools).toEqual([WRITE]);
    },
  );

  it("the extension tools are part of the first paint (no browser read)", async () => {
    const browser = expectNoFirstPaintFetch();
    const { calls } = await renderEditAgent({
      section: "tools",
      routes: {
        [`GET ${ORG}/agents/ag1`]: () => json(200, { agent: agentWith([ASK]) }),
        [`GET ${ORG}/models`]: () => json(200, MODELS),
        [`GET ${ORG}/tools/extensions`]: () => json(200, { extensions: [TODO] }),
      },
    });
    expect(calls.map((c) => c.url)).toContain(`${ORG}/tools/extensions`);
    expect(screen.getByRole("button", { name: "Configure Todo" })).toBeTruthy();
    await new Promise((r) => setTimeout(r, 50));
    expect(browser).toEqual([]);
  });
});

describe("agent page Tools section: connectors", () => {
  beforeEach(() => resetNavigation("/agents/ag1"));

  const tool = (name: string, title: string | null, status = "enabled") => ({
    name,
    key: `mcp__docs__${name}`,
    title,
    status,
    description: `${name}.`,
    inputSchema: {},
    annotations: null,
    connectorData: null,
    defaultPolicy: "allow",
    issue: null,
  });
  const DOCS = {
    id: "cn1",
    slug: "docs",
    name: "Docs",
    connector: "mcp",
    status: "active",
    tools: [
      tool("search", "Search documents"),
      tool("create", "Create document"),
      tool("drop", null, "disabled"),
    ],
    credential: { ownership: null, status: "connected" },
  };
  const routes = (tools: unknown[], policies: Record<string, string> = {}) => {
    const agent = agentWith(tools, policies);
    return {
      ...routesWith(agent, []),
      [`GET ${ORG}/connectors`]: () => json(200, { connectors: [DOCS] }),
      [`GET ${ORG}/connectors/cn1`]: () => json(200, { connector: DOCS }),
    };
  };

  it("a whole connector shows its enabled tools by title, all ticked; unticking one names the rest", async () => {
    const m = en.agents.form;
    const calls = stubApi(
      routes([ASK, { kind: "connector", connectorId: "cn1", tools: "all" }], {
        mcp__docs__create: "ask",
      }),
    );
    await renderEditAgent({ section: "tools" });
    const groups = await screen.findByRole("list", { name: m.groupsLabel });
    expect(
      within(groups).getByText(
        `${m.groupSummary.replace("{on}", "2").replace("{total}", "2")} · ${m.groupAsk.replace("{count}", "1")}`,
      ),
    ).toBeTruthy();
    const sheet = await openGroup("Docs");
    expect(within(sheet).queryByText("drop")).toBeNull();
    const user = userEvent.setup();
    await user.click(within(sheet).getByRole("checkbox", { name: "Search documents" }));
    await user.click(within(sheet).getByRole("button", { name: m.sheetDone }));
    await user.click(screen.getByRole("button", { name: m.submit }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(patchBody(calls).definition.tools).toEqual([
      ASK,
      { kind: "connector", connectorId: "cn1", tools: ["create"] },
    ]);
    expect(patchBody(calls).definition.toolPolicies).toEqual({ mcp__docs__create: "ask" });
  });

  it("an unused connector's Sheet reads its tools; select-all takes it whole", async () => {
    const m = en.agents.form;
    const calls = stubApi(routes([ASK]));
    await renderEditAgent({ section: "tools" });
    const groups = await screen.findByRole("list", { name: m.groupsLabel });
    expect(within(groups).getByText(m.groupUnused)).toBeTruthy();
    const sheet = await openGroup("Docs");
    const user = userEvent.setup();
    await user.click(await within(sheet).findByRole("checkbox", { name: "Select all" }));
    await user.click(within(sheet).getByRole("button", { name: m.sheetDone }));
    await user.click(screen.getByRole("button", { name: m.submit }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(patchBody(calls).definition.tools).toEqual([
      ASK,
      { kind: "connector", connectorId: "cn1", tools: "all" },
    ]);
  });
});
