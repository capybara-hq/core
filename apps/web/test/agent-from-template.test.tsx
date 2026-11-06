import { describeNestedBox, findNestedBoxes } from "@capybara-hq/design/reference";
import { act, cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import {
  connectorNamer,
  droppedLine,
  type PlanItem,
  previewChanges,
} from "../src/lib/from-template";
import type { Me } from "../src/lib/session";
import { bodyOf, type Call, json, stubApi } from "./support/api";
import { resetNavigation, router } from "./support/navigation";
import { renderRouteWithCache } from "./support/query";
import { ME } from "./support/render";
import { pickOption } from "./support/select";
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
 * Phase 4 Task 8: the 用它创建 dialog (rulings P4-3…P4-5, P4-18): the preview groups, the model
 * preselect, the visibility only for org admins, the create landing on the agent, the stale-preview
 * retry and the refusals.
 */

const ORG = "/api/v1/orgs/o1";
const T = "2026-11-07T08:00:00.000Z";
const PATH = "/agents?tab=templates";
const F = en.agents.fromTemplate;
const A = en.agents.templates;
const HASH1 = `${"a".repeat(64)}.${"b".repeat(16)}`;
const HASH2 = `${"c".repeat(64)}.${"d".repeat(16)}`;

const MEMBER: Me = {
  ...ME,
  account: { ...ME.account, isSuperAdmin: false },
  memberships: [{ orgId: "o1", slug: "acme", name: "Acme", role: "member" }],
};

const CAPS = { tools: true, vision: false, reasoning: false, caching: false };
const MODELS = {
  providers: [
    {
      provider: "model-fake",
      models: [
        { id: "fake-1", displayName: "Fake 1", capabilities: CAPS, parameters: [] },
        { id: "fake-2", displayName: "Fake 2", capabilities: CAPS, parameters: [] },
      ],
    },
  ],
};

const PREVIEW = {
  items: [
    { kind: "description", name: "description", state: "carried" },
    { kind: "tool", name: "AskUserQuestion", state: "carried", reason: "default" },
    { kind: "skill", name: "pdf", state: "carried", reason: "pinned" },
    { kind: "connector", name: "GitHub", state: "pending", reason: "no_connector" },
    { kind: "connector", name: "Docs", state: "pending", reason: "needs" },
    { kind: "tool", name: "crm__lookup", state: "unavailable", reason: "plugin_unavailable" },
  ],
  model: { provider: "model-fake", model: "fake-2", source: "tier" },
  dropped: ["maxSteps", "connectors.connector-1.tools.delete_all"],
  previewHash: HASH1,
};

const template = (id: string, name: string) => ({
  id,
  name,
  plugin: null,
  type: name,
  description: `${name} template.`,
  model: "standard",
  version: 3,
  origin: "org",
  linkedIds: [],
  catalogItemId: null,
});

const created = (pending: boolean) => ({
  agent: {
    id: "ag9",
    orgId: "o1",
    ownerAccountId: "a1",
    visibility: "private",
    currentVersion: 1,
    profile: { avatar: null, description: "", quickActions: [], updatedAt: T },
    definition: {
      name: "Reviewer",
      instructions: "",
      model: { provider: "model-fake", model: "fake-2" },
      fallback: null,
      ...(pending
        ? {
            pendingConnectors: [
              { key: "connector-1", label: "GitHub", source: { template: "ct1" } },
            ],
          }
        : {}),
    },
    createdFrom: { templateId: "t9", version: 3, name: "reviewer", available: true },
    updatedAt: T,
  },
});

type Handler = (c: Call) => Response | Promise<Response>;
function routes(over: Record<string, Handler> = {}): Routes {
  return {
    [`GET ${ORG}/agents`]: () => json(200, { agents: [] }),
    [`GET ${ORG}/members`]: () =>
      json(200, {
        members: [
          {
            account: { id: "a2", displayName: "Bo", email: "bo@x" },
            role: "member",
            anonymous: false,
          },
        ],
      }),
    [`GET ${ORG}/agent-templates`]: () => json(200, { templates: [template("t9", "reviewer")] }),
    [`GET ${ORG}/components?kind=agent_template`]: () => json(200, { components: [] }),
    [`GET ${ORG}/agent-templates/t9`]: () =>
      json(200, {
        template: {
          ...template("t9", "reviewer"),
          definition: {},
          owner: { kind: "org", orgId: "o1", name: "Acme" },
          owned: true,
          shareable: false,
          promoted: false,
        },
      }),
    [`GET ${ORG}/models`]: () => json(200, MODELS),
    [`POST ${ORG}/agents/from-template/preview`]: () => json(200, PREVIEW),
    [`POST ${ORG}/agents/from-template`]: () => json(201, created(true)),
    ...over,
  };
}

const posts = (calls: Call[], suffix: string) =>
  calls.filter((c) => c.method === "POST" && c.url === `${ORG}/agents/${suffix}`).map(bodyOf);
const settle = () => act(() => new Promise((r) => setTimeout(r, 20)));

async function openDialog(r: Routes, me?: Me) {
  await renderRouteWithCache(PATH, r, me ? { me } : {});
  const grid = await screen.findByRole("list", { name: A.listLabel });
  const card = (await within(grid).findByRole("link", { name: "reviewer" })).closest(
    "li",
  ) as HTMLElement;
  await userEvent.setup().click(within(card).getByRole("button", { name: A.create }));
  const dialog = await screen.findByRole("dialog", { name: "Create an agent from reviewer" });
  // the preview is in once the groups show
  await within(dialog).findByText("To configure · 2");
  return dialog;
}

beforeEach(() => resetNavigation("/agents"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("用它创建 (P4-18)", () => {
  it("shows the preview groups with counts, reasons on expand and the dropped settings in words", async () => {
    const calls = stubApi(routes());
    const dialog = await openDialog(routes());
    expect(posts(calls, "from-template/preview")).toEqual([{ templateId: "t9" }]);
    // the name defaults to the template's
    expect((within(dialog).getByRole("textbox", { name: /Name/ }) as HTMLInputElement).value).toBe(
      "reviewer",
    );
    expect(within(dialog).getByText("Carried over · 3")).toBeTruthy();
    expect(within(dialog).getByText("Unavailable · 1")).toBeTruthy();
    // 待配置 and 不可用 open by themselves, with their reasons in words
    expect(within(dialog).getByText(F.reasons.connector_no_connector)).toBeTruthy();
    expect(within(dialog).getByText(F.reasons.connector_needs)).toBeTruthy();
    expect(within(dialog).getByText(F.reasons.tool_plugin_unavailable)).toBeTruthy();
    expect(within(dialog).getByText(F.pendingHint)).toBeTruthy();
    // 带入 is closed until opened
    expect(within(dialog).queryByText(F.reasons.skill_pinned)).toBeNull();
    const user = userEvent.setup();
    await user.click(within(dialog).getByRole("button", { name: /Carried over · 3/ }));
    expect(within(dialog).getByText(F.reasons.skill_pinned)).toBeTruthy();
    expect(within(dialog).getByText("pdf")).toBeTruthy();
    // the dropped settings, in plain words
    await user.click(within(dialog).getByRole("button", { name: /Settings not carried over · 2/ }));
    expect(within(dialog).getByText(F.dropped.maxSteps)).toBeTruthy();
    expect(
      within(dialog).getByText(
        "Connector GitHub's tool delete_all: the connector doesn't offer it.",
      ),
    ).toBeTruthy();
    // one box: nothing boxed inside the dialog
    expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
  });

  it("a member sees no visibility field; the create is private and lands on the agent's Tools", async () => {
    const r = routes();
    const calls = stubApi(r);
    const dialog = await openDialog(r, MEMBER);
    expect(within(dialog).queryByRole("combobox", { name: en.agents.form.visibilityLabel })).toBe(
      null,
    );
    await userEvent.setup().click(within(dialog).getByRole("button", { name: F.submit }));
    await vi.waitFor(() => expect(posts(calls, "from-template")).toHaveLength(1));
    const body = posts(calls, "from-template")[0] as Record<string, unknown>;
    expect(body).toMatchObject({ templateId: "t9", name: "reviewer", previewHash: HASH1 });
    // no visibility, no model (the preselected one is the automatic choice)
    expect(body.visibility).toBeUndefined();
    expect(body.model).toBeUndefined();
    expect((body.avatar as { kind: string }).kind).toBe("preset");
    // pending connectors: the Tools section, where the 待配置 notice is
    await vi.waitFor(() => expect(router.push).toHaveBeenCalledWith("/agents/ag9?s=tools"));
  });

  it("an org admin picks the visibility; a changed model is sent; without pending it opens the agent", async () => {
    const r = routes({ [`POST ${ORG}/agents/from-template`]: () => json(201, created(false)) });
    const calls = stubApi(r);
    const dialog = await openDialog(r);
    const model = within(dialog).getByRole("combobox", {
      name: new RegExp(en.agents.form.modelLabel),
    }) as HTMLSelectElement;
    // the preview's automatic choice is preselected, its source said
    expect(model.value).toBe("model-fake/fake-2");
    expect(within(dialog).getByText(F.modelSource.tier)).toBeTruthy();
    await pickOption(
      within(dialog).getByRole("combobox", { name: en.agents.form.visibilityLabel }),
      en.agents.form.visibility.members,
    );
    const user = userEvent.setup();
    await user.click(within(dialog).getByRole("checkbox", { name: "Bo" }));
    await pickOption(model, "model-fake/fake-1");
    await user.click(within(dialog).getByRole("button", { name: F.submit }));
    await vi.waitFor(() => expect(posts(calls, "from-template")).toHaveLength(1));
    expect(posts(calls, "from-template")[0]).toMatchObject({
      visibility: "members",
      members: ["a2"],
      model: { provider: "model-fake", model: "fake-1" },
    });
    await vi.waitFor(() => expect(router.push).toHaveBeenCalledWith("/agents/ag9"));
  });

  it("a stale preview (409) is read again, the changes are shown, the next create sends the new hash", async () => {
    let previews = 0;
    let creates = 0;
    const r = routes({
      [`POST ${ORG}/agents/from-template/preview`]: () => {
        previews += 1;
        return json(
          200,
          previews === 1
            ? PREVIEW
            : {
                ...PREVIEW,
                items: PREVIEW.items.map((i) =>
                  i.name === "GitHub" ? { ...i, state: "carried", reason: undefined } : i,
                ),
                // the step limit is no longer dropped
                dropped: ["connectors.connector-1.tools.delete_all"],
                previewHash: HASH2,
              },
        );
      },
      [`POST ${ORG}/agents/from-template`]: () => {
        creates += 1;
        return creates === 1
          ? json(409, {
              error: { code: "agent.template_preview_stale", message: "stale" },
            })
          : json(201, created(true));
      },
    });
    const calls = stubApi(r);
    const dialog = await openDialog(r);
    const user = userEvent.setup();
    await user.click(within(dialog).getByRole("button", { name: F.submit }));
    expect(await within(dialog).findByText(F.stale)).toBeTruthy();
    expect(within(dialog).getByText("Connector GitHub: to configure → carried over.")).toBeTruthy();
    expect(within(dialog).getByText("To configure · 1")).toBeTruthy();
    expect(within(dialog).getByText(`Now carried over: ${F.dropped.maxSteps}`)).toBeTruthy();
    expect(router.push).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: F.submit }));
    await vi.waitFor(() => expect(posts(calls, "from-template")).toHaveLength(2));
    expect((posts(calls, "from-template")[1] as { previewHash: string }).previewHash).toBe(HASH2);
    await vi.waitFor(() => expect(router.push).toHaveBeenCalledWith("/agents/ag9?s=tools"));
  });

  it("re-picking the automatic model sends no model", async () => {
    const r = routes();
    const calls = stubApi(r);
    const dialog = await openDialog(r);
    const model = within(dialog).getByRole("combobox", {
      name: new RegExp(en.agents.form.modelLabel),
    });
    await pickOption(model, "model-fake/fake-1");
    await pickOption(model, "model-fake/fake-2");
    await userEvent.setup().click(within(dialog).getByRole("button", { name: F.submit }));
    await vi.waitFor(() => expect(posts(calls, "from-template")).toHaveLength(1));
    expect((posts(calls, "from-template")[0] as Record<string, unknown>).model).toBeUndefined();
  });

  it("a 404 on create (the template went away meanwhile) shows the gone state", async () => {
    const r = routes({
      [`POST ${ORG}/agents/from-template`]: () =>
        json(404, { error: { code: "component.not_found", message: "nope" } }),
    });
    stubApi(r);
    const dialog = await openDialog(r);
    await userEvent.setup().click(within(dialog).getByRole("button", { name: F.submit }));
    expect(await within(dialog).findByText(F.gone)).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: F.submit })).toBeNull();
    expect(router.push).not.toHaveBeenCalled();
  });

  it("a template no longer usable (404) says so and offers no create; a 403 shows its message", async () => {
    const gone = routes({
      [`POST ${ORG}/agents/from-template/preview`]: () =>
        json(404, { error: { code: "component.not_found", message: "nope" } }),
    });
    stubApi(gone);
    await renderRouteWithCache(PATH, gone);
    const grid = await screen.findByRole("list", { name: A.listLabel });
    const card = (await within(grid).findByRole("link", { name: "reviewer" })).closest(
      "li",
    ) as HTMLElement;
    await userEvent.setup().click(within(card).getByRole("button", { name: A.create }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText(F.gone)).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: F.submit })).toBeNull();
    cleanup();

    const forbidden = routes({
      [`POST ${ORG}/agents/from-template`]: () =>
        json(403, { error: { code: "agent.visibility_forbidden", message: "no" } }),
    });
    stubApi(forbidden);
    const d2 = await openDialog(forbidden);
    await userEvent.setup().click(within(d2).getByRole("button", { name: F.submit }));
    expect(await within(d2).findByText(en.errors.agent.visibility_forbidden)).toBeTruthy();
    await settle();
    expect(router.push).not.toHaveBeenCalled();
  });
});

