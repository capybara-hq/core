import { act, cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import type { Me } from "../src/lib/session";
import { bodyOf, json, stubApi } from "./support/api";
import { resetNavigation, router } from "./support/navigation";
import { renderRouteEmptyCache, renderRouteWithCache } from "./support/query";
import { ME } from "./support/render";
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
 * Plugin scope phase 2, Task 10: the workspace 技能 and 智能体模板 pages list the org's own items
 * and the platform components offered to the org with their state and switches (spec §9, §5 rules
 * 5, 10, 11, §13.5); the plugin detail lists its components with per-component switches; members
 * read them; an installed plugin that misses a connector offers 补充配置.
 */

const ORG = "/api/v1/orgs/o1";
const T = "2026-11-06T08:00:00.000Z";
const ITEM = "11111111-1111-4111-8111-111111111111";
const C = en.orgComponents;

const MEMBER: Me = {
  ...ME,
  account: { ...ME.account, isSuperAdmin: false },
  memberships: [{ orgId: "o1", slug: "acme", name: "Acme", role: "member" }],
};

const skill = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  id,
  scope: "org",
  agentId: null,
  name,
  description: `Use for ${name}.`,
  currentVersion: 1,
  createdBy: "a1",
  createdAt: T,
  updatedAt: T,
  origin: "org",
  ...over,
});

const component = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  kind: "skill",
  id,
  name,
  description: `Use for ${name}.`,
  plugin: "docs",
  itemId: ITEM,
  version: "2",
  scopeMode: "follow",
  switch: null,
  on: false,
  locked: false,
  pluginOn: true,
  switchable: true,
  ...over,
});

/** Own skill `mine`; platform `pdf` (on), `notes` (off), `web` (`all`), `crm` (plugin off). */
const LIBRARY = [
  skill("s1", "mine"),
  skill("p1", "pdf", { origin: "platform", plugin: "docs", linkedIds: [] }),
  skill("p3", "web", { origin: "platform", plugin: "docs", linkedIds: [] }),
];
const OFFERED = [
  component("p1", "pdf", { on: true }),
  component("p2", "notes"),
  component("p3", "web", { on: true, locked: true, switchable: false }),
  component("p4", "crm", {
    pluginOn: false,
    switchable: false,
    itemId: "22222222-2222-4222-8222-222222222222",
    plugin: "crm",
  }),
];

const skillRoutes = (over: Routes = {}): Routes => ({
  [`GET ${ORG}/skills`]: () => json(200, { skills: LIBRARY }),
  [`GET ${ORG}/components?kind=skill`]: () => json(200, { components: OFFERED }),
  ...over,
});

const rowOf = async (name: string, locale: "zh" | "en" = "en") => {
  const list = await screen.findByRole("list", { name: { zh, en }[locale].skills.listLabel });
  const row = within(list)
    .getAllByRole("listitem")
    .find((li) => within(li).queryByText(name, { exact: true }) !== null);
  if (row === undefined) throw new Error(`no row ${name}`);
  return row as HTMLElement;
};

/** Lets pending reads and effects run (a read after mount would show up in the calls). */
const settle = () => act(() => new Promise((r) => setTimeout(r, 20)));

