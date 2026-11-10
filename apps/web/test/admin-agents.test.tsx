// The admin console's 智能体 tab (spec 2026-11-10-admin-agents-connectors §3.2, §3.3, §5): every
// org's agents with the org filter and the name search, the read-only detail with 转移所有者 and
// 删除, and the admin item queries both kinds share (the connector ones are Task 6's pages).
import { describeNestedBox, findNestedBoxes } from "@capybara-hq/design/reference";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { ADMIN_PAGES } from "../src/components/admin-nav";
import { activeAdminOf } from "../src/components/shell/nav";
import { APP_PAGES } from "../src/components/shell/path";
import {
  adminAgentQuery,
  adminAgentsQuery,
  adminConnectorQuery,
  adminConnectorsQuery,
  adminOrgMembersQuery,
} from "../src/lib/query/admin-items";
import { keys } from "../src/lib/query/keys";
import { bodyOf, json, stubApi } from "./support/api";
import { resetNavigation, router } from "./support/navigation";
import { renderRouteEmptyCache, renderRouteWithCache } from "./support/query";
import { ME } from "./support/render";
import { optionLabels, pickOption } from "./support/select";
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

const A = en.adminItems.agents;
const fill = (s: string, vars: Record<string, string | number>) =>
  s.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k]));
const template = (name: string) => document.querySelector(`[data-template="${name}"]`);
const T = "2026-11-06T00:00:00.000Z";
const NOT_ADMIN = { ...ME, account: { ...ME.account, isSuperAdmin: false } };

const ORGS = {
  orgs: [
    { id: "o1", slug: "acme", name: "Acme", memberCount: 3, createdAt: T },
    { id: "o2", slug: "beta", name: "Beta", memberCount: 4, createdAt: T },
  ],
  limitDefaults: {},
};

const row = (over: Record<string, unknown> = {}) => ({
  id: "ag1",
  orgId: "o1",
  orgName: "Acme",
  name: "Researcher",
  avatar: { kind: "preset", id: "capybara" },
  ownerAccountId: "u1",
  ownerName: "Grant",
  needsReassignment: true,
  visibility: "private",
  createdFrom: { templateId: "t1", name: "research-kit" },
  updatedAt: T,
  ...over,
});
const ROWS = [
  row(),
  row({
    id: "ag2",
    orgId: "o2",
    orgName: "Beta",
    name: "Writer",
    avatar: { kind: "upload", uploadId: "up1" },
    ownerAccountId: "u2",
    ownerName: "Lin",
    needsReassignment: false,
    visibility: "members",
    createdFrom: null,
  }),
];
const DETAIL = {
  ...row(),
  profile: {
    description: "Finds and reads papers.",
    quickActions: [{ label: "Summarize" }, { label: "Find papers" }],
  },
  memberIds: null,
  definition: {
    name: "Researcher",
    instructions: "You research things.\nAlways cite your sources.",
    model: { provider: "openai-compatible", model: "deepseek-chat" },
    fallback: null,
    modelParams: { effort: "high" },
    skills: { orgSkills: ["s1", "s2"] },
    subagents: { general: true, agents: [{ agentId: "ag2", as: "writer", description: "Writes" }] },
    pendingConnectors: [{ key: "gh", label: "GitHub", source: { template: "ct1" } }],
  },
  versions: 3,
  createdAt: T,
  skills: [
    { id: "sk2", name: "my-notes", scope: "agent" },
    { id: "sk1", name: "web-research", scope: "org" },
  ],
  connectors: [
    { id: "c1", name: "Jira", slug: "jira", status: "disabled" },
    { id: "c2", name: "Slack", slug: "slack", status: "active" },
  ],
};
const MEMBERS = {
  members: [
    {
      account: { id: "u1", displayName: "Grant", email: null },
      role: "owner",
      joinedAt: T,
      anonymous: false,
    },
    {
      account: { id: "u3", displayName: "Mia", email: "mia@acme.test" },
      role: "member",
      joinedAt: T,
      anonymous: false,
    },
    {
      account: { id: "g1", displayName: "Anonymous guest", email: null },
      role: "guest",
      joinedAt: T,
      anonymous: true,
    },
  ],
};

const LIST = "/api/v1/admin/agents";
const base: Routes = {
  "GET /api/v1/admin/orgs": () => json(200, ORGS),
  [`GET ${LIST}`]: () => json(200, { agents: ROWS, next: null }),
  [`GET ${LIST}/ag1`]: () => json(200, { agent: DETAIL }),
  "GET /api/v1/admin/orgs/o1/members": () => json(200, MEMBERS),
};

