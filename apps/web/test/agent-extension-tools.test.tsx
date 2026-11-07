import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { renderEditAgent } from "./support/agents";
import { bodyOf, json, stubApi } from "./support/api";
import { resetNavigation } from "./support/navigation";
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
  ],
};

const ASK = { kind: "builtin", name: "AskUserQuestion" };

const patchBody = (calls: { method: string; body?: unknown }[]) =>
  bodyOf(calls.find((c) => c.method === "PATCH") as never) as {
    definition: { tools: unknown[]; toolPolicies: Record<string, string> };
  };

describe("agent page Tools section: extension tools", () => {
  beforeEach(() => resetNavigation("/agents/ag1"));

  it.each(["zh", "en"] as const)(
    "lists the enabled extensions' tools by extension; ticking one saves its reference (%s)",
    async (locale) => {
      const m = msgs[locale].agents.form;
      const calls = stubApi({
        ...sessionRoutes(),
        [`GET ${ORG}/agents/ag1`]: () => json(200, { agent: agentWith([ASK]) }),
        [`GET ${ORG}/models`]: () => json(200, MODELS),
        [`GET ${ORG}/tools/extensions`]: () => json(200, { extensions: [TODO] }),
        [`PATCH ${ORG}/agents/ag1`]: () => json(200, { agent: agentWith([ASK]), warnings: [] }),
      });
      await renderEditAgent({
        section: "tools",
        locale,
      });
      const group = await screen.findByRole("group", { name: m.extensionToolsLabel });
      const ext = within(group).getByRole("group", { name: TODO.displayName[locale] });
      const write = within(ext).getByRole("checkbox", { name: "Write the list" });
      expect(write).toHaveProperty("checked", false);
      expect(within(ext).getByText("Replace the todo list of the conversation.")).toBeTruthy();

      const user = userEvent.setup();
      await user.click(write);
      await user.click(screen.getByRole("button", { name: m.submit }));
      await vi.waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
      expect(patchBody(calls).definition.tools).toEqual([
        ASK,
        { kind: "plugin", plugin: "todo", name: "write" },
      ]);
    },
  );

  it("unticking a selected tool drops its reference and its policy", async () => {
    const m = en.agents.form;
    const ref = { kind: "plugin", plugin: "todo", name: "write" };
    const agent = agentWith([ASK, ref], { plugin__todo__write: "ask" });
    const calls = stubApi({
      ...sessionRoutes(),
      [`GET ${ORG}/agents/ag1`]: () => json(200, { agent }),
      [`GET ${ORG}/models`]: () => json(200, MODELS),
      [`GET ${ORG}/tools/extensions`]: () => json(200, { extensions: [TODO] }),
      [`PATCH ${ORG}/agents/ag1`]: () => json(200, { agent: agentWith([ASK]), warnings: [] }),
    });
    await renderEditAgent({
      section: "tools",
    });
    const write = await screen.findByRole("checkbox", { name: "Write the list" });
    expect(write).toHaveProperty("checked", true);
    // its policy is listed like the others
    expect(screen.getByRole("combobox", { name: "Todo [write]" })).toHaveProperty("value", "ask");

    const user = userEvent.setup();
    await user.click(write);
    await user.click(screen.getByRole("button", { name: m.submit }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(patchBody(calls).definition.tools).toEqual([ASK]);
    expect(patchBody(calls).definition.toolPolicies).toEqual({});
  });

  it.each(["zh", "en"] as const)(
    "a selected tool of an extension that is off stays listed, ticked and unavailable (%s)",
    async (locale) => {
      const m = msgs[locale].agents.form;
      const ref = { kind: "plugin", plugin: "todo", name: "write" };
      const calls = stubApi({
        ...sessionRoutes(),
        [`GET ${ORG}/agents/ag1`]: () => json(200, { agent: agentWith([ASK, ref]) }),
        [`GET ${ORG}/models`]: () => json(200, MODELS),
        [`GET ${ORG}/tools/extensions`]: () => json(200, { extensions: [] }),
        [`PATCH ${ORG}/agents/ag1`]: () => json(200, { agent: agentWith([ASK]), warnings: [] }),
      });
      await renderEditAgent({
        section: "tools",
        locale,
      });
      const group = await screen.findByRole("group", { name: "todo" });
      const write = within(group).getByRole("checkbox", { name: "write" });
      expect(write).toHaveProperty("checked", true);
      const reason = m.extensionNotEnabled.replace("{extension}", "todo");
      expect(
        within(group).getByText(m.extensionToolUnavailable.replace("{reason}", reason)),
      ).toBeTruthy();
      expect(screen.queryByText(m.noExtensionTools)).toBeNull();

      // saving another change keeps it
      const user = userEvent.setup();
      await user.click(screen.getByRole("checkbox", { name: m.builtin.AskUserQuestion }));
      await user.click(screen.getByRole("button", { name: m.submit }));
      await vi.waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
      expect(patchBody(calls).definition.tools).toEqual([ref]);
    },
  );

  it.each(["zh", "en"] as const)(
    "a selected tool the org turned off shows the switched-off reason (%s)",
    async (locale) => {
      const m = msgs[locale].agents.form;
      const ref = { kind: "plugin", plugin: "todo", name: "write" };
      stubApi({
        ...sessionRoutes(),
        [`GET ${ORG}/agents/ag1`]: () => json(200, { agent: agentWith([ASK, ref]) }),
        [`GET ${ORG}/models`]: () => json(200, MODELS),
        [`GET ${ORG}/tools/extensions`]: () =>
          json(200, {
            extensions: [{ ...TODO, tools: [{ ...TODO.tools[0], switchedOff: true }] }],
          }),
      });
      await renderEditAgent({ section: "tools", locale });
      const ext = await screen.findByRole("group", { name: TODO.displayName[locale] });
      expect(within(ext).getByText(m.extensionToolOffInOrg)).toBeTruthy();
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
    expect(screen.getByRole("checkbox", { name: "Write the list" })).toBeTruthy();
    await new Promise((r) => setTimeout(r, 50));
    expect(browser).toEqual([]);
  });
});