beforeEach(() => resetNavigation("/skills"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("/skills: own and platform skills with their org state", () => {
  it.each(["zh", "en"] as const)(
    "rows carry 本组织 / 平台 and the state; `all` reads 已启用 · 平台统一 with no switch (%s)",
    async (locale) => {
      const m = { zh, en }[locale].orgComponents;
      const browser = expectNoFirstPaintFetch();
      await renderRouteWithCache("/skills", skillRoutes(), { locale });
      const rowOfL = (name: string) => rowOf(name, locale);
      const mine = await rowOfL("mine");
      expect(within(mine).getByText(m.origin.org)).toBeTruthy();
      const pdf = await rowOfL("pdf");
      expect(within(pdf).getByText(m.origin.platform)).toBeTruthy();
      expect(within(pdf).getByText(m.state.on)).toBeTruthy();
      const web = await rowOfL("web");
      expect(within(web).getByText(m.state.platform)).toBeTruthy();
      expect(within(web).queryByRole("button")).toBeNull();
      const notes = await rowOfL("notes");
      expect(within(notes).getByText(m.state.off)).toBeTruthy();
      expect(within(notes).getByRole("button", { name: m.action.enable })).toBeTruthy();
      // a component whose plugin is off here comes on with its plugin
      const crm = await rowOfL("crm");
      expect(within(crm).getByText(m.state.pluginOff)).toBeTruthy();
      expect(within(crm).getByRole("link", { name: m.action.plugin }).getAttribute("href")).toBe(
        "/plugins/22222222-2222-4222-8222-222222222222",
      );
      await settle();
      expect(browser).toEqual([]);
    },
  );

  it.each(["zh", "en"] as const)(
    "a platform row names its owner: 本组织 for the org's own upload, the owner org for a shared one (%s)",
    async (locale) => {
      const m = { zh, en }[locale];
      const own = { kind: "org", orgId: "o1", name: "Acme" };
      const beta = { kind: "org", orgId: "o2", name: "Beta" };
      const routes = skillRoutes({
        [`GET ${ORG}/skills`]: () =>
          json(200, {
            skills: [
              ...LIBRARY,
              skill("p5", "minutes", { origin: "platform", plugin: "minutes", owner: own }),
              skill("p6", "shared", { origin: "platform", plugin: null, owner: beta }),
            ],
          }),
        [`GET ${ORG}/components?kind=skill`]: () =>
          json(200, {
            components: [
              ...OFFERED.map((c) => ({ ...c, owner: { kind: "platform" } })),
              component("p5", "minutes", { on: true, plugin: "minutes", owner: own }),
              component("p6", "shared", { on: true, plugin: null, owner: beta }),
            ],
          }),
      });
      await renderRouteWithCache("/skills", routes, { locale });
      const minutes = await rowOf("minutes", locale);
      expect(within(minutes).getByText(m.catalog.owner.self)).toBeTruthy();
      expect(within(minutes).queryByText(m.catalog.owner.platform)).toBeNull();
      const shared = await rowOf("shared", locale);
      expect(within(shared).getByText("Beta")).toBeTruthy();
      expect(shared.textContent).toContain(m.orgComponents.from.orgNamed.replace("{org}", "Beta"));
      expect(within(await rowOf("pdf", locale)).getByText(m.catalog.owner.platform)).toBeTruthy();
    },
  );

  it("members read it: no switch, no upload", async () => {
    await renderRouteWithCache("/skills", skillRoutes(), { me: MEMBER });
    const notes = await rowOf("notes");
    expect(within(notes).getByText(C.state.off)).toBeTruthy();
    expect(within(notes).queryByRole("button")).toBeNull();
    expect(within(await rowOf("pdf")).queryByRole("button")).toBeNull();
    expect(screen.queryByRole("button", { name: en.skills.upload.open })).toBeNull();
  });

  it("an org admin switches a platform skill on; the switch invalidates the lists", async () => {
    let on = false;
    const routes = skillRoutes({
      [`GET ${ORG}/components?kind=skill`]: () =>
        json(200, {
          components: OFFERED.map((c) => (c.id === "p2" ? { ...c, on, switch: on } : c)),
        }),
      [`PUT ${ORG}/components/skill/p2/switch`]: () => {
        on = true;
        return json(200, { component: { ...component("p2", "notes"), on: true } });
      },
    });
    const calls = stubApi(routes);
    await renderRouteWithCache("/skills", routes);
    const notes = await rowOf("notes");
    await userEvent.setup().click(within(notes).getByRole("button", { name: C.action.enable }));
    expect(await screen.findByText(C.toast.enabled.replace("{name}", "notes"))).toBeTruthy();
    expect(bodyOf(calls.find((c) => c.method === "PUT"))).toEqual({ enabled: true });
    await vi.waitFor(() =>
      expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(
        expect.arrayContaining([`GET ${ORG}/components?kind=skill`, `GET ${ORG}/skills`]),
      ),
    );
    expect(within(await rowOf("notes")).getByText(C.state.on)).toBeTruthy();
  });

  it("启用 shows its pending state and cannot be pressed again until the switch answers", async () => {
    let answer: () => void = () => {};
    const held = new Promise<void>((r) => {
      answer = r;
    });
    const routes = skillRoutes({
      [`PUT ${ORG}/components/skill/p2/switch`]: async () => {
        await held;
        return json(200, { component: { ...component("p2", "notes"), on: true } });
      },
    });
    const calls = stubApi(routes);
    await renderRouteWithCache("/skills", routes);
    const user = userEvent.setup();
    const button = within(await rowOf("notes")).getByRole("button", { name: C.action.enable });
    await user.click(button);
    // The row keeps its button, drawn pending (not removed while the switch runs)
    const pending = within(await rowOf("notes")).getByRole("button", { name: C.action.enable });
    await vi.waitFor(() => expect(pending.getAttribute("aria-busy")).toBe("true"));
    expect((pending as HTMLButtonElement).disabled).toBe(true);
    await user.click(pending);
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);
    await act(async () => answer());
    expect(await screen.findByText(C.toast.enabled.replace("{name}", "notes"))).toBeTruthy();
  });

  it("switching off previews the agents that use it, then confirms with its hash", async () => {
    const hash = "a".repeat(64);
    const routes = skillRoutes({
      [`PUT ${ORG}/components/skill/p1/switch`]: (call) => {
        const b = JSON.parse(String(call.body)) as { confirm?: string };
        return b.confirm === undefined
          ? json(200, {
              preview: { agents: [{ id: "ag1", name: "Helper", refs: ["p1"] }], connectorsKept: 0 },
              confirm: hash,
            })
          : json(200, { component: component("p1", "pdf", { switch: false }) });
      },
    });
    const calls = stubApi(routes);
    await renderRouteWithCache("/skills", routes);
    const user = userEvent.setup();
    await user.click(
      within(await rowOf("pdf")).getByRole("button", { name: /More actions|更多操作/ }),
    );
    await user.click(await screen.findByRole("menuitem", { name: C.action.disable }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("· Helper")).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: C.switchOff.confirm }));
    expect(await screen.findByText(C.toast.disabled.replace("{name}", "pdf"))).toBeTruthy();
    expect(calls.filter((c) => c.method === "PUT").map(bodyOf)).toEqual([
      { enabled: false },
      { enabled: false, confirm: hash },
    ]);
  });

  it("switching on a skill whose name the org already uses says so (rule 10)", async () => {
    const routes = skillRoutes({
      [`PUT ${ORG}/components/skill/p2/switch`]: () =>
        json(409, {
          error: {
            code: "plugin.skill_conflict",
            message: "x",
            details: [{ skill: "notes", source: { kind: "org" } }],
          },
        }),
    });
    stubApi(routes);
    await renderRouteWithCache("/skills", routes);
    await userEvent
      .setup()
      .click(within(await rowOf("notes")).getByRole("button", { name: C.action.enable }));
    expect(await screen.findByText(C.error.conflict.skill.replace("{name}", "notes"))).toBeTruthy();
  });

  it("an offered-components read that fails says so above the list, with a retry", async () => {
    const routes = skillRoutes({
      [`GET ${ORG}/components?kind=skill`]: () =>
        json(500, { error: { code: "internal", message: "x" } }),
    });
    stubApi(routes);
    await renderRouteWithCache("/skills", routes);
    expect(await screen.findByText(C.listUnavailable)).toBeTruthy();
    expect(screen.getByRole("button", { name: C.retry })).toBeTruthy();
    expect(await rowOf("mine")).toBeTruthy();
  });

  it("an empty cache shows the template's loading state, then the data", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    await renderRouteEmptyCache("/skills", {
      ...skillRoutes(),
      [`GET ${ORG}/skills`]: async () => {
        await held;
        return json(200, { skills: LIBRARY });
      },
    });
    await vi.waitFor(() => expect(document.querySelector("[aria-busy='true']")).not.toBeNull());
    await act(async () => release());
    expect(await screen.findByText("notes")).toBeTruthy();
  });
});

