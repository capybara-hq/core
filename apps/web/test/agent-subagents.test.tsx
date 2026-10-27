import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import EditAgentPage from "../src/app/[locale]/(app)/agents/[id]/page";
import { bodyOf, json, stubApi } from "./support/api";
import { resetNavigation } from "./support/navigation";
import { renderPage } from "./support/render";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("next/navigation", () => ({ useParams: () => ({ id: "ag1" }) }));

/**
 * Phase C Task 19: the agent page's Sub-agents section (the agent tool, general-purpose, plugin
 * templates, inline templates, allowlisted org agents with their warnings, and the dispatchable
 * switch), and the 400 `agent.subagents_invalid` reasons next to their fields.
 */

const T = "2026-10-20T08:00:00.000Z";
const ORG = "/api/v1/orgs/o1";
const S = en.agents.form.subagents;
const CAPS = { tools: true, vision: false, reasoning: false };
const MODELS = {
  providers: [
    {
      provider: "model-fake",
      models: [{ id: "fake-1", displayName: "Fake 1", capabilities: CAPS, parameters: [] }],
    },
  ],
};

const agent = (
  id: string,
  name: string,
  over: { visibility?: string; owner?: string; definition?: Record<string, unknown> } = {},
) => ({
  id,
  orgId: "o1",
  ownerAccountId: over.owner ?? "a1",
  visibility: over.visibility ?? "org",
  currentVersion: 3,
  memberIds: null as string[] | null,
  needsReassignment: false,
  createdAt: T,
  updatedAt: T,
  definition: {
    name,
    instructions: "Be helpful.",
    model: { provider: "model-fake", model: "fake-1" },
    fallback: null,
    modelParams: {},
    fallbackParams: {},
    tools: [{ kind: "builtin", name: "ask_user" }],
    toolPolicies: {},
    ...over.definition,
  },
});

const LEAD = agent("ag1", "Lead");
const ANALYST = agent("ag2", "Data analyst", {
  visibility: "private",
  owner: "a2",
  definition: { subagents: { dispatchable: true } },
});
const QUIET = agent("ag3", "Quiet");

const TEMPLATES = [
  {
    id: "t1",
    name: "code-reviewer",
    plugin: "superpowers",
    type: "superpowers:code-reviewer",
    description: "Reviews code.",
    model: "capable",
    version: 1,
    sourceFormat: "claude-code",
    catalogItemId: "i1",
    catalogVersion: "7.0.0",
  },
];

function routes(lead = LEAD) {
  return {
    [`GET ${ORG}/agents/ag1`]: () => json(200, { agent: lead }),
    [`GET ${ORG}/agents`]: () => json(200, { agents: [lead, ANALYST, QUIET] }),
    [`GET ${ORG}/agent-templates`]: () => json(200, { templates: TEMPLATES }),
    [`GET ${ORG}/members`]: () =>
      json(200, {
        members: [
          { account: { id: "a1", displayName: "Grant", email: null }, role: "owner", joinedAt: T },
          { account: { id: "a2", displayName: "Lin", email: null }, role: "member", joinedAt: T },
        ],
      }),
    [`GET ${ORG}/models`]: () => json(200, MODELS),
    [`GET ${ORG}/connectors`]: () => json(200, { connectors: [] }),
    [`GET ${ORG}/skills`]: () => json(200, { skills: [] }),
    [`GET ${ORG}/agents/ag1/skills`]: () => json(200, { skills: [] }),
  };
}

const section = (name = S.section) => screen.findByRole("region", { name });

