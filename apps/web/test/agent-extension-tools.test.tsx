import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { renderEditAgent } from "./support/agents";
import { bodyOf, json, stubApi } from "./support/api";
import { resetNavigation } from "./support/navigation";
import { optionLabels, pickOption } from "./support/select";
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

const agentWith = (disabledTools: unknown[], toolPolicies: Record<string, string> = {}) => ({
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
    disabledTools,
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

const ASK_OFF = { kind: "builtin", name: "AskUserQuestion" };
const todoOff = (tools: "all" | string[]) => ({ kind: "plugin", plugin: "todo", tools });

const patchBody = (calls: { method: string; body?: unknown }[]) =>
  bodyOf(calls.find((c) => c.method === "PATCH") as never) as {
    definition: { disabledTools: unknown[]; toolPolicies: Record<string, string> };
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

describe("agent page Tools section: everything on by default, groups in a Sheet", () => {
  beforeEach(() => resetNavigation("/agents/ag1"));

  it.each(["zh", "en"] as const)(
    "an extension is one row reading all on; unticking a tool in its Sheet writes it off (%s)",
    async (locale) => {
      const m = msgs[locale].agents.form;
      const calls = stubApi(routesWith(agentWith([])));
      await renderEditAgent({ section: "tools", locale });
      const groups = await screen.findByRole("list", { name: m.groupsLabel });
      const row = within(groups).getByRole("listitem");
      expect(within(row).getByText(TODO.displayName[locale])).toBeTruthy();
      expect(within(row).getByText(m.groupKind.extension)).toBeTruthy();
      expect(within(row).getByText(m.groupAllOn)).toBeTruthy();
      // the model-facing description and the raw key are not drawn
      expect(screen.queryByText("Replace the todo list of the conversation.")).toBeNull();

      const sheet = await openGroup(TODO.displayName[locale], locale);
      const write = within(sheet).getByRole("checkbox", { name: "Write the list" });
      // tools default-on: every box starts checked
      expect(write).toHaveProperty("checked", true);
      expect(within(sheet).getByRole("checkbox", { name: "read" })).toHaveProperty("checked", true);
      const user = userEvent.setup();
      await user.click(write);
      await user.click(within(sheet).getByRole("button", { name: m.sheetDone }));
      expect(within(row).getByText(m.groupOff.replace("{count}", "1"))).toBeTruthy();
      await user.click(screen.getByRole("button", { name: m.submit }));
      await vi.waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
      const body = patchBody(calls);
      expect(body.expectedVersion).toBe(2);
      expect(body.definition.disabledTools).toEqual([todoOff(["write"])]);
      expect(body.definition.toolPolicies).toEqual({});
    },
  );

  it("a tool's policy sits on its row: disabled while turned off, and the save sends it", async () => {
    const m = en.agents.form;
    const calls = stubApi(routesWith(agentWith([todoOff(["read"])])));
    await renderEditAgent({ section: "tools" });
    const sheet = await openGroup("Todo");
    const writePolicy = within(sheet).getByRole("combobox", { name: "Policy for Write the list" });
    expect(writePolicy).toHaveProperty("disabled", false);
    // an untitled tool goes by its name among others; turned off, its select is off
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
        `${m.groupOff.replace("{count}", "1")} · ${m.groupAsk.replace("{count}", "1")}`,
      ),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: m.submit }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(patchBody(calls).definition.disabledTools).toEqual([todoOff(["read"])]);
    expect(patchBody(calls).definition.toolPolicies).toEqual({ plugin__todo__write: "ask" });
  });

  it("a builtin's policy sits on its row in the card; a turned-off builtin's is disabled", async () => {
    const m = en.agents.form;
    const calls = stubApi(routesWith(agentWith([ASK_OFF])));
    await renderEditAgent({ section: "tools" });
    const builtins = await screen.findByRole("list", { name: m.builtinLabel });
    expect(
      within(builtins).getByRole("checkbox", { name: m.builtin.AskUserQuestion }),
    ).toHaveProperty("checked", false);
    expect(within(builtins).getByRole("checkbox", { name: m.builtin.Bash })).toHaveProperty(
      "checked",
      true,
    );
    expect(
      within(builtins).getByRole("combobox", { name: `Policy for ${m.builtin.AskUserQuestion}` }),
    ).toHaveProperty("disabled", true);
    const user = userEvent.setup();
    await pickOption(
      within(builtins).getByRole("combobox", { name: `Policy for ${m.builtin.Deliver}` }),
      m.policy.deny,
      user,
    );
    await user.click(screen.getByRole("button", { name: m.submit }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(patchBody(calls).definition.toolPolicies).toEqual({ Deliver: "deny" });
    expect(patchBody(calls).definition.disabledTools).toEqual([ASK_OFF]);
  });

  it("unticking a builtin writes it off; ticking it again removes it", async () => {
    const m = en.agents.form;
    const calls = stubApi(routesWith(agentWith([ASK_OFF])));
    await renderEditAgent({ section: "tools" });
    const builtins = await screen.findByRole("list", { name: m.builtinLabel });
    const user = userEvent.setup();
    await user.click(within(builtins).getByRole("checkbox", { name: m.builtin.AskUserQuestion }));
    await user.click(within(builtins).getByRole("checkbox", { name: m.builtin.Bash }));
    await user.click(screen.getByRole("button", { name: m.submit }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(patchBody(calls).definition.disabledTools).toEqual([{ kind: "builtin", name: "Bash" }]);
  });

  it("unticking every tool of a group turns it off as a unit", async () => {
    const m = en.agents.form;
    const calls = stubApi(routesWith(agentWith([])));
    await renderEditAgent({ section: "tools" });
    const sheet = await openGroup("Todo");
    const user = userEvent.setup();
    await user.click(within(sheet).getByRole("checkbox", { name: "Select all" }));
    expect(within(sheet).getByRole("checkbox", { name: "read" })).toHaveProperty("checked", false);
    await user.click(within(sheet).getByRole("button", { name: m.sheetDone }));
    const row = within(screen.getByRole("list", { name: m.groupsLabel })).getByRole("listitem");
    expect(within(row).getByText(m.groupAllOff)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: m.submit }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(patchBody(calls).definition.disabledTools).toEqual([todoOff("all")]);
  });

  it("an untitled tool alone in its extension goes by the extension's name", async () => {
    stubApi(routesWith(agentWith([]), [BOARD]));
    await renderEditAgent({ section: "tools" });
    const sheet = await openGroup("Board");
    expect(within(sheet).getByRole("checkbox", { name: "Board" })).toBeTruthy();
    expect(within(sheet).queryByText("post")).toBeNull();
  });

  it("ticking a turned-off tool turns it back on; its policy stays with it", async () => {
    const m = en.agents.form;
    const agent = agentWith([todoOff(["write"])], { plugin__todo__write: "ask" });
    const calls = stubApi(routesWith(agent));
    await renderEditAgent({ section: "tools" });
    const sheet = await openGroup("Todo");
    const write = within(sheet).getByRole("checkbox", { name: "Write the list" });
    expect(write).toHaveProperty("checked", false);
    const user = userEvent.setup();
    await user.click(write);
    await user.click(within(sheet).getByRole("button", { name: m.sheetDone }));
    await user.click(screen.getByRole("button", { name: m.submit }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(patchBody(calls).definition.disabledTools).toEqual([]);
    expect(patchBody(calls).definition.toolPolicies).toEqual({ plugin__todo__write: "ask" });
  });

  it.each(["zh", "en"] as const)(
    "an entry for an extension that is off in the org stays as saved (%s)",
    async (locale) => {
      const m = msgs[locale].agents.form;
      const calls = stubApi(routesWith(agentWith([todoOff(["write"])]), []));
      await renderEditAgent({ section: "tools", locale });
      await screen.findByRole("list", { name: m.builtinLabel });
      expect(
        screen.queryByRole("button", { name: m.configureGroup.replace("{name}", "todo") }),
      ).toBeNull();
      // saving another change keeps it
      const user = userEvent.setup();
      await user.click(screen.getByRole("checkbox", { name: m.builtin.AskUserQuestion }));
      await user.click(screen.getByRole("button", { name: m.submit }));
      await vi.waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
      expect(patchBody(calls).definition.disabledTools).toEqual([todoOff(["write"]), ASK_OFF]);
    },
  );

  it.each(["zh", "en"] as const)(
    "a tool the org turned off shows the switched-off reason on its row (%s)",
    async (locale) => {
      const m = msgs[locale].agents.form;
      stubApi({
        ...sessionRoutes(),
        [`GET ${ORG}/agents/ag1`]: () => json(200, { agent: agentWith([]) }),
        [`GET ${ORG}/models`]: () => json(200, MODELS),
        [`GET ${ORG}/tools/extensions`]: () =>
          json(200, {
            extensions: [{ ...TODO, tools: [{ ...TODO.tools[0], switchedOff: true }] }],
          }),
      });
      await renderEditAgent({ section: "tools", locale });
      const sheet = await openGroup(TODO.displayName[locale], locale);
      expect(within(sheet).getByText(m.extensionToolOffInOrg)).toBeTruthy();
    },
  );

  it("the extension tools are part of the first paint (no browser read)", async () => {
    const browser = expectNoFirstPaintFetch();
    const { calls } = await renderEditAgent({
      section: "tools",
      routes: {
        [`GET ${ORG}/agents/ag1`]: () => json(200, { agent: agentWith([]) }),
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
    auth: { type: "bearer", ownership: "org" },
    credential: { ownership: null, status: "connected" },
  };
  const routes = (
    disabled: unknown[],
    policies: Record<string, string> = {},
    connector: typeof DOCS = DOCS,
  ) => {
    const agent = agentWith(disabled, policies);
    return {
      ...routesWith(agent, []),
      [`GET ${ORG}/connectors`]: () => json(200, { connectors: [connector] }),
      [`GET ${ORG}/connectors/cn1`]: () => json(200, { connector }),
    };
  };

  it("允许 is offered only on a personal-credential connector's tools; an org credential's only tighten", async () => {
    const m = en.agents.form;
    stubApi(routes([]));
    await renderEditAgent({ section: "tools" });
    let sheet = await openGroup("Docs");
    const orgSelect = await within(sheet).findByRole("combobox", {
      name: "Policy for Search documents",
    });
    expect(await optionLabels(orgSelect)).toEqual([m.policy.default, m.policy.ask, m.policy.deny]);
    expect(within(sheet).queryByText(m.connectorPolicyHint)).toBeNull();
    cleanup();
    stubApi(routes([], {}, { ...DOCS, auth: { type: "bearer", ownership: "personal" } }));
    await renderEditAgent({ section: "tools" });
    sheet = await openGroup("Docs");
    const personalSelect = await within(sheet).findByRole("combobox", {
      name: "Policy for Search documents",
    });
    expect(await optionLabels(personalSelect)).toEqual([
      m.policy.default,
      m.policy.allow,
      m.policy.ask,
      m.policy.deny,
    ]);
    expect(within(sheet).getByText(m.connectorPolicyHint)).toBeTruthy();
  });

  it("an org connector is on for the agent: its enabled tools all ticked; unticking one turns it off", async () => {
    const m = en.agents.form;
    const calls = stubApi(routes([], { mcp__docs__create: "ask" }));
    await renderEditAgent({ section: "tools" });
    const groups = await screen.findByRole("list", { name: m.groupsLabel });
    expect(
      within(groups).getByText(`${m.groupAllOn} · ${m.groupAsk.replace("{count}", "1")}`),
    ).toBeTruthy();
    const sheet = await openGroup("Docs");
    expect(within(sheet).queryByText("drop")).toBeNull();
    const search = await within(sheet).findByRole("checkbox", { name: "Search documents" });
    expect(search).toHaveProperty("checked", true);
    const user = userEvent.setup();
    await user.click(search);
    await user.click(within(sheet).getByRole("button", { name: m.sheetDone }));
    await user.click(screen.getByRole("button", { name: m.submit }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(patchBody(calls).definition.disabledTools).toEqual([
      { kind: "connector", connectorId: "cn1", tools: ["search"] },
    ]);
    expect(patchBody(calls).definition.toolPolicies).toEqual({ mcp__docs__create: "ask" });
  });

  it("a connector turned off as a whole reads all off; select-all turns it back on", async () => {
    const m = en.agents.form;
    const calls = stubApi(routes([{ kind: "connector", connectorId: "cn1", tools: "all" }]));
    await renderEditAgent({ section: "tools" });
    const groups = await screen.findByRole("list", { name: m.groupsLabel });
    expect(within(groups).getByText(m.groupAllOff)).toBeTruthy();
    const sheet = await openGroup("Docs");
    const user = userEvent.setup();
    await user.click(await within(sheet).findByRole("checkbox", { name: "Select all" }));
    await user.click(within(sheet).getByRole("button", { name: m.sheetDone }));
    await user.click(screen.getByRole("button", { name: m.submit }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(patchBody(calls).definition.disabledTools).toEqual([]);
  });
});