beforeEach(() => {
  resetNavigation("/admin/agents");
  window.history.replaceState(null, "", "/");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** A first load of `path` against `base` plus `routes`; the browser's reads are returned. */
async function open(path: string, routes: Routes = {}) {
  const all = { ...base, ...routes };
  const calls = stubApi(all);
  const view = await renderRouteWithCache(path, all);
  return { ...view, calls };
}

describe("/admin/agents", () => {
  it("lists name, org, owner with 待重新指派, visibility, template and updated; no browser read", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRouteWithCache("/admin/agents", base);
    const table = await screen.findByRole("table", { name: A.listLabel });
    expect(browser).toEqual([]);
    const first = within(table).getByText("Researcher").closest("tr") as HTMLElement;
    expect(within(first).getByText("Acme")).toBeTruthy();
    expect(within(first).getByText("Grant")).toBeTruthy();
    expect(within(first).getByText(A.needsReassignment)).toBeTruthy();
    expect(within(first).getByText(A.visibility.private)).toBeTruthy();
    expect(within(first).getByText("research-kit")).toBeTruthy();
    expect(first.querySelector("time")).not.toBeNull();
    // the avatar: a preset as itself, an upload (org-scoped) as the initial
    expect(first.querySelector('[data-part="avatar"]')?.getAttribute("data-kind")).toBe("preset");
    const second = within(table).getByText("Writer").closest("tr") as HTMLElement;
    expect(second.querySelector('[data-part="avatar"]')?.getAttribute("data-kind")).toBe("initial");
    expect(within(second).queryByText(A.needsReassignment)).toBeNull();
    expect(within(second).getByText(A.visibility.members)).toBeTruthy();
    // the header tabs: 智能体 active, 模板 a link
    const items = screen.getByRole("link", { name: en.adminItems.tabs.agents });
    expect([items.getAttribute("href"), items.getAttribute("aria-current")]).toEqual([
      "/admin/agents",
      "page",
    ]);
    expect(
      screen.getByRole("link", { name: en.adminItems.tabs.templates }).getAttribute("href"),
    ).toBe("/admin/agents/templates");
    expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
    expect(zh.adminItems.agents.needsReassignment).toBe("待重新指派");
    expect(zh.adminItems.agents.visibility).toEqual({
      private: "私有",
      org: "组织",
      members: "指定成员",
    });
  });

  it("a row opens the agent's detail", async () => {
    await open("/admin/agents");
    const user = userEvent.setup();
    await user.click(await screen.findByText("Writer"));
    expect(router.push).toHaveBeenCalledWith("/admin/agents/ag2");
  });

  it("the org filter and the search change the address, which reads that filter", async () => {
    const { calls, navigate } = await open("/admin/agents");
    const user = userEvent.setup();
    await pickOption(await screen.findByRole("combobox", { name: A.filters.org }), "o2", user);
    expect(router.replace).toHaveBeenLastCalledWith("/admin/agents?orgId=o2");
    await act(() => navigate("/admin/agents?orgId=o2"));
    await waitFor(() => expect(calls.map((c) => c.url)).toContain(`${LIST}?orgId=o2`));

    await user.type(screen.getByRole("searchbox", { name: A.search }), "res");
    await waitFor(() =>
      expect(router.replace).toHaveBeenLastCalledWith("/admin/agents?orgId=o2&q=res"),
    );
    await act(() => navigate("/admin/agents?orgId=o2&q=res"));
    await waitFor(() => expect(calls.map((c) => c.url)).toContain(`${LIST}?orgId=o2&q=res`));
  });

  it("a filtered first load reads that filter on the server", async () => {
    const { calls } = await renderRouteWithCache("/admin/agents?orgId=o1&q=wri", base);
    expect(calls.map((c) => c.url)).toContain(`${LIST}?orgId=o1&q=wri`);
  });

  it("Load more reads the page after the cursor", async () => {
    const { calls } = await open("/admin/agents", {
      [`GET ${LIST}`]: (c) =>
        c.url.includes("after=ag1")
          ? json(200, { agents: [ROWS[1]], next: null })
          : json(200, { agents: [ROWS[0]], next: "ag1" }),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: A.loadMore }));
    expect(await screen.findByText("Writer")).toBeTruthy();
    expect(calls.map((c) => c.url)).toContain(`${LIST}?after=ag1`);
    expect(screen.queryByRole("button", { name: A.loadMore })).toBeNull();
  });

  it("a refetch of the first page drops the later pages read so far", async () => {
    let page2 = [ROWS[1]];
    const { client } = await open("/admin/agents", {
      [`GET ${LIST}`]: (c) =>
        c.url.includes("after=ag1")
          ? json(200, { agents: page2, next: null })
          : json(200, { agents: [ROWS[0]], next: "ag1" }),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: A.loadMore }));
    expect(await screen.findByText("Writer")).toBeTruthy();
    // Writer is deleted elsewhere; the list is invalidated (the first page answers the same)
    page2 = [];
    await act(() => client.invalidateQueries({ queryKey: keys.deployment().adminAgentsAll() }));
    await waitFor(() => expect(screen.queryByText("Writer")).toBeNull());
    expect(screen.getByRole("button", { name: A.loadMore })).toBeTruthy();
  });

  it("empty: no org has created an agent yet", async () => {
    await open("/admin/agents", { [`GET ${LIST}`]: () => json(200, { agents: [], next: null }) });
    expect(await screen.findByText(A.empty)).toBeTruthy();
    expect(zh.adminItems.agents.empty).toBe("还没有组织创建智能体");
  });

  it("an empty cache shows the table's loading state, then the rows", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    await renderRouteEmptyCache("/admin/agents", {
      ...base,
      [`GET ${LIST}`]: async () => {
        await gate;
        return json(200, { agents: ROWS, next: null });
      },
    });
    await vi.waitFor(() => expect(document.querySelector('[aria-busy="true"]')).not.toBeNull());
    await act(async () => release());
    expect(await screen.findByText("Researcher")).toBeTruthy();
  });

  it("a non super admin gets no access and no admin read", async () => {
    const calls = stubApi({});
    await renderRouteWithCache("/admin/agents", base, { me: NOT_ADMIN });
    expect(template("StatusPage")?.getAttribute("data-kind")).toBe("no-access");
    expect(calls).toEqual([]);
  });
});

