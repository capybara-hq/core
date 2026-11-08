import { act, cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import type { Me } from "../src/lib/session";
import { bodyOf, json, stubApi } from "./support/api";
import { resetNavigation, router } from "./support/navigation";
import { renderRouteEmptyCache, renderRouteWithCache } from "./support/query";
import { ME } from "./support/render";
import { pickOption } from "./support/select";
import { expectNoFirstPaintFetch, type Routes } from "./support/server";

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
 * Phase 4 Task 9: the template page `/agents/templates/<id>` (rulings P4-12 to P4-14): the read
 * view for members, the editor for owner-org admins (each save a new version, the stale version
 * refused), ⋯ 可共享 / 删除, and the designed state of a platform template that is offered to the
 * org but switched off there.
 */

const ORG = "/api/v1/orgs/o1";
const P = en.agents.templatePage;
const A = en.agents.templates;
const C = en.orgComponents;

const MEMBER: Me = {
  ...ME,
  account: { ...ME.account, isSuperAdmin: false },
  memberships: [{ orgId: "o1", slug: "acme", name: "Acme", role: "member" }],
};
const GUEST: Me = {
  ...MEMBER,
  memberships: [{ orgId: "o1", slug: "acme", name: "Acme", role: "guest" }],
};

const DEFINITION = {
  name: "sales",
  description: "Drafts sales replies.",
  instructions: "You draft replies.",
  model: "standard",
  modelRef: "openai/gpt-x",
  tools: ["AskUserQuestion"],
  toolPolicies: { AskUserQuestion: "ask" },
  skills: ["pricing"],
  selectedSkills: ["tone"],
  connectors: [
    { template: "ct-wiki" },
    {
      needs: {
        protocol: "mcp",
        endpoint: "https://crm.example.com/mcp",
        tools: ["search", "update"],
        label: "CRM",
      },
    },
  ],
  subagents: { general: true, types: ["docs:reviewer"] },
  quickActions: [{ title: "Weekly", body: "Write the weekly summary." }],
};

const detail = (over: Record<string, unknown> = {}) => ({
  template: {
    id: "t9",
    name: "sales",
    plugin: null,
    type: "sales",
    description: "Drafts sales replies.",
    model: "standard",
    version: 3,
    origin: "org",
    linkedIds: [],
    catalogItemId: null,
    definition: DEFINITION,
    owner: { kind: "org", orgId: "o1", name: "Acme" },
    owned: true,
    shareable: false,
    promoted: false,
    ...over,
  },
});

const routes = (over: Routes = {}): Routes => ({
  [`GET ${ORG}/agent-templates/t9`]: () => json(200, detail()),
  [`GET ${ORG}/components`]: () =>
    json(200, {
      components: [
        {
          kind: "connector_template",
          id: "ct-wiki",
          name: "Wiki",
          description: null,
          plugin: "wiki",
          itemId: null,
          version: "1",
          scopeMode: "follow",
          switch: null,
          on: true,
          locked: false,
          pluginOn: true,
          switchable: true,
        },
      ],
    }),
  // the editor's reads (owner-org admins)
  [`GET ${ORG}/models`]: () =>
    json(200, {
      providers: [
        {
          provider: "openai",
          models: [
            {
              id: "gpt-x",
              displayName: "GPT X",
              capabilities: { reasoning: false },
              parameters: [],
            },
          ],
        },
      ],
    }),
  [`GET ${ORG}/skills`]: () => json(200, { skills: [] }),
  [`GET ${ORG}/tools/extensions`]: () => json(200, { extensions: [] }),
  [`GET ${ORG}/extension-points/available`]: () => json(200, { points: [] }),
  [`GET ${ORG}/agent-templates`]: () => json(200, { templates: [] }),
  ...over,
});

const settle = () => act(() => new Promise((r) => setTimeout(r, 20)));

beforeEach(() => resetNavigation("/agents/templates/t9"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("/agents/templates/[id]: read view and editor (rulings P4-12, P4-14)", () => {
  it("members read every section: the head, 用它创建, no owner menu; a first render makes no browser read", async () => {
    const browser = expectNoFirstPaintFetch();
    const { container, calls } = await renderRouteWithCache("/agents/templates/t9", routes(), {
      me: MEMBER,
    });
    expect(container.querySelector('[data-template="SettingsPage"]')).not.toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "sales" })).toBeTruthy();
    expect(screen.getByText("This org · v3")).toBeTruthy();
    expect(screen.getByRole("button", { name: A.create })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "More actions" })).toBeNull();
    // the path goes back to the 模板 tab
    expect(screen.getByRole("link", { name: "templates" }).getAttribute("href")).toBe(
      "/agents?tab=templates",
    );
    // read-only: no form field
    expect(screen.queryByRole("textbox")).toBeNull();
    // the head's description, as on the agent page; 基本信息 does not repeat it
    expect(document.querySelector('[data-part="settings-description"]')?.textContent).toBe(
      "Drafts sales replies.",
    );
    expect(screen.getAllByText("Drafts sales replies.")).toHaveLength(1);
    // every section in the nav, members included
    for (const s of Object.values(P.sections))
      expect(screen.getByRole("link", { name: s })).toBeTruthy();
    // members never get the editor's reads
    expect(calls.some((c) => c.url.endsWith("/skills"))).toBe(false);
    await settle();
    expect(browser).toEqual([]);
  });

  it("用它创建 opens the create dialog, which previews the template", async () => {
    const r = routes({
      [`POST ${ORG}/agents/from-template/preview`]: () =>
        json(409, { error: { code: "component.not_found", message: "gone" } }),
    });
    const calls = stubApi(r);
    await renderRouteWithCache("/agents/templates/t9", r, { me: MEMBER });
    await userEvent.setup().click(screen.getByRole("button", { name: A.create }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
    await vi.waitFor(() =>
      expect(bodyOf(calls.find((c) => c.url.endsWith("/from-template/preview")))).toEqual({
        templateId: "t9",
      }),
    );
  });

  it("the connectors read view shows a template entry by name and a needs entry with its endpoint and tools", async () => {
    stubApi(routes());
    await renderRouteWithCache("/agents/templates/t9?s=connectors", routes(), { me: MEMBER });
    expect(await screen.findByText("Wiki")).toBeTruthy();
    expect(screen.getByText(P.connectors.templateKind)).toBeTruthy();
    expect(screen.getByText("CRM")).toBeTruthy();
    expect(screen.getByText("https://crm.example.com/mcp")).toBeTruthy();
    expect(screen.getByText("search, update")).toBeTruthy();
  });

  it("an owner-org admin gets the editor; a save writes a new version with expectedVersion", async () => {
    const r = routes({
      [`PUT ${ORG}/agent-templates/t9`]: () => json(200, detail({ version: 4 })),
    });
    const calls = stubApi(r);
    await renderRouteWithCache("/agents/templates/t9", r);
    const user = userEvent.setup();
    const box = await screen.findByRole("textbox", { name: P.basics.description });
    await user.clear(box);
    await user.type(box, "Drafts better replies.");
    await user.click(screen.getByRole("button", { name: en.agents.form.submit }));
    await vi.waitFor(() =>
      expect(calls.some((c) => c.method === "PUT" && c.url.endsWith("/agent-templates/t9"))).toBe(
        true,
      ),
    );
    const put = bodyOf(calls.find((c) => c.method === "PUT")) as {
      definition: Record<string, unknown>;
      expectedVersion: number;
    };
    expect(put.expectedVersion).toBe(3);
    // the whole definition, the name kept, only the description changed
    expect(put.definition).toEqual({ ...DEFINITION, description: "Drafts better replies." });
    // the detail is read again after the save
    await vi.waitFor(() =>
      expect(
        calls.filter((c) => c.method === "GET" && c.url.endsWith("/agent-templates/t9")).length,
      ).toBeGreaterThan(0),
    );
  });

  it("a save over someone else's newer version is refused with a reload, never an overwrite", async () => {
    const r = routes({
      [`PUT ${ORG}/agent-templates/t9`]: () =>
        json(409, { error: { code: "agent_template.version_conflict", message: "changed" } }),
    });
    stubApi(r);
    await renderRouteWithCache("/agents/templates/t9?s=model", r);
    const user = userEvent.setup();
    await pickOption(await screen.findByRole("combobox", { name: P.model.tier }), "capable", user);
    await user.click(screen.getByRole("button", { name: en.agents.form.submit }));
    expect(await screen.findByText(en.errors.agent_template.version_conflict)).toBeTruthy();
    expect(screen.getByRole("button", { name: en.agents.page.reload })).toBeTruthy();
  });

  it("the model section writes the tier, the optional model and the effort (removed when cleared)", async () => {
    const r = routes({
      [`PUT ${ORG}/agent-templates/t9`]: () => json(200, detail({ version: 4 })),
    });
    const calls = stubApi(r);
    await renderRouteWithCache("/agents/templates/t9?s=model", r);
    const user = userEvent.setup();
    await pickOption(
      await screen.findByRole("combobox", { name: new RegExp(`^${P.model.modelRef}`) }),
      P.model.noModelRef,
      user,
    );
    await pickOption(
      screen.getByRole("combobox", { name: new RegExp(`^${P.model.effort}`) }),
      "high",
      user,
    );
    await user.click(screen.getByRole("button", { name: en.agents.form.submit }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    const { definition } = bodyOf(calls.find((c) => c.method === "PUT")) as {
      definition: Record<string, unknown>;
    };
    expect(definition.modelRef).toBeUndefined();
    expect(definition.effort).toBe("high");
    expect(definition.model).toBe("standard");
  });

  it("a needs endpoint with credentials is refused with the clean form, before any request", async () => {
    const r = routes({
      [`PUT ${ORG}/agent-templates/t9`]: () => json(200, detail({ version: 4 })),
    });
    const calls = stubApi(r);
    await renderRouteWithCache("/agents/templates/t9?s=connectors", r);
    const user = userEvent.setup();
    const endpoint = await screen.findByRole("textbox", { name: P.connectors.endpoint });
    await user.clear(endpoint);
    await user.type(endpoint, "https://u:p@crm.example.com/mcp?token=1");
    await user.click(screen.getByRole("button", { name: en.agents.form.submit }));
    expect(
      await screen.findByText(
        "The address must not carry a user name or password, a query; they may hold credentials. Use: https://crm.example.com/mcp",
      ),
    ).toBeTruthy();
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("the kernel's refusal of an endpoint lands on its field", async () => {
    const r = routes({
      [`PUT ${ORG}/agent-templates/t9`]: () =>
        json(400, {
          error: {
            code: "validation_failed",
            message: "bad endpoint",
            details: [
              { path: "definition.connectors.1.needs.endpoint", message: "must be an http(s) URL" },
            ],
          },
        }),
    });
    stubApi(r);
    await renderRouteWithCache("/agents/templates/t9?s=connectors", r);
    const user = userEvent.setup();
    const label = await screen.findByRole("textbox", { name: P.connectors.label });
    await user.type(label, " 2");
    await user.click(screen.getByRole("button", { name: en.agents.form.submit }));
    expect(await screen.findByText(P.connectors.endpointRefused)).toBeTruthy();
  });

  it("可共享 is a ⋯ toggle for owner-org admins", async () => {
    const r = routes({
      [`PUT ${ORG}/agent-templates/t9/shareable`]: () => json(200, { id: "t9", shareable: true }),
    });
    const calls = stubApi(r);
    await renderRouteWithCache("/agents/templates/t9", r);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "More actions" }));
    expect((await screen.findAllByRole("menuitem")).map((i) => i.textContent)).toEqual([
      A.share,
      A.delete,
    ]);
    await user.click(screen.getByRole("menuitem", { name: A.share }));
    await vi.waitFor(() =>
      expect(bodyOf(calls.find((c) => c.method === "PUT" && c.url.endsWith("/shareable")))).toEqual(
        {
          shareable: true,
        },
      ),
    );
  });

  it("删除: the preview first (the transfer to the platform said), the name typed, then back to the 模板 tab", async () => {
    const r = routes({
      [`GET ${ORG}/agent-templates/t9/delete-preview`]: () =>
        json(200, { outcome: "transferred", orgs: [{ id: "o2", name: "Beta" }], agents: [] }),
      [`DELETE ${ORG}/agent-templates/t9`]: () => json(200, { outcome: "transferred" }),
    });
    const calls = stubApi(r);
    await renderRouteWithCache("/agents/templates/t9", r);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "More actions" }));
    await user.click(await screen.findByRole("menuitem", { name: A.delete }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText(/Beta/)).toBeTruthy();
    const confirm = within(dialog).getByRole("button", { name: A.delete });
    expect(confirm).toHaveProperty("disabled", true);
    await user.type(within(dialog).getByRole("textbox"), "sales");
    await user.click(confirm);
    await vi.waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
    await vi.waitFor(() => expect(router.push).toHaveBeenCalledWith("/agents?tab=templates"));
  });

  it("an org admin of another org's shared template reads it: no editor, no owner menu", async () => {
    const r = routes({
      [`GET ${ORG}/agent-templates/t9`]: () =>
        json(200, detail({ owned: false, owner: { kind: "org", orgId: "o2", name: "Beta" } })),
    });
    stubApi(r);
    await renderRouteWithCache("/agents/templates/t9", r);
    expect(await screen.findByText("Beta · v3")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "More actions" })).toBeNull();
  });

  it("guests get no access and nothing is read", async () => {
    const calls = stubApi(routes());
    await renderRouteWithCache("/agents/templates/t9", routes(), { me: GUEST });
    await settle();
    expect(screen.queryByRole("heading", { name: "sales" })).toBeNull();
    expect(calls.some((c) => c.url.includes("/agent-templates"))).toBe(false);
  });

  it("an empty cache shows the template's loading state, then the template", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    const r = routes({
      [`GET ${ORG}/agent-templates/t9`]: async () => {
        await held;
        return json(200, detail());
      },
    });
    const { container } = await renderRouteEmptyCache("/agents/templates/t9", r, { me: MEMBER });
    await vi.waitFor(() => expect(container.querySelector('[aria-busy="true"]')).not.toBeNull());
    await act(async () => release());
    expect(await screen.findByRole("heading", { level: 1, name: "sales" })).toBeTruthy();
  });
});