describe("from-template helpers", () => {
  it("words dropped paths and diffs previews", () => {
    expect(droppedLine("quickActions.1.body")).toEqual({
      key: "quickAction_body",
      values: { n: "2" },
    });
    expect(droppedLine("subagents.inline.scout.tools.Bash")).toEqual({
      key: "subagentTool",
      values: { name: "scout", tool: "Bash" },
    });
    expect(droppedLine("weird.path")).toEqual({ key: "other", values: { path: "weird.path" } });
    // a connector is named by the n-th connector item, never by its kernel key
    const named = connectorNamer(PREVIEW.items as PlanItem[]);
    expect(droppedLine("connectors.connector-2.policies.write", named)).toEqual({
      key: "connectorPolicy",
      values: { connector: "Docs", tool: "write" },
    });
    expect(named("connector-9")).toBe("connector-9");
    // two items with one name stay two (one moves, the other stays)
    const twice = (second: "carried" | "pending") => ({
      items: [
        { kind: "connector" as const, name: "GitHub", state: "pending" as const },
        { kind: "connector" as const, name: "GitHub", state: second },
      ],
      model: null,
      dropped: [],
      previewHash: HASH1,
    });
    expect(previewChanges(twice("pending"), twice("carried"))).toMatchObject({
      added: [],
      removed: [],
      moved: [{ item: { state: "carried" }, from: "pending" }],
    });
    const before = { items: [], model: null, dropped: [], previewHash: HASH1 };
    const after = {
      items: [{ kind: "skill" as const, name: "pdf", state: "carried" as const }],
      model: null,
      dropped: ["maxSteps"],
      previewHash: HASH2,
    };
    expect(previewChanges(before, after)).toMatchObject({
      added: [{ name: "pdf" }],
      droppedAdded: ["maxSteps"],
      modelChanged: false,
    });
  });
});