describe("/admin/agents/[id]", () => {
  it("shows the facts, the full instructions and the quick action labels; no browser read", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRouteWithCache("/admin/agents/ag1", base);
    expect(await screen.findByRole("heading", { level: 1, name: "Researcher" })).toBeTruthy();
    expect(browser).toEqual([]);
    expect(template("DetailPage")).not.toBeNull();
    const body = document.body.textContent ?? "";
    expect(body).toContain("You research things.");
    expect(body).toContain("Always cite your sources.");
    expect(screen.getByText("Summarize")).toBeTruthy();
    expect(screen.getByText("Find papers")).toBeTruthy();
    expect(screen.getByText("Finds and reads papers.")).toBeTruthy();
    expect(screen.getByText("Acme")).toBeTruthy();
    expect(screen.getByText(A.needsReassignment)).toBeTruthy();
    expect(screen.getByText(A.visibility.private)).toBeTruthy();
    expect(screen.getByText("research-kit")).toBeTruthy();
    // the skills and connectors by name: a scope word, a status word
    const skills = screen.getByRole("list", { name: A.detail.sections.skills });
    const skillRows = within(skills).getAllByRole("listitem");
    expect(skillRows.map((r) => r.textContent)).toEqual([
      `my-notes${A.detail.skillScope.agent}`,
      `web-research${A.detail.skillScope.org}`,
    ]);
    const connectors = screen.getByRole("list", { name: A.detail.sections.connectors });
    const connectorText = within(connectors)
      .getAllByRole("listitem")
      .map((r) => r.textContent ?? "");
    expect(connectorText[0]).toContain("Jira");
    expect(connectorText[0]).toContain(A.detail.connectorStatus.disabled);
    expect(connectorText[1]).toContain("Slack");
    expect(connectorText[1]).toContain(A.detail.connectorStatus.active);
    // the pending connector stays in its own list
    const pending = screen.getByRole("list", { name: A.detail.sections.pending });
    expect(within(pending).getByText("GitHub")).toBeTruthy();
    expect(within(connectors).queryByText("GitHub")).toBeNull();
    expect(screen.getByText("writer")).toBeTruthy();
    expect(screen.getByRole("button", { name: A.actions.transfer })).toBeTruthy();
    expect(screen.getByRole("button", { name: A.actions.delete })).toBeTruthy();
    // the path links back to the list
    expect(screen.getByRole("link", { name: "agents" }).getAttribute("href")).toBe("/admin/agents");
    expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
    // an agent's owner is its 所有者 in zh (maintainer decision V, messages-parity.test.ts)
    expect(zh.adminItems.agents.actions).toEqual({ transfer: "转移所有者", delete: "删除" });
  });

  it("a missing agent is the not-found state", async () => {
    await open("/admin/agents/nope", {
      [`GET ${LIST}/nope`]: () =>
        json(404, { error: { code: "agent.not_found", message: "Agent not found" } }),
    });
    expect(template("StatusPage")?.getAttribute("data-kind")).toBe("404");
  });

  it("转移所有者 lists the org's members without anonymous guests and posts { accountId }", async () => {
    let detail = DETAIL;
    const { calls } = await open("/admin/agents/ag1", {
      [`GET ${LIST}/ag1`]: () => json(200, { agent: detail }),
      [`POST ${LIST}/ag1/owner`]: () => {
        detail = { ...DETAIL, ownerAccountId: "u3", ownerName: "Mia", needsReassignment: false };
        return json(200, { agent: detail });
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: A.actions.transfer }));
    const dialog = await screen.findByRole("dialog", { name: A.transfer.title });
    const select = await within(dialog).findByRole("combobox", { name: A.transfer.owner });
    expect(await optionLabels(select, user)).toEqual(["Grant", "Mia · mia@acme.test"]);
    await pickOption(select, "u3", user);
    await user.click(within(dialog).getByRole("button", { name: A.transfer.submit }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const post = calls.find((c) => c.method === "POST");
    expect(bodyOf(post)).toEqual({ accountId: "u3" });
    // the detail is read again (invalidated) and shows the new owner
    expect(await screen.findByText("Mia")).toBeTruthy();
    expect(screen.queryByText(A.needsReassignment)).toBeNull();
  });

  it("删除 names the org and the owner, deletes and goes back to the list", async () => {
    const { calls } = await open("/admin/agents/ag1", {
      [`DELETE ${LIST}/ag1`]: () => new Response(null, { status: 204 }),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: A.actions.delete }));
    const dialog = await screen.findByRole("dialog", {
      name: fill(A.delete.title, { name: "Researcher" }),
    });
    expect(dialog.textContent).toContain(fill(A.delete.hint, { org: "Acme", owner: "Grant" }));
    await user.click(within(dialog).getByRole("button", { name: A.delete.confirm }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/admin/agents"));
    expect(calls.some((c) => c.method === "DELETE" && c.url === `${LIST}/ag1`)).toBe(true);
  });
});

describe("admin item queries", () => {
  it("agent keys and URLs: each filter and cursor its own entry", async () => {
    const calls = stubApi({
      [`GET ${LIST}`]: () => json(200, { agents: [], next: null }),
      [`GET ${LIST}/ag1`]: () => json(200, { agent: DETAIL }),
      "GET /api/v1/admin/orgs/o1/members": () => json(200, MEMBERS),
    });
    const d = keys.deployment();
    const q = adminAgentsQuery({ orgId: "o1", q: " res " }, "ag9");
    expect(q.queryKey).toEqual(d.adminAgents("o1", "res", "ag9"));
    expect(adminAgentsQuery({}).queryKey).toEqual(d.adminAgents("", "", ""));
    expect(d.adminAgents("o1", "res", "ag9").slice(0, 2)).toEqual(d.adminAgentsAll());
    await (q.queryFn as () => Promise<unknown>)();
    expect(calls.at(-1)?.url).toBe(`${LIST}?orgId=o1&q=res&after=ag9`);
    expect(await (adminAgentQuery("ag1").queryFn as () => Promise<unknown>)()).toEqual(DETAIL);
    await (adminOrgMembersQuery("o1").queryFn as () => Promise<unknown>)();
    expect(calls.at(-1)?.url).toBe("/api/v1/admin/orgs/o1/members");
  });

  it("connector keys and URLs: org, status, search, cursor", async () => {
    const C = "/api/v1/admin/connectors";
    const calls = stubApi({
      [`GET ${C}`]: () => json(200, { connectors: [], next: null }),
      [`GET ${C}/c1`]: () => json(200, { connector: { id: "c1" } }),
    });
    const d = keys.deployment();
    const q = adminConnectorsQuery({ orgId: "o2", status: "disabled", q: "gh " }, "c0");
    expect(q.queryKey).toEqual(d.adminConnectors("o2", "disabled", "gh", "c0"));
    expect(adminConnectorsQuery({}).queryKey).toEqual(d.adminConnectors("", "", "", ""));
    expect(d.adminConnectors("o2", "", "", "").slice(0, 2)).toEqual(d.adminConnectorsAll());
    await (q.queryFn as () => Promise<unknown>)();
    expect(calls.at(-1)?.url).toBe(`${C}?orgId=o2&status=disabled&q=gh&after=c0`);
    await (adminConnectorsQuery({}).queryFn as () => Promise<unknown>)();
    expect(calls.at(-1)?.url).toBe(C);
    expect(adminConnectorQuery("c1").queryKey).toEqual(d.adminConnector("c1"));
    expect(await (adminConnectorQuery("c1").queryFn as () => Promise<unknown>)()).toEqual({
      id: "c1",
    });
  });
});

describe("admin nav and paths", () => {
  it("highlights 智能体 on the list, its detail and the template pages", () => {
    for (const p of [
      "/admin/agents",
      "/admin/agents/ag1",
      "/admin/agents/templates",
      "/admin/agents/templates/a1",
    ]) {
      expect(activeAdminOf(p, [...ADMIN_PAGES])).toBe("agents");
    }
  });

  it("the agent pages are app pages (path segments link to them)", () => {
    expect(APP_PAGES).toContain("/admin/agents");
    expect(APP_PAGES).toContain("/admin/agents/[id]");
  });
});