describe("/agents/templates/[id]: a platform template offered but off in the org", () => {
  const offRoutes = (over: Routes = {}): Routes =>
    routes({
      [`GET ${ORG}/agent-templates/t2`]: () =>
        json(404, { error: { code: "component.not_found", message: "not found" } }),
      [`GET ${ORG}/components`]: () =>
        json(200, {
          components: [
            {
              kind: "agent_template",
              id: "t2",
              name: "writer",
              description: "Writes.",
              plugin: "docs",
              itemId: null,
              version: "2",
              scopeMode: "own",
              switch: false,
              on: false,
              locked: false,
              pluginOn: true,
              switchable: true,
              owner: { kind: "platform" },
            },
          ],
        }),
      ...over,
    });

  it("an org admin sees 未在本组织启用 with 启用, which switches it on", async () => {
    const r = offRoutes({
      [`PUT ${ORG}/components/agent_template/t2/switch`]: () =>
        json(200, { component: { id: "t2", on: true } }),
    });
    const calls = stubApi(r);
    resetNavigation("/agents/templates/t2");
    await renderRouteWithCache("/agents/templates/t2", r);
    expect(await screen.findByText(P.off.title)).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "writer" })).toBeTruthy();
    expect(screen.getByText("Plugin · docs · v2")).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: C.action.enable }));
    await vi.waitFor(() =>
      expect(bodyOf(calls.find((c) => c.method === "PUT" && c.url.endsWith("/switch")))).toEqual({
        enabled: true,
      }),
    );
  });

  it("a member reads the state and whom to ask, without a switch", async () => {
    stubApi(offRoutes());
    resetNavigation("/agents/templates/t2");
    await renderRouteWithCache("/agents/templates/t2", offRoutes(), { me: MEMBER });
    expect(await screen.findByText(P.off.title)).toBeTruthy();
    expect(screen.getByText(P.off.hintMember)).toBeTruthy();
    expect(screen.queryByRole("button", { name: C.action.enable })).toBeNull();
  });

  it("an id that is neither served nor offered is the not-found state", async () => {
    const r = offRoutes({ [`GET ${ORG}/components`]: () => json(200, { components: [] }) });
    stubApi(r);
    resetNavigation("/agents/templates/t2");
    await renderRouteWithCache("/agents/templates/t2", r);
    await settle();
    expect(screen.queryByText(P.off.title)).toBeNull();
    expect(screen.queryByRole("heading", { level: 1, name: "writer" })).toBeNull();
    // the segment's not-found page
    expect(screen.getAllByText(en.notFound.title).length).toBeGreaterThan(0);
    expect(screen.getByText(en.notFound.description)).toBeTruthy();
  });

  it("the owner's own promoted template switched off in its org: the editor with the notice and 启用", async () => {
    const r = routes({
      [`GET ${ORG}/agent-templates/t9`]: () =>
        json(200, detail({ promoted: true, shareable: true, usable: false })),
      [`GET ${ORG}/components`]: () =>
        json(200, {
          components: [
            {
              kind: "agent_template",
              id: "p9",
              name: "sales",
              description: "Drafts sales replies.",
              plugin: null,
              itemId: null,
              version: "3",
              scopeMode: "own",
              switch: false,
              on: false,
              locked: false,
              pluginOn: true,
              switchable: true,
              // the org row is not among its linked ids: found by name and owner for the switch
              owner: { kind: "org", orgId: "o1", name: "Acme" },
            },
          ],
        }),
    });
    stubApi(r);
    await renderRouteWithCache("/agents/templates/t9", r);
    expect(await screen.findByText(P.off.ownerAdmin)).toBeTruthy();
    expect(screen.getByRole("button", { name: C.action.enable })).toBeTruthy();
    // not usable here: no 用它创建
    expect(screen.queryByRole("button", { name: A.create })).toBeNull();
    expect(screen.getByRole("textbox", { name: P.basics.description })).toBeTruthy();
  });

  it("not usable here by the kernel's word, the platform row not offered: the notice, no 启用, no 用它创建", async () => {
    const r = routes({
      [`GET ${ORG}/agent-templates/t9`]: () => json(200, detail({ promoted: true, usable: false })),
      [`GET ${ORG}/components`]: () => json(200, { components: [] }),
    });
    stubApi(r);
    await renderRouteWithCache("/agents/templates/t9", r, {
      me: { ...ME, memberships: [{ orgId: "o1", slug: "acme", name: "Acme", role: "admin" }] },
    });
    expect(await screen.findByText(P.off.ownerAdmin)).toBeTruthy();
    expect(screen.queryByRole("button", { name: C.action.enable })).toBeNull();
    expect(screen.queryByRole("button", { name: A.create })).toBeNull();
  });
});