describe("/agents?tab=templates: the 模板 tab (rulings P4-14, P4-16)", () => {
  const PATH = "/agents?tab=templates";
  beforeEach(() => {
    resetNavigation(PATH);
    // the tab follows the address (`useSearchParams` reads the jsdom location)
    window.history.replaceState(null, "", PATH);
  });
  const A = en.agents.templates;
  const template = (id: string, name: string, over: Record<string, unknown> = {}) => ({
    id,
    name,
    plugin: "docs",
    type: `docs:${name}`,
    description: `${name} template.`,
    model: "inherit",
    version: 1,
    origin: "platform",
    linkedIds: [],
    catalogItemId: ITEM,
    ...over,
  });
  const detail = (over: Record<string, unknown> = {}) => ({
    template: {
      ...template("t9", "sales", {
        plugin: null,
        type: "sales",
        origin: "org",
        catalogItemId: null,
      }),
      definition: {},
      owner: { kind: "org", orgId: "o1", name: "Acme" },
      owned: true,
      shareable: false,
      promoted: false,
      ...over,
    },
  });
  /** Platform `reviewer` (on), `writer` (off, offered), the org's own `sales` (no plugin). */
  const routes = (): Routes => ({
    [`GET ${ORG}/agents`]: () => json(200, { agents: [] }),
    [`GET ${ORG}/members`]: () => json(200, { members: [] }),
    [`GET ${ORG}/agent-templates`]: () =>
      json(200, {
        templates: [
          template("t1", "reviewer"),
          template("t9", "sales", {
            plugin: null,
            type: "sales",
            origin: "org",
            catalogItemId: null,
            version: 3,
          }),
        ],
      }),
    [`GET ${ORG}/components?kind=agent_template`]: () =>
      json(200, {
        components: [
          component("t1", "reviewer", {
            kind: "agent_template",
            on: true,
            owner: { kind: "platform" },
          }),
          component("t2", "writer", { kind: "agent_template", owner: { kind: "platform" } }),
        ],
      }),
    [`GET ${ORG}/agent-templates/t9`]: () => json(200, detail()),
  });
  const grid = () => screen.findByRole("list", { name: A.listLabel });
  const card = async (name: string) =>
    (await within(await grid()).findByRole("link", { name })).closest("li") as HTMLElement;
  const menuOf = async (c: HTMLElement) => {
    await userEvent.setup().click(within(c).getByRole("button", { name: "More actions" }));
    return (await screen.findAllByRole("menuitem")).map((i) => i.textContent);
  };

  it("cards: source · version, 用它创建 on the usable ones; a first render makes no browser read", async () => {
    const browser = expectNoFirstPaintFetch();
    const { container } = await renderRouteWithCache(PATH, routes());
    expect(container.querySelector('[data-template="ListPage"]')).not.toBeNull();
    const l = await grid();
    expect(l.getAttribute("data-part")).toBe("card-grid");
    const reviewer = await card("reviewer");
    expect(within(reviewer).getByRole("link", { name: "reviewer" }).getAttribute("href")).toBe(
      "/agents/templates/t1",
    );
    expect(within(reviewer).getByText("Plugin · docs · v1")).toBeTruthy();
    // 用它创建 goes to the template page until its dialog lands (phase 4 Task 8)
    expect(within(reviewer).getByRole("link", { name: A.create }).getAttribute("href")).toBe(
      "/agents/templates/t1",
    );
    const sales = await card("sales");
    expect(within(sales).getByText("This org · v3")).toBeTruthy();
    // an off platform template: no 用它创建; the org admin's 启用 is its primary
    const writer = await card("writer");
    expect(within(writer).getByText(C.state.off)).toBeTruthy();
    expect(within(writer).queryByRole("link", { name: A.create })).toBeNull();
    expect(within(writer).getByRole("button", { name: C.action.enable })).toBeTruthy();
    // the head counts both tabs
    expect(screen.getByRole("tab", { name: /Templates/ }).textContent).toContain("3");
    await settle();
    expect(browser).toEqual([]);
  });

  it("members: 用它创建 and 查看 only (a lone 查看 is a second button), no switch, no owner actions", async () => {
    const r = routes();
    const calls = stubApi(r);
    await renderRouteWithCache(PATH, r, { me: MEMBER });
    const sales = await card("sales");
    expect(within(sales).getByRole("link", { name: A.create })).toBeTruthy();
    expect(within(sales).getByRole("link", { name: A.view }).getAttribute("href")).toBe(
      "/agents/templates/t9",
    );
    expect(within(sales).queryByRole("button")).toBeNull();
    const writer = await card("writer");
    expect(within(writer).queryByRole("button")).toBeNull();
    await settle();
    // the owner's flags are never read for a member
    expect(calls.some((c) => c.url.endsWith("/agent-templates/t9"))).toBe(false);
  });

  it("an owner-org admin: 编辑, 设为可共享 and 删除 on the org's own template; 查看 and 停用 on a platform one", async () => {
    const r: Routes = {
      ...routes(),
      [`PUT ${ORG}/agent-templates/t9/shareable`]: () => json(200, { id: "t9", shareable: true }),
    };
    const calls = stubApi(r);
    await renderRouteWithCache(PATH, r);
    const sales = await card("sales");
    await vi.waitFor(async () => {
      expect(await menuOf(sales)).toEqual([A.edit, A.share, A.delete]);
    });
    await userEvent.setup().click(screen.getByRole("menuitem", { name: A.share }));
    await vi.waitFor(() =>
      expect(
        bodyOf(calls.find((c) => c.method === "PUT" && c.url.endsWith("/t9/shareable"))),
      ).toEqual({ shareable: true }),
    );
    expect(await menuOf(await card("reviewer"))).toEqual([A.view, C.action.disable]);
  });

  it("可共享 runs once: its item is disabled while the call is on its way", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    const r: Routes = {
      ...routes(),
      [`PUT ${ORG}/agent-templates/t9/shareable`]: async () => {
        await held;
        return json(200, { id: "t9", shareable: true });
      },
    };
    const calls = stubApi(r);
    await renderRouteWithCache(PATH, r);
    const user = userEvent.setup();
    const sales = await card("sales");
    await vi.waitFor(async () => expect(await menuOf(sales)).toContain(A.share));
    await user.click(screen.getByRole("menuitem", { name: A.share }));
    expect(await menuOf(sales)).toContain(A.share);
    const item = screen.getByRole("menuitem", { name: A.share });
    expect(item.getAttribute("aria-disabled") ?? item.getAttribute("data-disabled")).toBeTruthy();
    await user.keyboard("{Escape}");
    await act(async () => release());
    expect(calls.filter((c) => c.method === "PUT").length).toBe(1);
  });

  it("deleting the org's own template: the preview first, the name typed, then DELETE", async () => {
    const r: Routes = {
      ...routes(),
      [`GET ${ORG}/agent-templates/t9/delete-preview`]: () =>
        json(200, {
          outcome: "transferred",
          orgs: [{ id: "o2", name: "Beta" }],
          agents: [{ id: "ag1", name: "Planner" }],
        }),
      // the other org stopped using it in between: the answer, not the preview, is what happened
      [`DELETE ${ORG}/agent-templates/t9`]: () => json(200, { outcome: "removed" }),
    };
    const calls = stubApi(r);
    await renderRouteWithCache(PATH, r);
    const user = userEvent.setup();
    const sales = await card("sales");
    await vi.waitFor(async () => expect(await menuOf(sales)).toContain(A.delete));
    await user.click(screen.getByRole("menuitem", { name: A.delete }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText(/Beta/)).toBeTruthy();
    expect(within(dialog).getByText("· Planner")).toBeTruthy();
    const confirm = within(dialog).getByRole("button", { name: A.delete });
    expect(confirm).toHaveProperty("disabled", true);
    await user.type(within(dialog).getByRole("textbox"), "sales");
    await user.click(confirm);
    await vi.waitFor(() =>
      expect(
        calls.some((c) => c.method === "DELETE" && c.url.endsWith("/agent-templates/t9")),
      ).toBe(true),
    );
    expect(await screen.findByText(A.deleted.replace("{name}", "sales"))).toBeTruthy();
    expect(screen.queryByText(A.deletedTransferred.replace("{name}", "sales"))).toBeNull();
  });

  it("a plugin's template of the org is never the org's to edit, share or delete", async () => {
    const r: Routes = {
      ...routes(),
      [`GET ${ORG}/agent-templates`]: () =>
        json(200, { templates: [template("t5", "helper", { origin: "org" })] }),
      [`GET ${ORG}/components?kind=agent_template`]: () => json(200, { components: [] }),
    };
    const calls = stubApi(r);
    await renderRouteWithCache(PATH, r);
    const helper = await card("helper");
    expect(within(helper).getByRole("link", { name: A.view })).toBeTruthy();
    expect(within(helper).queryByRole("button")).toBeNull();
    await settle();
    expect(calls.some((c) => c.url.endsWith("/agent-templates/t5"))).toBe(false);
  });

  it("an org admin switches a platform template on from its card", async () => {
    const r = {
      ...routes(),
      [`PUT ${ORG}/components/agent_template/t2/switch`]: () =>
        json(200, { component: component("t2", "writer", { kind: "agent_template", on: true }) }),
    };
    const calls = stubApi(r);
    await renderRouteWithCache(PATH, r);
    await userEvent
      .setup()
      .click(within(await card("writer")).getByRole("button", { name: C.action.enable }));
    await vi.waitFor(() =>
      expect(calls.some((c) => c.method === "PUT" && c.url.endsWith("/t2/switch"))).toBe(true),
    );
  });

  it("the search narrows the cards; nothing left is one sentence", async () => {
    stubApi(routes());
    await renderRouteWithCache(PATH, routes());
    await card("reviewer");
    const user = userEvent.setup();
    await user.type(screen.getByRole("searchbox", { name: A.search }), "sal");
    expect(within(await grid()).getByText("sales")).toBeTruthy();
    expect(screen.queryByText("reviewer")).toBeNull();
    await user.type(screen.getByRole("searchbox", { name: A.search }), "zzz");
    expect(screen.getByText(A.noMatch)).toBeTruthy();
  });

  it("switching tabs keeps the address in step and clears the search", async () => {
    stubApi(routes());
    await renderRouteWithCache(PATH, routes());
    await card("reviewer");
    const user = userEvent.setup();
    await user.type(screen.getByRole("searchbox", { name: A.search }), "sal");
    await user.click(screen.getByRole("tab", { name: /Agents/ }));
    expect(window.location.search).toBe("");
    expect(await screen.findByText(en.agents.empty)).toBeTruthy();
    expect(
      (screen.getByRole("searchbox", { name: en.agents.search }) as HTMLInputElement).value,
    ).toBe("");
    await user.click(screen.getByRole("tab", { name: /Templates/ }));
    expect(window.location.search).toBe("?tab=templates");
    expect(await card("sales")).toBeTruthy();
  });

  it("the tab follows the address: the sidebar's 智能体 (/agents) while 模板 is open goes back to 智能体; the filter survives", async () => {
    resetNavigation("/agents");
    window.history.replaceState(null, "", "/agents");
    stubApi(routes());
    const { navigate } = await renderRouteWithCache("/agents", routes());
    const user = userEvent.setup();
    const filter = await screen.findByRole("radiogroup", { name: en.agents.filter });
    await user.click(within(filter).getByRole("radio", { name: en.agents.tabs.mine }));
    await user.click(screen.getByRole("tab", { name: /Templates/ }));
    expect(window.location.search).toBe("?tab=templates");
    expect(await card("sales")).toBeTruthy();
    // a link to the bare page: Next moves the address and renders the page again
    window.history.replaceState(null, "", "/agents");
    await act(async () => navigate("/agents"));
    expect(screen.getByRole("tab", { name: /Agents/ }).getAttribute("aria-selected")).toBe("true");
    // the agents' filter kept its choice across the switch
    const again = screen.getByRole("radiogroup", { name: en.agents.filter });
    expect(
      within(again).getByRole("radio", { name: en.agents.tabs.mine }).getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("a list that fails: its open tab shows no count, never 0", async () => {
    const r: Routes = {
      ...routes(),
      [`GET ${ORG}/agent-templates`]: () =>
        json(500, { error: { code: "internal", message: "boom" } }),
    };
    stubApi(r);
    await renderRouteWithCache(PATH, r);
    await screen.findByText(en.errors.page.title);
    const tab = screen.getByRole("tab", { name: /Templates/ });
    expect(tab.querySelector(".cb-tab-count")).toBeNull();
  });

  it("no templates at all: the page empty state", async () => {
    const r: Routes = {
      ...routes(),
      [`GET ${ORG}/agent-templates`]: () => json(200, { templates: [] }),
      [`GET ${ORG}/components?kind=agent_template`]: () => json(200, { components: [] }),
    };
    stubApi(r);
    await renderRouteWithCache(PATH, r, { me: MEMBER });
    expect(await screen.findByText(A.empty)).toBeTruthy();
  });

  it("an empty cache shows skeleton cards, then the templates", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    await renderRouteEmptyCache(PATH, {
      ...routes(),
      [`GET ${ORG}/agent-templates`]: async () => {
        await held;
        return json(200, { templates: [template("t1", "reviewer")] });
      },
    });
    await vi.waitFor(() =>
      expect(document.querySelector('[data-part="card-grid"][aria-busy="true"]')).not.toBeNull(),
    );
    // the head and its tabs stay while the list loads
    expect(screen.getByRole("tab", { name: /Templates/ })).toBeTruthy();
    await act(async () => release());
    expect(await card("reviewer")).toBeTruthy();
  });

  it("a list that cannot be read: the tab says so with 重试, the tabs stay", async () => {
    const r: Routes = {
      ...routes(),
      [`GET ${ORG}/agent-templates`]: () =>
        json(500, { error: { code: "internal", message: "boom" } }),
    };
    stubApi(r);
    await renderRouteWithCache(PATH, r);
    expect(await screen.findByText(en.errors.page.title)).toBeTruthy();
    expect(screen.getByRole("button", { name: en.errors.page.retry })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /Agents/ })).toBeTruthy();
  });
});

