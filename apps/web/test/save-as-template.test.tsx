import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import type { Me } from "../src/lib/session";
import { agentFormDefaults, renderEditAgent } from "./support/agents";
import { bodyOf, json, stubApi } from "./support/api";
import { resetNavigation, router } from "./support/navigation";
import { renderRouteWithCache } from "./support/query";
import { ME } from "./support/render";
import type { Routes } from "./support/server";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

/**
 * Phase 4 Task 9: 另存为模板 (ruling P4-9, org admins) from the agent page's ⋯ and the agent
 * card's: the name in the bare-name form, the description, what is left out (the roster's org
 * agents before, the kernel's `omitted` after), a taken or reserved name on the field, then the
 * new template's page.
 */

const ORG = "/api/v1/orgs/o1";
const T = "2026-11-07T08:00:00.000Z";
const S = en.agents.saveAs;

const MEMBER: Me = {
  ...ME,
  account: { ...ME.account, isSuperAdmin: false },
  memberships: [{ orgId: "o1", slug: "acme", name: "Acme", role: "member" }],
};

const agent = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  id,
  orgId: "o1",
  ownerAccountId: "a1",
  visibility: "org",
  currentVersion: 2,
  memberIds: null,
  needsReassignment: false,
  createdAt: T,
  updatedAt: T,
  profile: { avatar: null, description: "Helps with sales.", quickActions: [], updatedAt: T },
  definition: {
    name,
    instructions: "Help.",
    model: { provider: "model-fake", model: "fake-1" },
    fallback: null,
    tools: [],
  },
  ...over,
});

const HELPER = agent("ag1", "Sales Helper", {
  definition: {
    name: "Sales Helper",
    instructions: "Help.",
    model: { provider: "model-fake", model: "fake-1" },
    fallback: null,
    tools: [],
    subagents: { agents: [{ agentId: "ag2", as: "researcher", description: "Finds things." }] },
  },
});

const TEMPLATE = {
  id: "t9",
  name: "sales-helper",
  plugin: null,
  type: "sales-helper",
  description: "Helps with sales.",
  model: "standard",
  version: 1,
  origin: "org",
  definition: { name: "sales-helper", description: "Helps with sales.", instructions: "Help." },
  owner: { kind: "org", orgId: "o1", name: "Acme" },
  owned: true,
  shareable: false,
  promoted: false,
};

const routes = (over: Routes = {}): Routes => ({
  ...agentFormDefaults("ag1"),
  [`GET ${ORG}/agents/ag1`]: () => json(200, { agent: HELPER }),
  [`GET ${ORG}/agents`]: () => json(200, { agents: [HELPER, agent("ag2", "Research Desk")] }),
  [`GET ${ORG}/models`]: () =>
    json(200, {
      providers: [
        {
          provider: "model-fake",
          models: [
            {
              id: "fake-1",
              displayName: "Fake 1",
              capabilities: { reasoning: false },
              parameters: [],
            },
          ],
        },
      ],
    }),
  ...over,
});

/** Opens 另存为模板 from the agent page's ⋯. */
async function openFromAgentPage(r: Routes) {
  stubApi(r);
  await renderEditAgent({ routes: r });
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: en.common.moreActions }));
  await user.click(await screen.findByRole("menuitem", { name: S.action }));
  return {
    user,
    dialog: await screen.findByRole("dialog", { name: S.title.replace("{name}", "Sales Helper") }),
  };
}

