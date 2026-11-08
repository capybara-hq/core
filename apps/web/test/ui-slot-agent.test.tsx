import { describeNestedBox, findNestedBoxes } from "@capybara-hq/design/reference";
import { act, cleanup, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import { AGENT_SECTIONS } from "../src/components/agent/sections";
import type { Me } from "../src/lib/session";
import type { UiContributionItem } from "../src/lib/ui";
import { agentFormDefaults, renderEditAgent } from "./support/agents";
import { json, stubApi } from "./support/api";
import { resetNavigation } from "./support/navigation";
import { ME } from "./support/render";
import { sessionRoutes } from "./support/server";

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
const P_ = en.agents.page;

const NOTES: UiContributionItem = {
  plugin: "fake-tools-ui",
  id: "agent-notes",
  title: { zh: "智能体备注", en: "Agent notes" },
  slot: "agent.detail.section",
  kind: "view",
  icon: "puzzle",
};
const OTHER_SLOT: UiContributionItem = { ...NOTES, id: "tasks", slot: "conversation.panel" };

const agent = (owner: string) => ({
  id: "ag1",
  orgId: "o1",
  ownerAccountId: owner,
  visibility: "org",
  currentVersion: 1,
  memberIds: null,
  needsReassignment: false,
  createdAt: T,
  updatedAt: T,
  profile: { avatar: null, description: "", quickActions: [], updatedAt: T },
  definition: {
    name: "Helper",
    instructions: "Be helpful.",
    model: { provider: "model-fake", model: "fake-1" },
    fallback: null,
    modelParams: {},
    fallbackParams: {},
    tools: [],
    toolPolicies: {},
  },
});

const MODELS = { providers: [] };

function routes(owner: string) {
  return {
    ...sessionRoutes(),
    ...agentFormDefaults(),
    [`GET ${ORG}/agents/ag1`]: () => json(200, { agent: agent(owner) }),
    [`GET ${ORG}/models`]: () => json(200, MODELS),
    [`GET ${ORG}/ui/contributions`]: () => json(200, { items: [NOTES, OTHER_SLOT] }),
    [`GET ${ORG}/ui/views/fake-tools-ui/agent-notes`]: () =>
      json(200, { view: { blocks: [{ type: "heading", text: "Agent ag1" }] } }),
  };
}

const MEMBER: Me = {
  ...ME,
  account: { ...ME.account, isSuperAdmin: false },
  memberships: [{ orgId: "o1", slug: "acme", name: "Acme", role: "member" }],
};
const nav = () => document.querySelector('[data-part="settings-nav"]') as HTMLElement;
const labels = () =>
  within(nav())
    .getAllByRole("link")
    .map((l) => l.textContent);

beforeEach(() => resetNavigation("/agents/ag1"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("agent.detail.section", () => {
  it("extension sections follow the built-in nav items", async () => {
    stubApi(routes("a1"));
    await renderEditAgent();
    expect(labels()).toEqual([...AGENT_SECTIONS.map((s) => P_.sections[s]), "Agent notes"]);
    const link = within(nav()).getByRole("link", { name: "Agent notes" });
    expect(link.getAttribute("href")).toBe("/agents/ag1?s=ext.fake-tools-ui.agent-notes");
  });

  it("a read-only viewer sees them too", async () => {
    stubApi(routes("someone"));
    await renderEditAgent({
      routes: {
        [`GET ${ORG}/agents/ag1`]: () => json(200, { agent: agent("someone") }),
        [`GET ${ORG}/ui/contributions`]: () => json(200, { items: [NOTES] }),
      },
      me: MEMBER,
    });
    expect(labels()).toEqual([
      P_.sections.basics,
      P_.sections["quick-actions"],
      P_.sections.model,
      "Agent notes",
    ]);
  });

  it("?s=ext.fake-tools-ui.agent-notes opens the extension section", async () => {
    stubApi(routes("a1"));
    await renderEditAgent({ section: "ext.fake-tools-ui.agent-notes" });
    expect(await screen.findByRole("heading", { name: "Agent ag1" })).toBeTruthy();
    expect(nav().querySelector('[aria-current="page"]')?.textContent).toBe("Agent notes");
    // no save bar
    expect(screen.queryByRole("button", { name: /save/i })).toBeNull();
    await act(async () => {});
    expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
  });

  it("an unknown ext section opens basics", async () => {
    stubApi(routes("a1"));
    await renderEditAgent({ section: "ext.fake-tools-ui.nope" });
    expect(nav().querySelector('[aria-current="page"]')?.textContent).toBe(P_.sections.basics);
    expect(screen.queryByRole("heading", { name: "Agent ag1" })).toBeNull();
  });
});
