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
    expect(screen.getByText("Drafts sales replies.", { selector: "dd, span, div" })).toBeTruthy();
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
  });

  it("the owner's own promoted template switched off in its org: the editor with the notice and 启用", async () => {
    const r = routes({
      [`GET ${ORG}/agent-templates/t9`]: () =>
        json(200, detail({ promoted: true, shareable: true })),
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
              linkedIds: ["t9"],
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
});
