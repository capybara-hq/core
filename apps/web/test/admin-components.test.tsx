// The admin console's platform components (plugin scope phase 2, Task 9; spec §9): the 技能 /
// 连接器模板 / 智能体模板 lists and details (scope with its impact preview, 跟随插件, disable,
// versions, a new version uploaded on its own), the plugin detail's scope column and the platform
// plugin update preview (spec §7.1), and the plugin scope preview's replaced and conflicting items.
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { bodyOf, type Call, json, stubApi } from "./support/api";
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

const C = en.adminComponents;
const U = en.catalog.update;
const fill = (s: string, vars: Record<string, string | number>) =>
  s.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k]));
const template = (name: string) => document.querySelector(`[data-template="${name}"]`);
const escapeRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const settle = () => act(() => new Promise((r) => setTimeout(r, 20)));
const T = "2026-11-06T00:00:00.000Z";
const ITEM = "11111111-1111-4111-8111-111111111111";

const ORGS = {
  orgs: [
    { id: "o1", slug: "acme", name: "Acme", memberCount: 3, createdAt: T },
    { id: "o2", slug: "beta", name: "Beta", memberCount: 4, createdAt: T },
  ],
};

const comp = (over: Record<string, unknown> = {}) => ({
  kind: "skill",
  id: "s1",
  name: "web-research",
  description: "Research the web",
  plugin: "jina",
  itemId: ITEM,
  owner: { kind: "platform" },
  shareable: false,
  promoted: false,
  builtin: false,
  scopeMode: "follow",
  scope: "optional",
  orgs: [],
  disabled: false,
  pluginStopped: false,
  shownToOthers: true,
  version: "2",
  onIn: ["o1", "o2"],
  ...over,
});
const SKILLS = [
  comp(),
  comp({
    id: "s2",
    name: "notes",
    description: "Take notes",
    plugin: null,
    itemId: null,
    scopeMode: "own",
    scope: "named",
    orgs: ["o1"],
    version: "1",
    onIn: ["o1"],
  }),
  comp({
    id: "s3",
    name: "summarize",
    scopeMode: "own",
    scope: "all",
    offCount: 2,
    onIn: ["o1", "o2"],
  }),
  // an org's own skill (ruling P2-11): read-only here
  comp({
    id: "s4",
    name: "house-style",
    description: "Our style",
    plugin: null,
    itemId: null,
    owner: { kind: "org", orgId: "o1", name: "Acme" },
    scopeMode: "own",
    scope: "named",
    orgs: ["o1"],
    shownToOthers: false,
    version: "3",
    onIn: ["o1"],
  }),
  comp({ id: "s5", name: "base-chat", plugin: "openai-compatible", builtin: true, scope: "all" }),
];
const TEMPLATES = [
  comp({ kind: "connector_template", id: "c1", name: "gh", description: null, version: "1.2.0" }),
];
const AGENTS = [comp({ kind: "agent_template", id: "a1", name: "researcher", version: "1" })];

const base: Routes = {
  // the skill upload checks the session first
  "GET /api/v1/me": () => json(200, ME),
  "GET /api/v1/admin/orgs": () => json(200, ORGS),
  "GET /api/v1/admin/components?kind=skill": () => json(200, { components: SKILLS }),
  "GET /api/v1/admin/components?kind=connector_template": () =>
    json(200, { components: TEMPLATES }),
  "GET /api/v1/admin/components?kind=agent_template": () => json(200, { components: AGENTS }),
  "GET /api/v1/admin/components/skill/s1/versions": () =>
    json(200, {
      versions: [
        { version: "2", catalogVersion: null, updatedOnOwn: true, createdAt: T },
        { version: "1", catalogVersion: "1.2.0", updatedOnOwn: false, createdAt: T },
      ],
    }),
  "GET /api/v1/admin/components/skill/s2/versions": () =>
    json(200, {
      versions: [{ version: "1", catalogVersion: null, updatedOnOwn: false, createdAt: T }],
    }),
  "GET /api/v1/admin/components/skill/s3/versions": () =>
    json(200, {
      versions: [{ version: "1", catalogVersion: "1.2.0", updatedOnOwn: false, createdAt: T }],
    }),
  "GET /api/v1/admin/components/skill/s4/versions": () =>
    json(200, {
      versions: [{ version: "3", catalogVersion: null, updatedOnOwn: false, createdAt: T }],
    }),
  "GET /api/v1/admin/components/skill/s5/versions": () =>
    json(200, {
      versions: [{ version: "1", catalogVersion: "0.1.0", updatedOnOwn: false, createdAt: T }],
    }),
  "GET /api/v1/admin/components/agent_template/a1/versions": () =>
    json(200, {
      versions: [{ version: "1", catalogVersion: "1.2.0", updatedOnOwn: false, createdAt: T }],
    }),
};