beforeEach(() => resetNavigation("/agents/ag1"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("另存为模板 (ruling P4-9)", () => {
  it("defaults the name to the bare-name form and the description, and says the roster's org agents stay out", async () => {
    const { dialog } = await openFromAgentPage(routes());
    expect(within(dialog).getByRole("textbox", { name: new RegExp(`^${S.name}`) })).toHaveProperty(
      "value",
      "sales-helper",
    );
    expect(
      within(dialog).getByRole("textbox", { name: new RegExp(`^${S.description}`) }),
    ).toHaveProperty("value", "Helps with sales.");
    // 将带入 and the agents left out are titled regions, each said once
    expect(
      within(dialog)
        .getAllByRole("heading", { level: 3 })
        .map((h) => h.textContent),
    ).toEqual([S.carriedTitle, S.rosterLabel]);
    expect(within(dialog).getByText(S.carried)).toBeTruthy();
    expect(within(dialog).getByText(S.rosterLeftOut)).toBeTruthy();
    const roster = within(dialog).getByRole("list", { name: S.rosterLabel });
    expect(await within(roster).findByText("Research Desk")).toBeTruthy();
  });

  it("saves and goes to the new template's page when nothing was left out", async () => {
    const r = routes({
      [`POST ${ORG}/agents/ag1/save-as-template`]: () =>
        json(201, { template: TEMPLATE, omitted: [] }),
    });
    const { user, dialog } = await openFromAgentPage(r);
    const calls = stubApi(r);
    await user.click(within(dialog).getByRole("button", { name: S.submit }));
    await vi.waitFor(() => expect(router.push).toHaveBeenCalledWith("/agents/templates/t9"));
    expect(bodyOf(calls.find((c) => c.method === "POST"))).toEqual({
      name: "sales-helper",
      description: "Helps with sales.",
    });
  });

  it("lists what the kernel left out in plain words, then 打开模板", async () => {
    const r = routes({
      [`POST ${ORG}/agents/ag1/save-as-template`]: () =>
        json(201, {
          template: TEMPLATE,
          omitted: [
            { kind: "subagent_agent", name: "researcher", id: "ag2", reason: "org_agent" },
            { kind: "connector", name: "Inline API", reason: "no_endpoint" },
            {
              kind: "subagent_inline",
              name: "checker",
              field: "effort",
              reason: "unsupported_field",
            },
            { kind: "model_param", name: "model-fake.style", reason: "model_param" },
            { kind: "fallback_model", name: "model-fake/fake-1", reason: "fallback" },
            {
              kind: "subagent_inline",
              name: "blank",
              field: "description",
              reason: "empty_text",
            },
            { kind: "quick_action", name: "Weekly", reason: "empty_text" },
          ],
        }),
    });
    const { user, dialog } = await openFromAgentPage(r);
    await user.click(within(dialog).getByRole("button", { name: S.submit }));
    const saved = await screen.findByRole("dialog", {
      name: S.savedTitle.replace("{name}", "sales-helper"),
    });
    expect(
      within(saved).getByText("Sub-agent researcher: it is an organization agent, not a template"),
    ).toBeTruthy();
    expect(
      within(saved).getByText("Connector Inline API: it has no address to record"),
    ).toBeTruthy();
    expect(
      within(saved).getByText(
        "Inline sub-agent checker: templates have no place for its reasoning effort setting",
      ),
    ).toBeTruthy();
    for (const line of [
      "Model parameter model-fake.style: templates record only the reasoning effort, no other model parameter",
      "Fallback model model-fake/fake-1: templates record no fallback model or its parameters",
      "Inline sub-agent blank: its description is blank, which a template cannot hold",
      "Quick action Weekly: it is blank, which a template cannot hold",
    ]) {
      expect(within(saved).getByText(line)).toBeTruthy();
    }
    expect(within(saved).getByRole("link", { name: S.open }).getAttribute("href")).toBe(
      "/agents/templates/t9",
    );
    expect(router.push).not.toHaveBeenCalled();
  });

  it("a name taken by another org's shared template names that org, on the field", async () => {
    const r = routes({
      [`POST ${ORG}/agents/ag1/save-as-template`]: () =>
        json(409, {
          error: {
            code: "agent_template.name_taken",
            message: "taken",
            details: [{ owner: { kind: "org", orgId: "o2", name: "Beta" }, templateId: "x" }],
          },
        }),
    });
    const { user, dialog } = await openFromAgentPage(r);
    await user.click(within(dialog).getByRole("button", { name: S.submit }));
    expect(await within(dialog).findByText(S.taken.org.replace("{org}", "Beta"))).toBeTruthy();
    // a new name clears it
    await user.type(within(dialog).getByRole("textbox", { name: new RegExp(`^${S.name}`) }), "-2");
    expect(within(dialog).queryByText(S.taken.org.replace("{org}", "Beta"))).toBeNull();
  });

  it("a reserved name says so", async () => {
    const r = routes({
      [`POST ${ORG}/agents/ag1/save-as-template`]: () =>
        json(409, {
          error: {
            code: "agent_template.name_taken",
            message: "reserved",
            details: [{ reserved: true }],
          },
        }),
    });
    const { user, dialog } = await openFromAgentPage(r);
    const name = within(dialog).getByRole("textbox", { name: new RegExp(`^${S.name}`) });
    await user.clear(name);
    await user.type(name, "general-purpose");
    await user.click(within(dialog).getByRole("button", { name: S.submit }));
    expect(
      await within(dialog).findByText(S.taken.reserved.replace("{name}", "general-purpose")),
    ).toBeTruthy();
  });

  it("a name outside the bare-name rule says so as it is typed, and nothing is sent", async () => {
    const r = routes();
    const { user, dialog } = await openFromAgentPage(r);
    const calls = stubApi(r);
    const name = within(dialog).getByRole("textbox", { name: new RegExp(`^${S.name}`) });
    await user.clear(name);
    // empty: no error until a save is tried
    expect(within(dialog).queryByText(S.nameInvalid)).toBeNull();
    await user.type(name, "Sales Helper");
    expect(within(dialog).getByText(S.nameInvalid)).toBeTruthy();
    // no dead button: pressing it explains and sends nothing
    const submit = within(dialog).getByRole("button", { name: S.submit });
    expect(submit).toHaveProperty("disabled", false);
    await user.click(submit);
    await user.clear(name);
    await user.click(submit);
    expect(within(dialog).getByText(S.nameRequired)).toBeTruthy();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("an agent name with nothing usable (all CJK) leaves the name empty, with the rule and an example", async () => {
    const zhAgent = { ...HELPER, definition: { ...HELPER.definition, name: "销售助手" } };
    const r = routes({ [`GET ${ORG}/agents/ag1`]: () => json(200, { agent: zhAgent }) });
    stubApi(r);
    await renderEditAgent({ routes: r });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: en.common.moreActions }));
    await user.click(await screen.findByRole("menuitem", { name: S.action }));
    const dialog = await screen.findByRole("dialog");
    const name = within(dialog).getByRole("textbox", { name: new RegExp(`^${S.name}`) });
    expect(name).toHaveProperty("value", "");
    expect(name.getAttribute("placeholder")).toBe(S.namePlaceholder);
    expect(within(dialog).getByText(S.nameHelpEmpty)).toBeTruthy();
  });
});

describe("the agent card's ⋯ (ruling P4-16)", () => {
  const listRoutes = (): Routes => ({
    [`GET ${ORG}/agents`]: () => json(200, { agents: [HELPER] }),
    [`GET ${ORG}/members`]: () => json(200, { members: [] }),
    [`GET ${ORG}/agent-templates`]: () => json(200, { templates: [] }),
    [`GET ${ORG}/components?kind=agent_template`]: () => json(200, { components: [] }),
  });
  const menuOf = async () => {
    const card = (await screen.findByRole("link", { name: "Sales Helper" })).closest(
      "li",
    ) as HTMLElement;
    await userEvent.setup().click(within(card).getByRole("button", { name: "More actions" }));
    return (await screen.findAllByRole("menuitem")).map((i) => i.textContent);
  };

  it("org admins get 另存为模板, which opens the dialog", async () => {
    resetNavigation("/agents");
    stubApi(listRoutes());
    await renderRouteWithCache("/agents", listRoutes());
    expect(await menuOf()).toEqual([en.agents.settings, en.agents.runHistory, S.action]);
    await userEvent.setup().click(screen.getByRole("menuitem", { name: S.action }));
    expect(
      await screen.findByRole("dialog", { name: S.title.replace("{name}", "Sales Helper") }),
    ).toBeTruthy();
  });

  it("members never see it", async () => {
    resetNavigation("/agents");
    const mine = { ...HELPER, ownerAccountId: "a1" };
    const r = { ...listRoutes(), [`GET ${ORG}/agents`]: () => json(200, { agents: [mine] }) };
    stubApi(r);
    await renderRouteWithCache("/agents", r, { me: MEMBER });
    expect(await menuOf()).not.toContain(S.action);
  });
});