describe("/agents/templates/[id]: the editor's sections save their part (ruling P4-12)", () => {
  const TF = en.agents.form;
  const SA = en.agents.form.subagents;
  type Put = { definition: Record<string, unknown>; expectedVersion: number };
  /** Routes whose GET serves `current`, which a PUT replaces (`answer` shapes the new one). */
  function live(answer: (d: Record<string, unknown>) => Record<string, unknown> = (d) => d) {
    let current: Record<string, unknown> = { ...DEFINITION };
    let version = 3;
    const r = routes({
      [`GET ${ORG}/agent-templates/t9`]: () => json(200, detail({ definition: current, version })),
      [`PUT ${ORG}/agent-templates/t9`]: (c) => {
        current = answer((JSON.parse(String(c.body)) as Put).definition);
        version += 1;
        return json(200, detail({ definition: current, version }));
      },
    });
    return r;
  }
  const lastPut = (calls: { method: string; body: unknown }[]) =>
    bodyOf(calls.filter((c) => c.method === "PUT").at(-1) as never) as Put;
  const rowOf = (title: string) =>
    (screen.getAllByText(title).find((e) => e.closest("li")) as HTMLElement).closest(
      "li",
    ) as HTMLElement;
  const save = (user: ReturnType<typeof userEvent.setup>) =>
    user.click(screen.getByRole("button", { name: TF.submit }));

  it("工具: an extension tool the org turned off shows the switched-off reason", async () => {
    const r = live();
    r[`GET ${ORG}/agent-templates/t9`] = () =>
      json(
        200,
        detail({
          definition: { ...DEFINITION, tools: ["AskUserQuestion", "plugin__todo__write"] },
        }),
      );
    r[`GET ${ORG}/tools/extensions`] = () =>
      json(200, {
        extensions: [
          {
            plugin: "todo",
            displayName: { zh: "待办", en: "Todo" },
            tools: [
              {
                name: "write",
                key: "plugin__todo__write",
                title: "Write the list",
                description: "",
                annotations: {},
                defaultPolicy: "allow",
                switchedOff: true,
              },
            ],
          },
        ],
      });
    stubApi(r);
    await renderRouteWithCache("/agents/templates/t9?s=tools", r);
    const group = await screen.findByRole("list", { name: "Todo" });
    expect(within(group).getByText(TF.extensionToolOffInOrg)).toBeTruthy();
  });

  it("连接器: a connector template on in the org is added, policies are set per listed tool, and both round-trip", async () => {
    const r = live();
    r[`GET ${ORG}/components`] = () =>
      json(200, {
        components: [
          { kind: "connector_template", id: "ct-wiki", name: "Wiki", on: true, plugin: "wiki" },
          { kind: "connector_template", id: "ct-jira", name: "Jira", on: true, plugin: "jira" },
          { kind: "connector_template", id: "ct-off", name: "Offline", on: false, plugin: "x" },
        ],
      });
    const calls = stubApi(r);
    await renderRouteWithCache("/agents/templates/t9?s=connectors", r);
    const user = userEvent.setup();
    const picker = await screen.findByRole("combobox", { name: P.connectors.addTemplateLabel });
    // Wiki is named already, Offline is off in the org: Jira is the one to add
    const list = await (async () => {
      await user.click(picker);
      return screen.findByRole("listbox");
    })();
    const labels = within(list)
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(labels).toEqual([P.connectors.pickTemplate, "Jira"]);
    await user.click(within(list).getByRole("option", { name: "Jira" }));
    await user.click(screen.getByRole("button", { name: P.connectors.addTemplate }));
    const jira = rowOf("Jira");
    await user.type(within(jira).getByRole("textbox"), "create\nsearch");
    await pickOption(within(jira).getByRole("combobox", { name: "search" }), TF.policy.ask, user);
    // the needs entry's listed tools get their selects too
    await pickOption(
      within(rowOf("CRM")).getByRole("combobox", { name: "update" }),
      TF.policy.deny,
      user,
    );
    // a template entry naming no tools keeps its policies read-only (Wiki has none: no line)
    expect(within(rowOf("Wiki")).queryByRole("combobox")).toBeNull();
    // removing Wiki offers it again
    await user.click(screen.getByRole("button", { name: "Remove Wiki" }));
    await user.click(picker);
    expect(await screen.findByRole("option", { name: "Wiki" })).toBeTruthy();
    await user.keyboard("{Escape}");
    await save(user);
    await vi.waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(lastPut(calls).definition.connectors).toEqual([
      {
        needs: {
          protocol: "mcp",
          endpoint: "https://crm.example.com/mcp",
          tools: ["search", "update"],
          label: "CRM",
        },
        policies: { update: "deny" },
      },
      { template: "ct-jira", tools: ["create", "search"], policies: { search: "ask" } },
    ]);
    // read again after the save: the saved policies are what the selects show
    await vi.waitFor(() => expect(screen.queryByRole("button", { name: TF.submit })).toBeNull());
    expect(within(rowOf("Jira")).getByRole("combobox", { name: "search" }).textContent).toContain(
      TF.policy.ask,
    );
  });

  it("连接器: a template entry without tools keeps its policies read-only and counts only those", async () => {
    const r = live();
    r[`GET ${ORG}/agent-templates/t9`] = () =>
      json(
        200,
        detail({
          definition: {
            ...DEFINITION,
            connectors: [{ template: "ct-wiki", policies: { publish: "deny", read: "ask" } }],
          },
        }),
      );
    stubApi(r);
    await renderRouteWithCache("/agents/templates/t9?s=connectors", r);
    expect(
      await screen.findByText(
        "This connector lists no tools: its 2 tool policies stay as saved (publish · Denied, read · Ask first); list its tools to change them.",
      ),
    ).toBeTruthy();
  });

  it("连接器: the endpoint the kernel stored canonical is what the field shows after the save", async () => {
    const r = live((d) => ({
      ...d,
      connectors: (d.connectors as Record<string, unknown>[]).map((c) =>
        "needs" in c
          ? { ...c, needs: { ...(c.needs as object), endpoint: "https://crm.example.com/" } }
          : c,
      ),
    }));
    stubApi(r);
    await renderRouteWithCache("/agents/templates/t9?s=connectors", r);
    const user = userEvent.setup();
    const endpoint = await screen.findByRole("textbox", { name: P.connectors.endpoint });
    await user.clear(endpoint);
    await user.type(endpoint, "https://CRM.example.com");
    await save(user);
    await vi.waitFor(() =>
      expect(screen.getByRole("textbox", { name: P.connectors.endpoint })).toHaveProperty(
        "value",
        "https://crm.example.com/",
      ),
    );
  });

  it("重新加载 after a version conflict reads the template again and drops the edits", async () => {
    let reads = 0;
    const r = routes({
      [`GET ${ORG}/agent-templates/t9`]: () => {
        reads += 1;
        return json(
          200,
          reads === 1
            ? detail()
            : detail({
                version: 4,
                definition: { ...DEFINITION, description: "Changed elsewhere." },
              }),
        );
      },
      [`PUT ${ORG}/agent-templates/t9`]: () =>
        json(409, { error: { code: "agent_template.version_conflict", message: "changed" } }),
    });
    stubApi(r);
    await renderRouteWithCache("/agents/templates/t9", r);
    const user = userEvent.setup();
    const box = await screen.findByRole("textbox", { name: P.basics.description });
    await user.type(box, " mine");
    await save(user);
    await user.click(await screen.findByRole("button", { name: en.agents.page.reload }));
    await vi.waitFor(() =>
      expect(screen.getByRole("textbox", { name: P.basics.description })).toHaveProperty(
        "value",
        "Changed elsewhere.",
      ),
    );
    expect(screen.queryByText(en.errors.agent_template.version_conflict)).toBeNull();
  });

  it("工具: everything starts on; unticking writes disallowedTools, policies sit on the rows", async () => {
    const r = live();
    const calls = stubApi(r);
    await renderRouteWithCache("/agents/templates/t9?s=tools", r);
    const user = userEvent.setup();
    const read = await screen.findByRole("checkbox", { name: TF.builtin.ReadToolOutput });
    // tools default-on: every box starts checked, the old allowlist notwithstanding
    expect(read).toHaveProperty("checked", true);
    expect(screen.getByRole("checkbox", { name: TF.builtin.Bash })).toHaveProperty("checked", true);
    await user.click(read);
    await pickOption(
      screen.getByRole("combobox", { name: `Policy for ${TF.builtin.Platform}` }),
      TF.policy.deny,
      user,
    );
    await save(user);
    await vi.waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    const { definition } = lastPut(calls);
    // no allowlist is written; the template turns off what is unticked
    expect(definition.tools).toBeUndefined();
    expect(definition.disallowedTools).toEqual(["ReadToolOutput"]);
    expect(definition.toolPolicies).toEqual({ AskUserQuestion: "ask", Platform: "deny" });
  });

  it("技能: at most 3 pinned, unticking a skill unpins it, the rest are selected", async () => {
    const r = live();
    const skill = (name: string) => ({
      id: `s-${name}`,
      scope: "org",
      agentId: null,
      name,
      description: `${name} skill`,
      currentVersion: 1,
      createdBy: "a1",
      createdAt: "2026-11-07T00:00:00.000Z",
      updatedAt: "2026-11-07T00:00:00.000Z",
    });
    r[`GET ${ORG}/skills`] = () =>
      json(200, { skills: ["pricing", "tone", "alpha", "beta"].map(skill) });
    const calls = stubApi(r);
    await renderRouteWithCache("/agents/templates/t9?s=skills", r);
    const user = userEvent.setup();
    const sk = en.agents.templatePage.skills;
    // two titled regions; the pinned count at the heading
    await screen.findByRole("region", { name: sk.selectLabel });
    const pinned = screen.getByRole("region", { name: sk.pinLabel });
    expect(within(pinned).getByText(sk.pinHint)).toBeTruthy();
    expect(within(pinned).getByText("1 / 3")).toBeTruthy();
    await user.click(await screen.findByRole("checkbox", { name: "alpha · alpha skill" }));
    await user.click(screen.getByRole("checkbox", { name: "beta · beta skill" }));
    await user.click(screen.getByRole("checkbox", { name: "Pin tone" }));
    await user.click(screen.getByRole("checkbox", { name: "Pin alpha" }));
    expect(within(pinned).getByText("3 / 3")).toBeTruthy();
    // three pinned: the fourth cannot be
    expect(screen.getByRole("checkbox", { name: "Pin beta" })).toHaveProperty("disabled", true);
    // unticking tone unpins it, which frees a place
    await user.click(screen.getByRole("checkbox", { name: "tone · tone skill" }));
    expect(screen.queryByRole("checkbox", { name: "Pin tone" })).toBeNull();
    expect(screen.getByRole("checkbox", { name: "Pin beta" })).toHaveProperty("disabled", false);
    await save(user);
    await vi.waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    const { definition } = lastPut(calls);
    expect(definition.skills).toEqual(["pricing", "alpha"]);
    expect(definition.selectedSkills).toEqual(["beta"]);
  });

  it("技能: no org skills is the panel empty state linking to the skills page; nothing picked, nothing to pin", async () => {
    const r = live();
    const { skills: _p, selectedSkills: _s, ...bare } = DEFINITION;
    r[`GET ${ORG}/agent-templates/t9`] = () => json(200, detail({ definition: bare, version: 3 }));
    r[`GET ${ORG}/skills`] = () => json(200, { skills: [] });
    stubApi(r);
    await renderRouteWithCache("/agents/templates/t9?s=skills", r);
    const sk = en.agents.templatePage.skills;
    const org = await screen.findByRole("region", { name: sk.selectLabel });
    const pinned = screen.getByRole("region", { name: sk.pinLabel });
    expect(await within(org).findByText(sk.noOrgSkills)).toBeTruthy();
    expect(within(org).getByRole("link", { name: sk.goToSkills }).getAttribute("href")).toContain(
      "/skills",
    );
    expect(within(pinned).getByText(sk.noneToPin)).toBeTruthy();
    expect(within(pinned).queryByRole("checkbox")).toBeNull();
    expect(within(pinned).getByText("0 / 3")).toBeTruthy();
  });

  it("子智能体: inline sub-agents with all, no and listed tools round-trip; an empty list is refused", async () => {
    const r = live();
    const calls = stubApi(r);
    await renderRouteWithCache("/agents/templates/t9?s=subagents", r);
    const user = userEvent.setup();
    const fill = async (row: HTMLElement, name: string, mode?: string) => {
      await user.type(within(row).getByRole("textbox", { name: SA.inlineName }), name);
      await user.type(
        within(row).getByRole("textbox", { name: SA.inlineDescription }),
        `${name} it`,
      );
      await user.type(within(row).getByRole("textbox", { name: SA.inlineInstructions }), "Do it.");
      if (mode !== undefined) {
        await pickOption(
          within(row).getByRole("combobox", { name: P.subagents.tools }),
          mode,
          user,
        );
      }
    };
    const rows = () =>
      within(screen.getByRole("list", { name: SA.inlineLabel })).getAllByRole("listitem");
    for (let i = 0; i < 3; i++) {
      await user.click(await screen.findByRole("button", { name: SA.addInline }));
    }
    await fill(rows()[0] as HTMLElement, "all-tools");
    await fill(rows()[1] as HTMLElement, "no-tools", P.subagents.toolsMode.none);
    await fill(rows()[2] as HTMLElement, "some-tools", P.subagents.toolsMode.list);
    await save(user);
    expect(await screen.findByText(P.subagents.toolsListEmpty)).toBeTruthy();
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
    await user.type(
      within(rows()[2] as HTMLElement).getByRole("textbox", {
        name: new RegExp(`^${P.subagents.toolKeys}`),
      }),
      "Read",
    );
    await save(user);
    await vi.waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    const base = { instructions: "Do it.", model: "inherit", skills: [] };
    expect(lastPut(calls).definition.subagents).toEqual({
      general: true,
      types: ["docs:reviewer"],
      inline: [
        { name: "all-tools", description: "all-tools it", ...base },
        { name: "no-tools", description: "no-tools it", ...base, tools: [] },
        { name: "some-tools", description: "some-tools it", ...base, tools: ["Read"] },
      ],
    });
  });

  it("提示词 and 快捷操作 save their part", async () => {
    const r = live();
    const calls = stubApi(r);
    const view = await renderRouteWithCache("/agents/templates/t9?s=prompt", r);
    const user = userEvent.setup();
    const content = await screen.findByRole("textbox", {
      name: new RegExp(`^${en.agents.page.prompt.contentLabel}`),
    });
    await user.clear(content);
    await user.type(content, "New prompt.");
    await save(user);
    await vi.waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(lastPut(calls).definition).toMatchObject({
      instructionFiles: [{ name: "AGENTS.md", content: "New prompt." }],
      instructions: "New prompt.",
    });
    await view.navigate("/agents/templates/t9?s=quick-actions");
    const title = await screen.findByRole("textbox", {
      name: new RegExp(`^${en.agents.page.quickActions.titleLabel}`),
    });
    await user.type(title, " v2");
    await save(user);
    await vi.waitFor(() => expect(calls.filter((c) => c.method === "PUT")).toHaveLength(2));
    expect(lastPut(calls).definition.quickActions).toEqual([
      { title: "Weekly v2", body: "Write the weekly summary." },
    ]);
  });
});