beforeEach(() => {
  resetNavigation("/");
  window.history.replaceState(null, "", "/");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Stubs the browser with `base` plus `routes` and renders `path` as a first load. */
async function open(path: string, routes: Routes = {}) {
  const all = { ...base, ...routes };
  const calls = stubApi(all);
  await renderRouteWithCache(path, all);
  return calls;
}
const put = (calls: Call[], suffix: string) =>
  calls.filter((c) => c.method === "PUT" && c.url.endsWith(suffix));

/** A long, multi-line description: detail pages show it in full (fix round 1). */
const LONG =
  "Use when a meeting ends.\nIt writes the minutes, lists the decisions and the follow-ups, and names who owns each one, so nothing said in the room is lost on the way out of it.";

describe("admin component lists", () => {
  it("/admin/skills: name, 来自, 归属, 范围, 版本 and the orgs using it; a first render makes no browser read", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRouteWithCache("/admin/skills", base);
    const table = await screen.findByRole("table", { name: C.titles.skill });
    const row = (name: string) => within(table).getByText(name).closest("tr") as HTMLElement;
    // headers
    for (const h of Object.values(C.columns)) expect(within(table).getByText(h)).toBeTruthy();
    // from a plugin: links to it; follows the plugin's scope
    const research = row("web-research");
    expect(within(research).getByRole("link", { name: "jina" }).getAttribute("href")).toBe(
      `/admin/plugins/${ITEM}`,
    );
    expect(within(research).getByRole("link", { name: "web-research" }).getAttribute("href")).toBe(
      "/admin/skills/s1",
    );
    expect(within(research).getByText(C.owner.platform)).toBeTruthy();
    expect(
      within(research).getByText(fill(C.scopeFollow, { scope: en.catalog.scope.optional })),
    ).toBeTruthy();
    expect(within(research).getByText("v2")).toBeTruthy();
    expect(within(research).getByText("2 orgs using it")).toBeTruthy();
    // no plugin, its own named scope
    const notes = row("notes");
    expect(within(notes).getByText(C.from.none)).toBeTruthy();
    expect(
      within(notes).getByText(
        fill(C.scopeOwn, { scope: fill(en.catalog.admin.meta.named, { orgs: "Acme" }) }),
      ),
    ).toBeTruthy();
    // `all` with two orgs having turned it off says so (the row's cell)
    expect(
      within(row("summarize")).getByText(
        fill(C.scopeOwn, { scope: fill(en.catalog.admin.meta.allOff, { n: 2 }) }),
      ),
    ).toBeTruthy();
    await settle();
    expect(browser).toEqual([]);
  });

  it("tabs 全部 / 平台 / 组织创建 filter the rows; an org's own skill names its org as the owner", async () => {
    await open("/admin/skills");
    const table = await screen.findByRole("table", { name: C.titles.skill });
    const tab = (label: string) =>
      screen.getByRole("tab", { name: new RegExp(`^${label}`) }) as HTMLElement;
    expect(tab(C.tabs.all).textContent).toMatch(/5/);
    expect(tab(C.tabs.platform).textContent).toMatch(/4/);
    expect(tab(C.tabs.org).textContent).toMatch(/1/);
    const own = within(table).getByText("house-style").closest("tr") as HTMLElement;
    expect(within(own).getByText("Acme")).toBeTruthy();
    expect(within(own).queryByText(C.owner.platform)).toBeNull();
    const builtin = within(table).getByText("base-chat").closest("tr") as HTMLElement;
    expect(within(builtin).getByText(C.state.builtin)).toBeTruthy();
    const user = userEvent.setup();
    await user.click(tab(C.tabs.org));
    expect(within(table).getByText("house-style")).toBeTruthy();
    expect(within(table).queryByText("web-research")).toBeNull();
    await user.click(tab(C.tabs.platform));
    expect(within(table).queryByText("house-style")).toBeNull();
    expect(within(table).getByText("web-research")).toBeTruthy();
  });

  it("/admin/connector-templates lists the deployment's connector templates (a table)", async () => {
    await open("/admin/connector-templates");
    const table = await screen.findByRole("table", { name: C.titles.connector_template });
    expect(within(table).getByText("gh")).toBeTruthy();
    expect(within(table).getByText(C.owner.platform)).toBeTruthy();
  });

  it("/admin/agent-templates: cards with source · owner · scope · v, the primary 查看 and ⋯ (ruling P4-17)", async () => {
    await open("/admin/agent-templates");
    expect(screen.queryByRole("table")).toBeNull();
    const grid = await screen.findByRole("list", { name: C.titles.agent_template });
    expect(grid.getAttribute("data-part")).toBe("card-grid");
    const card = within(grid)
      .getByRole("link", { name: "researcher" })
      .closest("li") as HTMLElement;
    expect(within(card).getByRole("link", { name: "researcher" }).getAttribute("href")).toBe(
      "/admin/agent-templates/a1",
    );
    expect(within(card).getByRole("link", { name: C.view }).getAttribute("href")).toBe(
      "/admin/agent-templates/a1",
    );
    const meta = card.querySelector('[data-part="object-card-meta"]')?.textContent ?? "";
    expect(meta).toContain(`${C.owner.platform} · `);
    expect(meta).toMatch(/· v1$/);
    // ⋯: 设置范围 and 停用 (上传新版本 stays on the detail)
    const user = userEvent.setup();
    await user.click(within(card).getByRole("button", { name: "More actions" }));
    expect((await screen.findAllByRole("menuitem")).map((i) => i.textContent)).toEqual([
      C.detail.actions.scope,
      C.detail.actions.disable,
    ]);
    await user.click(screen.getByRole("menuitem", { name: C.detail.actions.scope }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  it("/admin/agent-templates: skeleton cards while loading, then the cards", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    await renderRouteEmptyCache("/admin/agent-templates", {
      ...base,
      "GET /api/v1/admin/components?kind=agent_template": async () => {
        await gate;
        return json(200, { components: AGENTS });
      },
    });
    await vi.waitFor(() =>
      expect(document.querySelector('[data-part="card-grid"][aria-busy="true"]')).not.toBeNull(),
    );
    await act(async () => release());
    expect(await screen.findByRole("link", { name: "researcher" })).toBeTruthy();
  });

  it("/admin/agent-templates: none at all, and none under the open tab", async () => {
    await open("/admin/agent-templates", {
      ...base,
      "GET /api/v1/admin/components?kind=agent_template": () => json(200, { components: [] }),
    });
    expect(await screen.findByText(C.empty.agent_template)).toBeTruthy();
    cleanup();
    await open("/admin/agent-templates");
    await screen.findByRole("link", { name: "researcher" });
    await userEvent.setup().click(screen.getByRole("tab", { name: new RegExp(`^${C.tabs.org}`) }));
    expect(screen.getByText(C.emptyTab.agent_template)).toBeTruthy();
  });

  it("zh copy: 技能 / 来自 / 归属 / 平台 / 跟随插件", async () => {
    stubApi(base);
    await renderRouteWithCache("/admin/skills", base, { locale: "zh" });
    const table = await screen.findByRole("table", { name: "技能" });
    expect(within(table).getByText("来自")).toBeTruthy();
    expect(within(table).getByText("归属")).toBeTruthy();
    expect(within(table).getAllByText("平台").length).toBeGreaterThan(0);
    expect(within(table).getByText("组织自选 · 跟随插件")).toBeTruthy();
    expect(zh.adminComponents.titles.agent_template).toBe("智能体模板");
  });

  it("an empty cache shows the template's loading state, then the data", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    await renderRouteEmptyCache("/admin/skills", {
      ...base,
      "GET /api/v1/admin/components?kind=skill": async () => {
        await gate;
        return json(200, { components: SKILLS });
      },
    });
    await vi.waitFor(() => {
      if (template("ListPage") === null) throw new Error("no page");
    });
    expect(document.querySelector("[aria-busy='true']")).not.toBeNull();
    expect(screen.queryByText("web-research")).toBeNull();
    await act(async () => release());
    expect(await screen.findByText("web-research")).toBeTruthy();
  });
});

describe("admin component detail", () => {
  it("shows the facts and the versions, marking one updated on its own", async () => {
    await open("/admin/skills/s1");
    expect(await screen.findByRole("heading", { name: "web-research" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "jina" }).getAttribute("href")).toBe(
      `/admin/plugins/${ITEM}`,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: new RegExp(C.detail.tabs.versions) }));
    const table = screen.getByRole("table", { name: C.detail.tabs.versions });
    const v2 = within(table).getByText("v2").closest("tr") as HTMLElement;
    expect(within(v2).getByText(C.detail.origin.own)).toBeTruthy();
    const v1 = within(table).getByText("v1").closest("tr") as HTMLElement;
    expect(within(v1).getByText(fill(C.detail.origin.plugin, { version: "v1.2.0" }))).toBeTruthy();
  });

  it.each([
    ["/admin/skills/s1", "web-research", "skill"],
    ["/admin/connector-templates/c1", "gh", "connector_template"],
    ["/admin/agent-templates/a1", "researcher", "agent_template"],
  ] as const)(
    "%s: one centred column, the full description first, the facts as a KeyValue",
    async (path, name, kind) => {
      const list = { skill: SKILLS, connector_template: TEMPLATES, agent_template: AGENTS }[kind];
      await open(path, {
        "GET /api/v1/admin/components/connector_template/c1/versions": () =>
          json(200, { versions: [] }),
        [`GET /api/v1/admin/components?kind=${kind}`]: () =>
          json(200, { components: list.map((c) => ({ ...c, description: LONG })) }),
      });
      expect(await screen.findByRole("heading", { name })).toBeTruthy();
      // No right inspector
      expect(document.querySelector(".cb-body")?.getAttribute("data-layout")).toBe("single");
      // The head carries no description: the full text (line breaks kept) is the first block
      expect(document.querySelector('[data-part="page-header-description"]')).toBeNull();
      const first = document.querySelector('[data-part="content"] > .cb-stack')?.firstElementChild;
      expect(first?.textContent).toBe(LONG);
      expect(first?.getAttribute("data-pre")).toBe("true");
      const facts = document.querySelector('[data-part="content"] [data-part="key-value"]');
      expect(facts?.textContent).toContain(C.detail.fields.owner);
      expect(facts?.textContent).toContain(C.detail.fields.scope);
    },
  );

  it("设置范围: previews the agents losing it and the connectors kept, then confirms with the scopeHash", async () => {
    const calls = await open("/admin/skills/s1", {
      "POST /api/v1/admin/components/skill/s1/scope/preview": () =>
        json(200, {
          affected: [
            {
              orgId: "o1",
              orgName: "Acme",
              agents: [{ id: "ag1", name: "Researcher" }],
              connectorsKept: 2,
            },
          ],
          conflicts: [],
          scopeHash: "h1",
        }),
      "PUT /api/v1/admin/components/skill/s1/scope": () =>
        json(200, comp({ scopeMode: "own", scope: "named", orgs: ["o2"] })),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: C.detail.actions.scope }));
    const dialog = await screen.findByRole("dialog");
    // a component of a plugin starts on 跟随插件
    const follow = within(dialog).getByRole("radio", { name: new RegExp(C.scopeDialog.follow) });
    expect((follow as HTMLInputElement).checked).toBe(true);
    await user.click(
      within(dialog).getByRole("radio", { name: new RegExp(en.catalog.scope.named) }),
    );
    await user.click(await within(dialog).findByRole("checkbox", { name: "Beta" }));
    await user.click(
      within(dialog).getByRole("button", { name: en.catalog.admin.scopeDialog.next }),
    );
    expect(await within(dialog).findByText("Acme")).toBeTruthy();
    expect(within(dialog).getByText(/Researcher/)).toBeTruthy();
    expect(within(dialog).getByText(/The 2 connectors it created stay/)).toBeTruthy();
    expect(bodyOf(calls.find((c) => c.url.endsWith("/scope/preview")))).toEqual({
      scope: "named",
      orgs: ["o2"],
    });
    await user.click(
      within(dialog).getByRole("button", { name: en.catalog.admin.scopeDialog.confirm }),
    );
    await waitFor(() => expect(put(calls, "/scope")).toHaveLength(1));
    expect(bodyOf(put(calls, "/scope")[0])).toEqual({
      scope: "named",
      orgs: ["o2"],
      scopeHash: "h1",
    });
    // the list is read again
    await waitFor(() =>
      expect(
        calls.filter((c) => c.method === "GET" && c.url.endsWith("/components?kind=skill")).length,
      ).toBeGreaterThan(0),
    );
  });

  it("an own-scoped component goes back to 跟随插件 with { follow: true }; a stale hash previews again", async () => {
    let previews = 0;
    let puts = 0;
    const calls = await open("/admin/skills/s3", {
      "POST /api/v1/admin/components/skill/s3/scope/preview": () => {
        previews += 1;
        return json(200, { affected: [], conflicts: [], scopeHash: `h${previews}` });
      },
      "PUT /api/v1/admin/components/skill/s3/scope": () => {
        puts += 1;
        return puts === 1
          ? json(409, { error: { code: "plugin.scope_stale", message: "x" } })
          : json(200, comp({ id: "s3", name: "summarize" }));
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: C.detail.actions.scope }));
    const dialog = await screen.findByRole("dialog");
    const all = within(dialog).getByRole("radio", { name: new RegExp(en.catalog.scope.all) });
    expect((all as HTMLInputElement).checked).toBe(true);
    await user.click(within(dialog).getByRole("radio", { name: new RegExp(C.scopeDialog.follow) }));
    await user.click(
      within(dialog).getByRole("button", { name: en.catalog.admin.scopeDialog.next }),
    );
    expect(await within(dialog).findByText(en.catalog.admin.impact.none)).toBeTruthy();
    expect(bodyOf(calls.find((c) => c.url.endsWith("/scope/preview")))).toEqual({ follow: true });
    const confirm = () =>
      user.click(
        within(dialog).getByRole("button", { name: en.catalog.admin.scopeDialog.confirm }),
      );
    await confirm();
    expect(await within(dialog).findByText(en.catalog.admin.scopeDialog.stale)).toBeTruthy();
    await confirm();
    await waitFor(() => expect(put(calls, "/scope")).toHaveLength(2));
    expect(bodyOf(put(calls, "/scope")[1])).toEqual({ follow: true, scopeHash: "h2" });
  });

  it("a component without a plugin has no 跟随插件; name clashes block the confirm", async () => {
    await open("/admin/skills/s2", {
      "POST /api/v1/admin/components/skill/s2/scope/preview": () =>
        json(200, {
          affected: [],
          conflicts: [{ orgId: "o2", orgName: "Beta", name: "notes", skills: ["k1"], plugins: [] }],
          scopeHash: "h1",
        }),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: C.detail.actions.scope }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).queryByRole("radio", { name: new RegExp(C.scopeDialog.follow) }),
    ).toBeNull();
    await user.click(within(dialog).getByRole("radio", { name: new RegExp(en.catalog.scope.all) }));
    await user.click(
      within(dialog).getByRole("button", { name: en.catalog.admin.scopeDialog.next }),
    );
    expect(await within(dialog).findByText(en.catalog.admin.impact.conflicts)).toBeTruthy();
    expect(
      within(dialog).getByText(
        fill(en.catalog.admin.impact.conflictLine, { org: "Beta", name: "notes" }),
      ),
    ).toBeTruthy();
    const confirm = within(dialog).getByRole("button", {
      name: en.catalog.admin.scopeDialog.confirm,
    }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
  });

  it("停用 previews the impact and sends its hash; 启用 sends no hash", async () => {
    const calls = await open("/admin/skills/s1", {
      "POST /api/v1/admin/components/skill/s1/scope/preview": () =>
        json(200, {
          affected: [{ orgId: "o1", orgName: "Acme", agents: [], connectorsKept: 0 }],
          conflicts: [],
          scopeHash: "d1",
        }),
      "PUT /api/v1/admin/components/skill/s1/disabled": () => json(200, comp({ disabled: true })),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: C.detail.actions.disable }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("Acme")).toBeTruthy();
    expect(bodyOf(calls.find((c) => c.url.endsWith("/scope/preview")))).toEqual({ disabled: true });
    await user.click(within(dialog).getByRole("button", { name: C.disableDialog.confirm }));
    await waitFor(() => expect(put(calls, "/disabled")).toHaveLength(1));
    expect(bodyOf(put(calls, "/disabled")[0])).toEqual({ disabled: true, scopeHash: "d1" });
  });

  it("上传新版本: a skill's zip is sent as the raw body", async () => {
    const calls = await open("/admin/skills/s1", {
      "POST /api/v1/admin/components/skill/s1/versions": () =>
        json(201, { kind: "skill", id: "s1", name: "web-research", version: 3 }),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: C.detail.actions.upload }));
    const dialog = await screen.findByRole("dialog");
    const input = dialog.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File([new Uint8Array([80, 75, 3, 4])], "web-research.zip");
    await user.upload(input, file);
    expect(within(dialog).getByText("web-research.zip")).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: C.upload.confirm }));
    await waitFor(() =>
      expect(calls.filter((c) => c.method === "POST" && c.url.endsWith("/versions"))).toHaveLength(
        1,
      ),
    );
    const post = calls.find((c) => c.method === "POST" && c.url.endsWith("/versions"));
    expect(post?.headers.get("content-type")).toBe("application/octet-stream");
    expect(post?.body).toBe(file);
    expect(
      await screen.findByText(fill(C.upload.done, { name: "web-research", version: "v3" })),
    ).toBeTruthy();
  });

  it("上传新版本: an agent template's markdown is sent as { content }", async () => {
    const calls = await open("/admin/agent-templates/a1", {
      "POST /api/v1/admin/components/agent_template/a1/versions": () =>
        json(201, { kind: "agent_template", id: "a1", name: "researcher", version: 2 }),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: C.detail.actions.upload }));
    const dialog = await screen.findByRole("dialog");
    const input = dialog.querySelector('input[type="file"]') as HTMLInputElement;
    const md = "---\nname: researcher\ndescription: R.\n---\nResearch.\n";
    await user.upload(input, new File([md], "researcher.md", { type: "text/markdown" }));
    await user.click(within(dialog).getByRole("button", { name: C.upload.confirm }));
    await waitFor(() =>
      expect(calls.filter((c) => c.method === "POST" && c.url.endsWith("/versions"))).toHaveLength(
        1,
      ),
    );
    expect(bodyOf(calls.find((c) => c.method === "POST" && c.url.endsWith("/versions")))).toEqual({
      content: md,
    });
  });

  it("a component of a builtin plugin has the 内置 chip and no 设置范围 or 停用", async () => {
    await open("/admin/skills/s5");
    expect(await screen.findByRole("heading", { name: "base-chat" })).toBeTruthy();
    expect(screen.getAllByText(C.state.builtin).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: C.detail.actions.scope })).toBeNull();
    expect(screen.queryByRole("button", { name: C.detail.actions.disable })).toBeNull();
    // the kernel takes a new version of it like any platform skill
    expect(screen.getByRole("button", { name: C.detail.actions.upload })).toBeTruthy();
  });

  it("an org's own skill that its org does not share: its org as the owner, the reason, no actions", async () => {
    await open("/admin/skills/s4");
    expect(await screen.findByRole("heading", { name: "house-style" })).toBeTruthy();
    expect(screen.getAllByText("Acme").length).toBeGreaterThan(0);
    expect(screen.getByText(fill(C.detail.orgOwnedNote, { org: "Acme" }))).toBeTruthy();
    expect(screen.getAllByText(C.share.notShareable).length).toBeGreaterThan(0);
    for (const a of [
      C.share.show,
      C.detail.actions.scope,
      C.detail.actions.disable,
      C.detail.actions.upload,
    ]) {
      expect(screen.queryByRole("button", { name: a })).toBeNull();
    }
  });

  it("a connector template has no 上传新版本", async () => {
    await open("/admin/connector-templates/c1", {
      "GET /api/v1/admin/components/connector_template/c1/versions": () =>
        json(200, {
          versions: [
            { version: "1.2.0", catalogVersion: "1.2.0", updatedOnOwn: false, createdAt: T },
          ],
        }),
    });
    expect(await screen.findByRole("button", { name: C.detail.actions.scope })).toBeTruthy();
    expect(screen.queryByRole("button", { name: C.detail.actions.upload })).toBeNull();
  });
});