beforeEach(() => resetNavigation("/agents/ag1"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the agent page's Sub-agents section", () => {
  it("saving templates, an inline template and an org agent sends the subagents block and the agent tool", async () => {
    const calls = stubApi({
      ...routes(),
      [`PATCH ${ORG}/agents/ag1`]: () => json(200, { agent: LEAD, warnings: [] }),
    });
    renderPage(<EditAgentPage />);
    const user = userEvent.setup();
    const s = await section();
    await user.click(within(s).getByRole("checkbox", { name: S.agentTool }));
    // general-purpose is on by default
    expect(within(s).getByRole("checkbox", { name: S.general })).toHaveProperty("checked", true);
    await user.click(await within(s).findByRole("checkbox", { name: /superpowers:code-reviewer/ }));
    // only dispatchable agents other than this one are offered
    const analyst = await within(s).findByRole("checkbox", { name: /Data analyst/ });
    expect(within(s).queryByRole("checkbox", { name: /Quiet/ })).toBeNull();
    expect(analyst.closest("label")?.textContent).toContain("Lin");
    await user.click(analyst);
    // the allowlist warnings: what is shown to every user, and the narrower visibility
    expect(s.textContent).toContain(S.agentsWarning);
    expect(s.textContent).toContain(S.widerWarning.replaceAll("{name}", "Data analyst"));
    await user.type(
      within(s).getByRole("textbox", { name: S.agentAs.replace("{name}", "Data analyst") }),
      "analyst",
    );
    await user.type(
      within(s).getByRole("textbox", {
        name: S.agentDescription.replace("{name}", "Data analyst"),
      }),
      "Answers data questions.",
    );
    await user.click(within(s).getByRole("button", { name: S.addInline }));
    await user.type(within(s).getByRole("textbox", { name: S.inlineName }), "helper");
    await user.type(within(s).getByRole("textbox", { name: S.inlineDescription }), "Helps.");
    await user.type(within(s).getByRole("textbox", { name: S.inlineInstructions }), "Help out.");
    await user.selectOptions(within(s).getByRole("combobox", { name: S.inlineModel }), "fast");
    await user.click(screen.getByRole("button", { name: en.agents.form.submit }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const body = bodyOf(calls.find((c) => c.method === "PATCH")) as {
      definition: Record<string, unknown>;
    };
    expect(body.definition.tools).toEqual([
      { kind: "builtin", name: "ask_user" },
      { kind: "builtin", name: "agent" },
    ]);
    expect(body.definition.subagents).toEqual({
      templates: ["t1"],
      inline: [{ name: "helper", description: "Helps.", instructions: "Help out.", model: "fast" }],
      agents: [{ agentId: "ag2", as: "analyst", description: "Answers data questions." }],
    });
  });

  it("an agent without sub-agent settings saves without a subagents block", async () => {
    const calls = stubApi({
      ...routes(),
      [`PATCH ${ORG}/agents/ag1`]: () => json(200, { agent: LEAD, warnings: [] }),
    });
    renderPage(<EditAgentPage />);
    await section();
    await userEvent.setup().click(screen.getByRole("button", { name: en.agents.form.submit }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const body = bodyOf(calls.find((c) => c.method === "PATCH")) as {
      definition: Record<string, unknown>;
    };
    expect("subagents" in body.definition).toBe(false);
  });

  it.each(["zh", "en"] as const)(
    "the 400 agent.subagents_invalid reasons show next to the field (%s)",
    async (locale) => {
      const m = (locale === "zh" ? zh : en).agents.form.subagents;
      const lead = agent("ag1", "Lead", {
        definition: {
          tools: [{ kind: "builtin", name: "agent" }],
          subagents: {
            inline: [{ name: "Bad Name", description: "x", instructions: "y" }],
            agents: [{ agentId: "ag2", as: "analyst", description: "d" }],
          },
        },
      });
      stubApi({
        ...routes(lead),
        [`PATCH ${ORG}/agents/ag1`]: () =>
          json(400, {
            error: {
              code: "agent.subagents_invalid",
              message: "Invalid sub-agents",
              details: [
                { reason: "invalid_name", path: "subagents.inline.0.name", value: "Bad Name" },
                { reason: "agent_not_available", path: "subagents.agents.0.agentId", value: "ag2" },
              ],
            },
          }),
      });
      renderPage(<EditAgentPage />, { locale });
      const s = await section(m.section);
      await userEvent
        .setup()
        .click(
          screen.getByRole("button", { name: (locale === "zh" ? zh : en).agents.form.submit }),
        );
      const nameField = within(s).getByRole("textbox", { name: m.inlineName });
      await vi.waitFor(() => expect(nameField.getAttribute("aria-invalid")).toBe("true"));
      expect(s.textContent).toContain(m.reasons.invalid_name.replace("{value}", "Bad Name"));
      expect(s.textContent).toContain(m.reasons.agent_not_available.replace("{value}", "ag2"));
    },
  );

  it("a validation_failed save marks the empty required fields of an inline template (batch 14 review m8)", async () => {
    const lead = agent("ag1", "Lead", {
      definition: {
        tools: [{ kind: "builtin", name: "agent" }],
        subagents: { inline: [{ name: "helper", description: "", instructions: "Help." }] },
      },
    });
    stubApi({
      ...routes(lead),
      [`PATCH ${ORG}/agents/ag1`]: () =>
        json(400, {
          error: {
            code: "validation_failed",
            message: "Invalid input",
            details: [{ path: "definition.subagents.inline.0.description", message: "Too small" }],
          },
        }),
    });
    renderPage(<EditAgentPage />);
    const s = await section();
    await userEvent.setup().click(screen.getByRole("button", { name: en.agents.form.submit }));
    const description = within(s).getByRole("textbox", { name: S.inlineDescription });
    await vi.waitFor(() => expect(description.getAttribute("aria-invalid")).toBe("true"));
    expect(s.textContent).toContain(S.reasons.required);
    const instructions = within(s).getByRole("textbox", { name: S.inlineInstructions });
    expect(instructions.getAttribute("aria-invalid")).not.toBe("true");
  });

  it("the shared-more-widely warning covers a members agent whose members the target lacks (batch 14 review m9)", async () => {
    const lead = {
      ...agent("ag1", "Lead", {
        visibility: "members",
        definition: {
          tools: [{ kind: "builtin", name: "agent" }],
          subagents: { agents: [{ agentId: "ag2", as: "analyst", description: "d" }] },
        },
      }),
      memberIds: ["a1", "a3"],
    };
    const analyst = { ...ANALYST, visibility: "members", memberIds: ["a2", "a1"] };
    stubApi({
      ...routes(lead),
      [`GET ${ORG}/agents`]: () => json(200, { agents: [lead, analyst, QUIET] }),
    });
    renderPage(<EditAgentPage />);
    const s = await section();
    const warning = S.widerWarning.replaceAll("{name}", "Data analyst");
    await vi.waitFor(() => expect(s.textContent).toContain(warning));
  });

  it("the dispatchable switch saves", async () => {
    const calls = stubApi({
      ...routes(),
      [`PATCH ${ORG}/agents/ag1`]: () => json(200, { agent: LEAD, warnings: [] }),
    });
    renderPage(<EditAgentPage />);
    const s = await section();
    const user = userEvent.setup();
    await user.click(within(s).getByRole("switch", { name: S.dispatchable }));
    await user.click(screen.getByRole("button", { name: en.agents.form.submit }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const body = bodyOf(calls.find((c) => c.method === "PATCH")) as {
      definition: Record<string, unknown>;
    };
    expect(body.definition.subagents).toEqual({ dispatchable: true });
    // turning on dispatchable alone does not offer the agent tool
    expect(body.definition.tools).toEqual([{ kind: "builtin", name: "ask_user" }]);
  });

  it("an untouched agent with a tiered inline template (jsonb key order) has no unsaved change", async () => {
    const lead = agent("ag1", "Lead", {
      definition: {
        tools: [
          { kind: "builtin", name: "ask_user" },
          { kind: "builtin", name: "agent" },
        ],
        // jsonb orders keys by length: model comes before description and instructions
        subagents: {
          inline: [{ name: "helper", model: "fast", description: "Helps.", instructions: "Help." }],
        },
      },
    });
    stubApi(routes(lead));
    renderPage(<EditAgentPage />);
    const s = await section();
    await vi.waitFor(() =>
      expect(within(s).getByRole("textbox", { name: S.inlineName })).toBeTruthy(),
    );
    const unsaved = document.querySelector('[data-part="action-row-unsaved"]');
    expect(unsaved?.textContent ?? "").toBe("");
  });

  it("settings without the agent tool are kept, with a warning that they are unused", async () => {
    const lead = agent("ag1", "Lead", { definition: { subagents: { general: false } } });
    stubApi(routes(lead));
    renderPage(<EditAgentPage />);
    const s = await section();
    expect(s.textContent).toContain(S.unused);
  });
});