describe("/plugins/[itemId]: components and 补充配置", () => {
  const item = (over: Record<string, unknown> = {}) => ({
    id: ITEM,
    name: "docs",
    publisher: "Acme",
    displayName: null,
    description: "Docs helpers",
    scope: "optional",
    builtin: false,
    disabled: false,
    latestVersion: "2.0.0",
    versions: ["2.0.0"],
    source: "file",
    updatedAt: T,
    state: "on",
    switchable: true,
    notDeployed: false,
    installed: { pluginInstallId: "i1", version: "2.0.0", upgradeAvailable: null },
    request: null,
    componentCounts: { extension: 0, skills: 2, connectorTemplates: 1, agentTemplates: 0 },
    sourceFormat: "capybara",
    ...over,
  });
  const tpl = {
    id: "gh",
    displayName: null,
    description: "",
    plugin: "docs",
    connector: "connector-mcp",
    endpoint: { url: "https://gh.example.test/mcp" },
    editableEndpoint: [],
    auth: { type: "bearer" },
    ownership: "org",
  };
  const detail = (over: Record<string, unknown> = {}) => ({
    item: item(over),
    hasIcon: false,
    extension: null,
    templates: [tpl],
    dependencies: [],
    skills: ["skills/pdf", "skills/web"],
    agents: [],
    missingTemplates: over.state === "needs_config" ? [tpl] : [],
  });
  const routes = (over: Record<string, unknown> = {}): Routes => ({
    [`GET ${ORG}/catalog/${ITEM}`]: () => json(200, detail(over)),
    [`GET ${ORG}/catalog`]: () => json(200, { items: [item(over)] }),
    [`GET ${ORG}/plugin-installs`]: () => json(200, { installs: [] }),
    [`GET ${ORG}/extensions`]: () => json(200, { extensions: [] }),
    [`GET ${ORG}/marketplaces/entries`]: () => json(200, { items: [] }),
    [`GET ${ORG}/components?itemId=${ITEM}`]: () =>
      json(200, {
        components: [
          component("p1", "pdf", { on: true }),
          component("p3", "web", { on: true, locked: true, switchable: false }),
        ],
      }),
  });
  const section = () => screen.findByRole("region", { name: C.inOrg });

  beforeEach(() => resetNavigation(`/plugins/${ITEM}`));

  it("lists the plugin's components with their state; an org admin switches one; `all` has none", async () => {
    const r = {
      ...routes(),
      [`PUT ${ORG}/components/skill/p1/switch`]: () =>
        json(200, { preview: { agents: [], connectorsKept: 0 }, confirm: "b".repeat(64) }),
    };
    const calls = stubApi(r);
    await renderRouteWithCache(`/plugins/${ITEM}`, r);
    const s = await section();
    expect(within(s).getByText("pdf")).toBeTruthy();
    expect(within(s).getByText(C.state.platform)).toBeTruthy();
    const buttons = within(s).getAllByRole("button");
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual([`${C.action.disable} pdf`]);
    await userEvent.setup().click(buttons[0] as HTMLElement);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(C.switchOff.noAgents)).toBeTruthy();
    expect(bodyOf(calls.find((c) => c.method === "PUT"))).toEqual({ enabled: false });
  });

  it("members see the states without switches", async () => {
    await renderRouteWithCache(`/plugins/${ITEM}`, routes(), { me: MEMBER });
    const s = await section();
    expect(within(s).getByText("pdf")).toBeTruthy();
    expect(within(s).queryByRole("button")).toBeNull();
  });

  it("an installed needs_config plugin offers 补充配置; the wizard creates the missing connector", async () => {
    const r = {
      ...routes({ state: "needs_config" }),
      [`POST ${ORG}/catalog/${ITEM}/connectors`]: () =>
        json(201, { connectors: [{ templateId: "gh", connectorId: "c9" }] }),
    };
    stubApi(r);
    await renderRouteWithCache(`/plugins/${ITEM}`, r);
    const link = await screen.findByRole("link", { name: en.plugins.action.connectors });
    expect(link.getAttribute("href")).toBe(`/plugins/${ITEM}/connectors`);
    cleanup();
    resetNavigation(`/plugins/${ITEM}/connectors`);
    const calls = stubApi(r);
    const { container } = await renderRouteWithCache(`/plugins/${ITEM}/connectors`, r);
    expect(container.querySelector('[data-template="WizardPage"]')).not.toBeNull();
    const user = userEvent.setup();
    const token = await screen.findByLabelText(/token/i);
    await user.type(token, "secret-token");
    await user.click(screen.getByRole("button", { name: en.catalog.org.install.next }));
    await user.click(await screen.findByRole("button", { name: en.catalog.org.connectors.submit }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    const body = bodyOf(calls.find((c) => c.method === "POST")) as {
      inputs: { connectors: Record<string, { credential?: unknown }> };
    };
    expect(Object.keys(body.inputs.connectors)).toEqual(["gh"]);
    expect(body.inputs.connectors.gh?.credential).toBeDefined();
    await vi.waitFor(() => expect(router.push).toHaveBeenCalledWith(`/plugins/${ITEM}`));
  });
});