describe("admin plugin detail: components and the platform update", () => {
  const item = {
    id: ITEM,
    name: "jina",
    publisher: "Jina AI",
    displayName: null,
    description: "Web tools",
    descriptionZh: null,
    policy: "allow",
    scope: "optional",
    scopeOrgs: [],
    builtin: false,
    disabled: false,
    shownToOthers: true,
    enabledOrgs: 2,
    pending: false,
    permissionsHash: null,
    latestVersion: "1.3.0",
    versions: ["1.3.0", "1.2.0"],
    installs: 2,
    source: "marketplace",
    marketplaceId: "official",
    latestMarketplaceVersion: "1.3.0",
    newerInMarketplace: false,
    contentChanged: false,
    componentCounts: { extension: 1, skills: 2, connectorTemplates: 1, agentTemplates: 1 },
    sourceFormat: "capybara",
    updatedAt: T,
    packageName: "@jina-ai/capybara-plugin",
    deletedAt: null,
    platformVersion: "1.2.0",
  };
  const manifest = (version: string) => ({
    name: "jina",
    version,
    publisher: "Jina AI",
    description: "",
    extension: {
      entry: "dist/index.js",
      manifest: {
        name: "jina-web",
        version,
        sdk: "^0.1.0",
        provides: [],
        requires: [],
        optional: [],
        permissions: {},
      },
    },
    skills: [{ path: "./skills/web-research" }, { path: "./skills/summarize" }],
    connectorTemplates: [{ path: "./connectors/gh.json" }],
    agents: [{ path: "./agents/researcher.md" }],
  });
  const version = (v: string) => ({
    version: v,
    source: "marketplace",
    sourceRef: "official",
    integrity: null,
    contentDigest: null,
    sourceDetail: null,
    manifest: manifest(v),
    size: 1024,
    extensionSha256: null,
    importedAt: T,
    sourceFormat: "capybara",
    translation: null,
    licenseText: null,
    licenseTruncated: false,
  });
  const PREVIEW = {
    itemId: ITEM,
    name: "jina",
    from: "1.2.0",
    to: "1.3.0",
    components: [
      {
        kind: "skill",
        id: "s1",
        name: "web-research",
        change: "upgrade",
        from: "1.2.0",
        to: "1.3.0",
        updatedOnOwn: true,
        ownScope: false,
        pinnedOrgs: ["o1"],
      },
      {
        kind: "skill",
        id: "s3",
        name: "summarize",
        change: "upgrade",
        from: "1.2.0",
        to: "1.3.0",
        updatedOnOwn: false,
        ownScope: true,
        pinnedOrgs: [],
      },
      {
        kind: "agent_template",
        id: "a9",
        name: "old-helper",
        change: "removed",
        from: "1.2.0",
        to: null,
        updatedOnOwn: false,
        ownScope: false,
        pinnedOrgs: [],
        kept: [{ orgId: "o1", agents: [{ id: "ag1", name: "Helper" }] }],
      },
    ],
    extension: { from: "1.2.0", to: "1.3.0", orgs: ["o1", "o2"], needsApproval: true },
    connectorOrgs: [
      {
        orgId: "o2",
        connectors: [{ id: "k1", name: "GitHub", templateId: "gh", credentialsReset: true }],
        needsConfig: ["linear"],
      },
    ],
    diffHash: "d".repeat(64),
  };
  const routes = (over: Routes = {}): Routes => ({
    "GET /api/v1/admin/catalog/items": () => json(200, { items: [item], nextOffset: null }),
    [`GET /api/v1/admin/catalog/items/${ITEM}`]: () =>
      json(200, { item, versions: [version("1.3.0"), version("1.2.0")], hasIcon: false }),
    "GET /api/v1/admin/marketplaces": () => json(200, { offline: false, items: [] }),
    ...over,
  });

  it("the components table has a scope column: 跟随插件 or the component's own, linking each component", async () => {
    await open(`/admin/plugins/${ITEM}`, routes());
    const table = await screen.findByRole("table", {
      name: en.catalog.admin.detail.tabs.components,
    });
    const row = (name: string) => within(table).getByText(name).closest("tr") as HTMLElement;
    expect(within(table).getByText(en.catalog.admin.detail.componentColumns.scope)).toBeTruthy();
    expect(within(row("jina-web")).getByText(C.follow)).toBeTruthy();
    expect(within(row("web-research")).getByText(C.follow)).toBeTruthy();
    expect(
      within(row("summarize")).getByText(
        fill(C.scopeOwn, { scope: fill(en.catalog.admin.meta.allOff, { n: 2 }) }),
      ),
    ).toBeTruthy();
    expect(
      within(row("summarize")).getByRole("link", { name: "summarize" }).getAttribute("href"),
    ).toBe("/admin/skills/s3");
    expect(within(row("gh")).getByRole("link", { name: "gh" }).getAttribute("href")).toBe(
      "/admin/connector-templates/c1",
    );
    expect(
      within(row("researcher")).getByRole("link", { name: "researcher" }).getAttribute("href"),
    ).toBe("/admin/agent-templates/a1");
  });

  it("更新到 x previews each component with its marks, the extension and the orgs' connectors, then confirms with diffHash; a stale hash previews again", async () => {
    let previews = 0;
    let puts = 0;
    const calls = await open(
      `/admin/plugins/${ITEM}`,
      routes({
        [`POST /api/v1/admin/catalog/items/${ITEM}/update/preview`]: () => {
          previews += 1;
          return json(200, { ...PREVIEW, diffHash: String(previews).repeat(64) });
        },
        [`PUT /api/v1/admin/catalog/items/${ITEM}/update`]: () => {
          puts += 1;
          return puts === 1
            ? json(409, { error: { code: "plugin.upgrade_stale", message: "x" } })
            : json(200, {
                itemId: ITEM,
                version: "1.3.0",
                components: PREVIEW.components,
                extension: PREVIEW.extension,
                connectorOrgs: PREVIEW.connectorOrgs,
              });
        },
      }),
    );
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", {
        name: fill(en.catalog.admin.detail.actions.update, { version: "v1.3.0" }),
      }),
    );
    const dialog = await screen.findByRole("dialog");
    // the plugin's move, then each component's
    expect(
      (await within(dialog).findAllByText(fill(U.versions, { from: "v1.2.0", to: "v1.3.0" })))
        .length,
    ).toBeGreaterThan(1);
    expect(bodyOf(calls.find((c) => c.url.endsWith("/update/preview")))).toEqual({
      version: "1.3.0",
    });
    const table = within(dialog).getByRole("table", { name: U.components });
    const row = (name: string) => within(table).getByText(name).closest("tr") as HTMLElement;
    expect(within(row("web-research")).getByText(U.marks.updatedOnOwn)).toBeTruthy();
    expect(within(row("web-research")).getByText(U.change.upgrade)).toBeTruthy();
    expect(within(row("summarize")).getByText(U.marks.ownScope)).toBeTruthy();
    expect(within(row("old-helper")).getByText(U.marks.kept)).toBeTruthy();
    expect(within(row("old-helper")).getByText(U.change.removed)).toBeTruthy();
    expect(
      within(dialog).getByText(fill(U.pinned, { name: "web-research", orgs: "Acme" })),
    ).toBeTruthy();
    expect(
      within(dialog).getByText(fill(U.keptLine, { name: "old-helper", agents: "Helper" })),
    ).toBeTruthy();
    expect(
      within(dialog).getByText(
        fill(U.extension, { from: "v1.2.0", to: "v1.3.0", orgs: "Acme, Beta" }),
      ),
    ).toBeTruthy();
    expect(within(dialog).getByText(U.needsApproval)).toBeTruthy();
    expect(
      within(dialog).getByText(fill(U.credentialsReset, { org: "Beta", names: "GitHub" })),
    ).toBeTruthy();
    expect(
      within(dialog).getByText(fill(U.needsConfig, { org: "Beta", ids: "linear" })),
    ).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: U.confirm }));
    expect(await within(dialog).findByText(U.stale)).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: U.confirm }));
    await waitFor(() => expect(put(calls, "/update")).toHaveLength(2));
    expect(bodyOf(put(calls, "/update")[0])).toEqual({
      version: "1.3.0",
      diffHash: "1".repeat(64),
    });
    expect(bodyOf(put(calls, "/update")[1])).toEqual({
      version: "1.3.0",
      diffHash: "2".repeat(64),
    });
    expect(await screen.findByText(fill(U.done, { name: "jina", version: "v1.3.0" }))).toBeTruthy();
  });

  it("the platform on the newest version offers no update; a newer marketplace version is imported first", async () => {
    await open(
      `/admin/plugins/${ITEM}`,
      routes({
        [`GET /api/v1/admin/catalog/items/${ITEM}`]: () =>
          json(200, {
            item: {
              ...item,
              platformVersion: "1.3.0",
              newerInMarketplace: true,
              latestMarketplaceVersion: "1.4.0",
            },
            versions: [version("1.3.0"), version("1.2.0")],
            hasIcon: false,
          }),
      }),
    );
    expect(
      await screen.findByRole("button", {
        name: fill(en.catalog.admin.detail.actions.import, { version: "v1.4.0" }),
      }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", {
        name: fill(en.catalog.admin.detail.actions.update, { version: "v1.3.0" }),
      }),
    ).toBeNull();
  });

  it("更新到 picks the highest version, and offers none when the versions do not compare", async () => {
    const detailWith = (versions: string[]) => () =>
      json(200, {
        item: { ...item, versions, latestVersion: versions[0] },
        versions: versions.map(version),
        hasIcon: false,
      });
    await open(
      `/admin/plugins/${ITEM}`,
      routes({ [`GET /api/v1/admin/catalog/items/${ITEM}`]: detailWith(["1.2.0", "1.10.0"]) }),
    );
    expect(
      await screen.findByRole("button", {
        name: fill(en.catalog.admin.detail.actions.update, { version: "v1.10.0" }),
      }),
    ).toBeTruthy();
    cleanup();
    await open(
      `/admin/plugins/${ITEM}`,
      routes({ [`GET /api/v1/admin/catalog/items/${ITEM}`]: detailWith(["nightly", "1.2.0"]) }),
    );
    await screen.findByRole("button", { name: en.catalog.admin.detail.actions.scope });
    expect(
      screen.queryByRole("button", {
        name: new RegExp(escapeRe(en.catalog.admin.detail.actions.update.split("{")[0] ?? "")),
      }),
    ).toBeNull();
  });

  it.each([
    [
      { reason: "same_version", version: "1.3.0" },
      fill(en.catalog.errorDetail.sameVersion, { version: "v1.3.0" }),
    ],
    [
      { reason: "config_extension", deploymentVersion: "1.2.0" },
      fill(en.catalog.errorDetail.configExtension, { version: "v1.2.0" }),
    ],
    [
      { reason: "config_extension", deploymentVersion: null },
      en.catalog.errorDetail.configExtensionUnloaded,
    ],
    [
      { reason: "extension_removed", version: "1.3.0" },
      fill(en.catalog.errorDetail.extensionRemoved, { version: "v1.3.0" }),
    ],
    [
      { reason: "extension_package", version: "1.3.0" },
      fill(en.catalog.errorDetail.extensionPackage, { version: "v1.3.0" }),
    ],
    [
      { reason: "dependent_range", dependent: "crm", range: "^1.2.0", version: "1.3.0" },
      fill(en.catalog.errorDetail.dependentRange, {
        dependent: "crm",
        range: "^1.2.0",
        version: "v1.3.0",
      }),
    ],
  ])("a refused update says why in the dialog (%o)", async (detail, line) => {
    await open(
      `/admin/plugins/${ITEM}`,
      routes({
        [`POST /api/v1/admin/catalog/items/${ITEM}/update/preview`]: () =>
          json(409, {
            error: { code: "plugin.upgrade_target_invalid", message: "x", details: [detail] },
          }),
      }),
    );
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", {
        name: fill(en.catalog.admin.detail.actions.update, { version: "v1.3.0" }),
      }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText(en.errors.plugin.upgrade_target_invalid)).toBeTruthy();
    expect(within(dialog).getByText(line)).toBeTruthy();
  });

  it("设置范围 on a plugin lists the components whose own scope it replaces and refuses name clashes", async () => {
    await open(
      `/admin/plugins/${ITEM}`,
      routes({
        [`POST /api/v1/admin/catalog/items/${ITEM}/scope/preview`]: () =>
          json(200, {
            affected: [],
            needsConfig: [],
            replaced: [{ kind: "skill", id: "s3", name: "summarize" }],
            conflicts: [
              { orgId: "o2", orgName: "Beta", name: "web-research", skills: ["k"], plugins: [] },
            ],
            scopeHash: "h1",
          }),
      }),
    );
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: en.catalog.admin.detail.actions.scope }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("radio", { name: new RegExp(en.catalog.scope.all) }));
    await user.click(
      within(dialog).getByRole("button", { name: en.catalog.admin.scopeDialog.next }),
    );
    expect(
      await within(dialog).findByText(
        fill(en.catalog.admin.impact.replaced, { names: "summarize" }),
      ),
    ).toBeTruthy();
    expect(
      within(dialog).getByText(
        fill(en.catalog.admin.impact.conflictLine, { org: "Beta", name: "web-research" }),
      ),
    ).toBeTruthy();
    expect(
      (
        within(dialog).getByRole("button", {
          name: en.catalog.admin.scopeDialog.confirm,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
});

describe("org-owned components in the admin console (phase 3)", () => {
  const ACME = { kind: "org", orgId: "o1", name: "Acme" };
  // an org-created skill its org shares, not promoted yet (the org row's id)
  const SHARED = comp({
    id: "s6",
    name: "house-tone",
    plugin: null,
    itemId: null,
    owner: ACME,
    shareable: true,
    scopeMode: "own",
    scope: "named",
    orgs: ["o1"],
    shownToOthers: false,
    version: "2",
    onIn: ["o1"],
  });
  // promoted: a platform row owned by Acme, listed to Acme and Beta
  const PROMOTED = comp({
    id: "p7",
    name: "brand-voice",
    plugin: null,
    itemId: null,
    owner: ACME,
    shareable: true,
    promoted: true,
    scopeMode: "own",
    scope: "named",
    orgs: ["o1", "o2"],
    shownToOthers: false,
    onIn: ["o1", "o2"],
  });
  const LOCKED = comp({ ...PROMOTED, id: "p8", name: "legal-voice", shareable: false });
  const ORG_TEMPLATE = comp({
    kind: "agent_template",
    id: "a2",
    name: "house-agent",
    plugin: "acme-kit",
    itemId: null,
    owner: ACME,
    shareable: true,
    scopeMode: "own",
    scope: "named",
    orgs: ["o1"],
    shownToOthers: false,
    onIn: ["o1"],
  });
  const routes: Routes = {
    "GET /api/v1/admin/components?kind=skill": () =>
      json(200, { components: [...SKILLS, SHARED, PROMOTED, LOCKED] }),
    "GET /api/v1/admin/components?kind=agent_template": () =>
      json(200, { components: [...AGENTS, ORG_TEMPLATE] }),
    "GET /api/v1/admin/components/skill/s6/versions": () => json(200, { versions: [] }),
    "GET /api/v1/admin/components/skill/p7/versions": () => json(200, { versions: [] }),
    "GET /api/v1/admin/components/skill/p8/versions": () => json(200, { versions: [] }),
    "GET /api/v1/admin/components/agent_template/a2/versions": () => json(200, { versions: [] }),
  };

  it("the list says which org-owned rows their org does not share", async () => {
    await open("/admin/skills", routes);
    const table = await screen.findByRole("table", { name: C.titles.skill });
    const row = (name: string) => within(table).getByText(name).closest("tr") as HTMLElement;
    expect(within(row("house-style")).getByText(C.share.notShareable)).toBeTruthy();
    expect(within(row("legal-voice")).getByText(C.share.notShareable)).toBeTruthy();
    expect(within(row("house-tone")).queryByText(C.share.notShareable)).toBeNull();
    expect(within(row("web-research")).queryByText(C.share.notShareable)).toBeNull();
    // 组织创建 counts every org-owned row, promoted ones too
    const tab = screen.getByRole("tab", { name: new RegExp(`^${C.tabs.org}`) });
    expect(tab.textContent).toMatch(/4/);
  });

  it("a shared org skill: 向其他组织显示 promotes it, reads the list again and moves to the platform id", async () => {
    const calls = await open("/admin/skills/s6", {
      ...routes,
      "PUT /api/v1/admin/components/skill/s6/shown": () =>
        json(200, { ...SHARED, id: "p6", promoted: true, shownToOthers: true }),
    });
    expect(await screen.findByRole("heading", { name: "house-tone" })).toBeTruthy();
    expect(screen.queryByText(C.share.notShareable)).toBeNull();
    // the owner controls its versions; an org row is not a platform row to disable
    expect(screen.queryByRole("button", { name: C.detail.actions.upload })).toBeNull();
    expect(screen.queryByRole("button", { name: C.detail.actions.disable })).toBeNull();
    expect(screen.getByRole("button", { name: C.detail.actions.scope })).toBeTruthy();
    const before = calls.filter((c) => c.url.endsWith("/components?kind=skill")).length;
    await userEvent.setup().click(screen.getByRole("button", { name: C.share.show }));
    await waitFor(() => expect(put(calls, "/shown")).toHaveLength(1));
    expect(bodyOf(put(calls, "/shown")[0])).toEqual({ shownToOthers: true });
    await waitFor(() =>
      expect(calls.filter((c) => c.url.endsWith("/components?kind=skill")).length).toBeGreaterThan(
        before,
      ),
    );
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/admin/skills/p6"));
    expect(await screen.findByText(fill(C.share.shownToast, { name: "house-tone" }))).toBeTruthy();
  });

  it("a component of an org-uploaded plugin: 停用 is the super admin's platform disable (P3-49)", async () => {
    const FROM_ORG_PLUGIN = comp({
      id: "s8",
      name: "crm-notes",
      plugin: "acme-crm",
      itemId: "99999999-9999-4999-8999-999999999999",
      owner: ACME,
      shareable: false,
      scopeMode: "follow",
      onIn: ["o1"],
    });
    const calls = await open("/admin/skills/s8", {
      ...routes,
      "GET /api/v1/admin/components?kind=skill": () =>
        json(200, { components: [...SKILLS, FROM_ORG_PLUGIN] }),
      "GET /api/v1/admin/components/skill/s8/versions": () => json(200, { versions: [] }),
      "POST /api/v1/admin/components/skill/s8/scope/preview": () =>
        json(200, {
          affected: [{ orgId: "o1", orgName: "Acme", agents: [], connectorsKept: 0 }],
          conflicts: [],
          scopeHash: "d8",
        }),
      "PUT /api/v1/admin/components/skill/s8/disabled": () =>
        json(200, { ...FROM_ORG_PLUGIN, disabled: true }),
    });
    expect(await screen.findByRole("heading", { name: "crm-notes" })).toBeTruthy();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: C.detail.actions.disable }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("Acme")).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: C.disableDialog.confirm }));
    await waitFor(() => expect(put(calls, "/disabled")).toHaveLength(1));
    expect(bodyOf(put(calls, "/disabled")[0])).toMatchObject({ disabled: true, scopeHash: "d8" });
  });

  it("a promoted org skill: no 上传新版本 (its org uploads versions); 停用 stays", async () => {
    await open("/admin/skills/p7", routes);
    expect(await screen.findByRole("heading", { name: "brand-voice" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: C.detail.actions.upload })).toBeNull();
    expect(screen.getByRole("button", { name: C.detail.actions.disable })).toBeTruthy();
    expect(screen.getByRole("button", { name: C.detail.actions.scope })).toBeTruthy();
    expect(screen.getByRole("button", { name: C.share.show })).toBeTruthy();
  });

  it("a promoted skill its org no longer shares: 设置范围 only narrows (no other scopes, no new orgs, the owner kept)", async () => {
    await open("/admin/skills/p8", {
      ...routes,
      "GET /api/v1/admin/orgs": () =>
        json(200, {
          orgs: [
            ...ORGS.orgs,
            { id: "o3", slug: "gamma", name: "Gamma", memberCount: 1, createdAt: T },
          ],
        }),
    });
    expect(await screen.findByRole("heading", { name: "legal-voice" })).toBeTruthy();
    expect(screen.getAllByText(C.share.notShareable).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: C.share.show })).toBeNull();
    expect(screen.getByRole("button", { name: C.detail.actions.disable })).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: C.detail.actions.scope }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(en.catalog.admin.scopeDialog.narrowOnly)).toBeTruthy();
    expect(within(dialog).queryByRole("radio")).toBeNull();
    expect(within(dialog).queryByRole("switch")).toBeNull();
    await within(dialog).findByRole("checkbox", { name: "Beta" });
    expect(within(dialog).queryByRole("checkbox", { name: "Gamma" })).toBeNull();
    const owner = within(dialog).getByRole("checkbox", { name: "Acme" }) as HTMLInputElement;
    expect(owner.checked).toBe(true);
    expect(owner.disabled).toBe(true);
  });

  it("an org's plugin template is shared with its plugin, never on its own (ruling T4-R9)", async () => {
    await open("/admin/agent-templates/a2", routes);
    expect(await screen.findByRole("heading", { name: "house-agent" })).toBeTruthy();
    expect(screen.getAllByText(C.share.notOwned).length).toBeGreaterThan(0);
    for (const a of [C.share.show, C.detail.actions.upload]) {
      expect(screen.queryByRole("button", { name: a })).toBeNull();
    }
  });

  it("an org-created template its org shares: 对其他组织显示 on its card (P3-46 lifted, ruling P4-13)", async () => {
    const calls = await open("/admin/agent-templates", {
      ...routes,
      "GET /api/v1/admin/components?kind=agent_template": () =>
        json(200, {
          components: [...AGENTS, { ...ORG_TEMPLATE, id: "a3", name: "sales", plugin: null }],
        }),
      "PUT /api/v1/admin/components/agent_template/a3/shown": () =>
        json(200, { ...ORG_TEMPLATE, id: "p3", name: "sales", plugin: null, promoted: true }),
    });
    const card = (await screen.findByRole("link", { name: "sales" })).closest("li") as HTMLElement;
    expect(card.querySelector('[data-part="object-card-meta"]')?.textContent).toContain(
      `${C.from.org} · Acme · `,
    );
    const user = userEvent.setup();
    await user.click(within(card).getByRole("button", { name: "More actions" }));
    expect((await screen.findAllByRole("menuitem")).map((i) => i.textContent)).toEqual([
      C.share.show,
      C.detail.actions.scope,
    ]);
    await user.click(screen.getByRole("menuitem", { name: C.share.show }));
    await vi.waitFor(() =>
      expect(calls.some((c) => c.method === "PUT" && c.url.endsWith("/a3/shown"))).toBe(true),
    );
    // from the list a promotion moves nowhere: the list is read again instead
    expect(await screen.findByText(fill(C.share.shownToast, { name: "sales" }))).toBeTruthy();
    expect(router.replace).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(
        calls.filter((c) => c.method === "GET" && c.url.includes("kind=agent_template")).length,
      ).toBeGreaterThan(0),
    );
  });
});
