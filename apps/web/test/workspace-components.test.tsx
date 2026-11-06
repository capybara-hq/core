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

describe("/agent-templates", () => {
  beforeEach(() => resetNavigation("/agent-templates"));
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
    ...over,
  });
  const routes = (): Routes => ({
    [`GET ${ORG}/agent-templates`]: () =>
      json(200, {
        templates: [
          template("t1", "reviewer"),
          template("t9", "sales", { plugin: null, type: "sales", origin: "org" }),
        ],
      }),
    [`GET ${ORG}/components?kind=agent_template`]: () =>
      json(200, {
        components: [
          component("t1", "reviewer", { kind: "agent_template", on: true }),
          component("t2", "writer", { kind: "agent_template" }),
        ],
      }),
  });
  const list = () => screen.findByRole("list", { name: en.agentTemplates.listLabel });

  it("lists the org's own and the platform templates; a first render makes no browser read", async () => {
    const browser = expectNoFirstPaintFetch();
    const { container } = await renderRouteWithCache("/agent-templates", routes());
    expect(container.querySelector('[data-template="ListPage"]')).not.toBeNull();
    const l = await list();
    expect(within(l).getByText("reviewer")).toBeTruthy();
    expect(within(l).getByText("sales")).toBeTruthy();
    expect(within(l).getByText("writer")).toBeTruthy();
    expect(within(l).getAllByText(C.origin.platform)).toHaveLength(2);
    expect(within(l).getByText(C.origin.org)).toBeTruthy();
    expect(within(l).getByRole("button", { name: C.action.enable })).toBeTruthy();
    await settle();
    expect(browser).toEqual([]);
  });

  it("members read it without switches", async () => {
    await renderRouteWithCache("/agent-templates", routes(), { me: MEMBER });
    const l = await list();
    expect(within(l).getByText("writer")).toBeTruthy();
    expect(within(l).queryByRole("button")).toBeNull();
  });

  it("an org admin switches a platform template on", async () => {
    const r = {
      ...routes(),
      [`PUT ${ORG}/components/agent_template/t2/switch`]: () =>
        json(200, { component: component("t2", "writer", { kind: "agent_template", on: true }) }),
    };
    const calls = stubApi(r);
    await renderRouteWithCache("/agent-templates", r);
    await userEvent
      .setup()
      .click(within(await list()).getByRole("button", { name: C.action.enable }));
    await vi.waitFor(() =>
      expect(calls.some((c) => c.method === "PUT" && c.url.endsWith("/t2/switch"))).toBe(true),
    );
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
