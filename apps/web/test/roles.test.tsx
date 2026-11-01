// The role pass (web-order spec §9): every page a role may not open shows the one no-access state
// before loading anything; every role that may open it gets the page.
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentType, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import zh from "../messages/zh.json";
import EditAgentPage from "../src/app/(app)/agents/[id]/page";
import NewAgentPage from "../src/app/(app)/agents/new/page";
import AgentsPage from "../src/app/(app)/agents/page";
import CatalogInstallPage from "../src/app/(app)/catalog/[itemId]/install/page";
import CatalogItemPage from "../src/app/(app)/catalog/[itemId]/page";
import CatalogPage from "../src/app/(app)/catalog/page";
import ChannelDetailPage from "../src/app/(app)/channels/[id]/page";
import NewChannelPage from "../src/app/(app)/channels/new/page";
import ChannelsPage from "../src/app/(app)/channels/page";
import ConnectorInstallPage from "../src/app/(app)/connectors/install/page";
import EvalCasePage from "../src/app/(app)/evals/[setId]/cases/[caseId]/page";
import EvalSetPage from "../src/app/(app)/evals/[setId]/page";
import EvalRunWizardPage from "../src/app/(app)/evals/[setId]/run/page";
import NewEvalSetPage from "../src/app/(app)/evals/new/page";
import EvalsPage from "../src/app/(app)/evals/page";
import EvalRunPage from "../src/app/(app)/evals/runs/[runId]/page";
import HomePage from "../src/app/(app)/page";
import ExtensionsSettingsPage from "../src/app/(app)/settings/extensions/page";
import MembersPage from "../src/app/(app)/settings/members/page";
import ModelsSettingsPage from "../src/app/(app)/settings/models/page";
import OrganizationPage from "../src/app/(app)/settings/organization/page";
import PluginsSettingsPage from "../src/app/(app)/settings/plugins/page";
import SandboxPage from "../src/app/(app)/settings/sandbox/page";
import TokensPage from "../src/app/(app)/settings/tokens/page";
import SkillPage from "../src/app/(app)/skills/[id]/page";
import SkillsPage from "../src/app/(app)/skills/page";
import TrajectoryPage from "../src/app/(app)/trajectories/[conversationId]/page";
import TrajectoriesPage from "../src/app/(app)/trajectories/page";
import { setApiTransport } from "../src/lib/api";
import type { OrgRole } from "../src/lib/members";
import type { Me } from "../src/lib/session";
import { agentFormDefaults } from "./support/agents";
import { resetNavigation } from "./support/navigation";
import { ME, renderPage } from "./support/render";
import { type Routes, renderRoute } from "./support/server";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("next/navigation", () => ({
  useParams: () => ({
    id: "x1",
    setId: "s1",
    caseId: "c1",
    runId: "r1",
    itemId: "i1",
    conversationId: "cv1",
  }),
  useSearchParams: () => new URLSearchParams(),
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

const ROLES = ["guest", "member", "admin", "owner"] as const;
const RANK = { guest: 0, member: 1, admin: 2, owner: 3 } as const;

export const meAs = (role: OrgRole, enterprise = false): Me => ({
  ...ME,
  account: { ...ME.account, isEnterpriseAdmin: enterprise },
  memberships: [{ orgId: "o1", slug: "acme", name: "Acme", role }],
});

let calls: string[] = [];
/** `METHOD path` (no query) → JSON body; anything else answers 404. */
let routes: Record<string, unknown> = {};
const reply = (status: number, body: unknown) =>
  new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
beforeEach(() => {
  calls = [];
  routes = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push(`${method} ${url}`);
      const key = `${method} ${url.split("?")[0]}`;
      if (key in routes) {
        const body = routes[key];
        return body === null ? new Response(null, { status: 204 }) : reply(200, body);
      }
      return reply(404, { error: { code: "not_found", message: "x" } });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** A server page (gate and reads on the server), as the role pass runs it. */
type ServerPage = { server: () => Promise<ReactNode> };
const server = (page: () => Promise<ReactNode>): ServerPage => ({ server: page });
const params = <T,>(p: T) => ({ params: Promise.resolve(p) });

/**
 * Runs a server page's gate for `me`: the session reads answer, every other read is a 404. Returns
 * the reads past the gate's own and what the page rendered (none when a read threw).
 */
async function runServerPage(
  page: ServerPage,
  me: Me,
): Promise<{ reads: string[]; element: ReactNode | undefined }> {
  const reads: string[] = [];
  setApiTransport(
    async (path) => {
      if (path === "/api/v1/me") return reply(200, me);
      if (path === "/api/v1/orgs/o1/readiness")
        return reply(200, { modelProvider: "ready", agents: 1 });
      reads.push(path);
      return reply(404, { error: { code: "not_found", message: "x" } });
    },
    { everywhere: true },
  );
  try {
    return { reads, element: await page.server() };
  } catch {
    return { reads, element: undefined };
  } finally {
    setApiTransport(null);
  }
}

const PAGES: [string, ComponentType | ServerPage, "member" | "admin", string][] = [
  ["/agents/new", server(() => NewAgentPage()), "member", zh.roles.need.member],
  [
    "/connectors/install",
    server(() => ConnectorInstallPage({ searchParams: Promise.resolve({}) })),
    "admin",
    zh.roles.need.admin,
  ],
  ["/channels", server(() => ChannelsPage()), "admin", zh.roles.need.admin],
  [
    "/channels/new",
    server(() => NewChannelPage({ searchParams: Promise.resolve({}) })),
    "admin",
    zh.roles.need.admin,
  ],
  [
    "/channels/x1",
    server(() => ChannelDetailPage(params({ id: "x1" }))),
    "admin",
    zh.roles.need.admin,
  ],
  ["/evals", EvalsPage, "admin", zh.roles.need.admin],
  ["/evals/new", NewEvalSetPage, "admin", zh.roles.need.admin],
  ["/evals/s1", EvalSetPage, "admin", zh.roles.need.admin],
  ["/evals/s1/run", EvalRunWizardPage, "admin", zh.roles.need.admin],
  ["/evals/s1/cases/c1", EvalCasePage, "admin", zh.roles.need.admin],
  ["/evals/runs/r1", EvalRunPage, "admin", zh.roles.need.admin],
  ["/settings/models", ModelsSettingsPage, "admin", zh.roles.need.admin],
  ["/settings/extensions", ExtensionsSettingsPage, "admin", zh.roles.need.admin],
  ["/settings/plugins", PluginsSettingsPage, "admin", zh.roles.need.admin],
  ["/settings/tokens", TokensPage, "admin", zh.roles.need.admin],
  ["/settings/organization", OrganizationPage, "member", zh.roles.need.member],
  ["/settings/members", MembersPage, "member", zh.roles.need.member],
  ["/settings/sandbox", SandboxPage, "member", zh.roles.need.member],
  ["/skills", server(() => SkillsPage()), "member", zh.roles.need.member],
  ["/skills/x1", server(() => SkillPage(params({ id: "x1" }))), "member", zh.roles.need.member],
  ["/catalog", server(() => CatalogPage()), "member", zh.roles.need.member],
  [
    "/catalog/i1",
    server(() => CatalogItemPage(params({ itemId: "i1" }))),
    "member",
    zh.roles.need.member,
  ],
  [
    "/catalog/i1/install",
    server(() => CatalogInstallPage(params({ itemId: "i1" }))),
    "admin",
    zh.roles.need.admin,
  ],
  ["/trajectories", TrajectoriesPage, "member", zh.roles.need.member],
  ["/trajectories/cv1", TrajectoryPage, "member", zh.roles.need.member],
];

const noAccess = () =>
  document.querySelector('[data-template="StatusPage"][data-kind="no-access"]');

describe("role gate: pages a role may not open", () => {
  for (const [path, Page, min, need] of PAGES) {
    for (const role of ROLES) {
      const denied = RANK[role] < RANK[min];
      it(`${path} · ${role} → ${denied ? "no access, nothing loaded" : "the page"}`, async () => {
        resetNavigation(path);
        if ("server" in Page) {
          const { reads, element } = await runServerPage(Page, meAs(role));
          if (element !== undefined) renderPage(element, { locale: "zh", me: meAs(role) });
          if (denied) {
            expect(reads).toEqual([]);
            expect(noAccess()).toBeTruthy();
            expect(document.querySelector('[data-part="status-need"]')?.textContent).toBe(
              `需要：${need}`,
            );
          } else {
            expect(noAccess()).toBeNull();
            // past the gate: the page reads its data, or renders without reading
            expect(reads.length > 0 || element !== undefined).toBe(true);
          }
          await Promise.resolve();
          expect(calls).toEqual([]);
          return;
        }
        renderPage(<Page />, { locale: "zh", me: meAs(role) });
        if (denied) {
          expect(noAccess()).toBeTruthy();
          expect(screen.getByRole("heading", { level: 2, name: zh.roles.noAccess.title }));
          expect(document.querySelector('[data-part="status-need"]')?.textContent).toBe(
            `需要：${need}`,
          );
          expect(screen.getByText(zh.roles.noAccess.askOrg)).toBeTruthy();
          expect(screen.queryByRole("button", { name: zh.common.retry })).toBeNull();
          await Promise.resolve();
          expect(calls).toEqual([]);
        } else {
          expect(noAccess()).toBeNull();
          // the page really loads: it asks the kernel for its data (the connector wizard asks
          // nothing before its first step, so its first step's template stands in)
          if (path === "/connectors/install") {
            await vi.waitFor(() =>
              expect(document.querySelector('[data-template="WizardPage"]')).toBeTruthy(),
            );
          } else {
            await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0));
          }
        }
      });
    }
  }
});

/** The `routes` body map as server routes (a `null` body is a 204). */
const served = (): Routes =>
  Object.fromEntries(
    Object.entries(routes).map(([k, body]) => [
      k,
      () => (body === null ? new Response(null, { status: 204 }) : reply(200, body)),
    ]),
  );

const AGENT = (id: string, owner = "someone") => ({
  id,
  orgId: "o1",
  visibility: "org",
  ownerAccountId: owner,
  currentVersion: 1,
  definition: { name: `Agent ${id}`, instructions: "", model: { provider: "p", model: "m" } },
  updatedAt: "2026-10-01T00:00:00Z",
});
const O = "/api/v1/orgs/o1";

describe("role-dependent actions", () => {
  for (const role of ROLES) {
    const canCreate = role !== "guest";
    it(`/agents · ${role}: 新建 Agent ${canCreate ? "shown" : "hidden"}`, async () => {
      routes = { [`GET ${O}/agents`]: { agents: [] } };
      resetNavigation("/agents");
      await renderRoute(() => AgentsPage(), served(), { locale: "zh", me: meAs(role) });
      await screen.findByText(zh.agents.empty);
      expect(screen.queryAllByRole("link", { name: zh.agents.new }).length > 0).toBe(canCreate);
    });

    it(`overview · ${role}: 新建 Agent and 组织设置 ${canCreate ? "shown" : "hidden"}`, async () => {
      const ok = (body: unknown) => () => reply(200, body);
      const gone = () => reply(404, { error: { code: "not_found", message: "x" } });
      resetNavigation("/");
      await renderRoute(
        () => HomePage(),
        {
          [`GET ${O}/agents`]: ok({ agents: [AGENT("ag1")] }),
          [`GET ${O}/models`]: ok({ providers: [] }),
          [`GET ${O}/inbox`]: ok({ items: [], truncated: false }),
          [`GET ${O}/conversations/groups`]: ok({ groups: [] }),
          [`GET ${O}/skills`]: gone,
          [`GET ${O}/connectors`]: gone,
          [`GET ${O}/members`]: gone,
        },
        { locale: "zh", me: meAs(role) },
      );
      screen.getByText("Agent ag1");
      expect(screen.queryByRole("link", { name: zh.home.newAgent }) !== null).toBe(canCreate);
      expect(screen.queryByRole("link", { name: zh.home.orgSettings }) !== null).toBe(canCreate);
    });
  }
});

const MODELS = {
  providers: [
    {
      provider: "p",
      models: [{ id: "m", label: "M", capabilities: {}, params: [] }],
    },
  ],
};
const MEMBERS = {
  members: [
    {
      account: { id: "a1", displayName: "Grant", email: null },
      role: "admin",
      joinedAt: "2026-10-01T00:00:00Z",
      anonymous: false,
    },
    {
      account: { id: "a2", displayName: "Mia", email: null },
      role: "member",
      joinedAt: "2026-10-01T00:00:00Z",
      anonymous: false,
    },
    {
      account: { id: "anon", displayName: "Anonymous", email: null },
      role: "guest",
      joinedAt: "2026-10-01T00:00:00Z",
      anonymous: true,
    },
  ],
};

describe("agents: edit, read-only and 更换负责人", () => {
  const agentPage = async (role: OrgRole, owner: string, extra: Record<string, unknown> = {}) => {
    routes = {
      [`GET ${O}/agents/x1`]: { agent: { ...AGENT("x1", owner), ...extra } },
      [`GET ${O}/models`]: MODELS,
      [`GET ${O}/connectors`]: { connectors: [] },
      [`GET ${O}/skills`]: { skills: [] },
      [`GET ${O}/agents/x1/skills`]: { skills: [] },
      [`GET ${O}/channels`]: { channels: [] },
      [`GET ${O}/members`]: MEMBERS,
      [`POST ${O}/agents/x1/owner`]: { agent: AGENT("x1", "a2") },
    };
    resetNavigation("/agents/x1");
    await renderRoute(
      () => EditAgentPage(params({ id: "x1" })),
      { ...agentFormDefaults("x1"), ...served() },
      { locale: "zh", me: meAs(role) },
    );
  };

  for (const role of ROLES) {
    const edits = role === "admin" || role === "owner";
    it(`/agents/<id> of someone else · ${role}: ${edits ? "the form" : "read-only"}`, async () => {
      await agentPage(role, "someone");
      if (edits) {
        expect(await screen.findByRole("button", { name: zh.agents.form.submit })).toBeTruthy();
        expect(screen.getByRole("button", { name: zh.agents.reassign.action })).toBeTruthy();
      } else {
        expect(await screen.findByText(zh.agents.readOnly)).toBeTruthy();
        expect(screen.queryByRole("button", { name: zh.agents.form.submit })).toBeNull();
        expect(screen.queryByRole("button", { name: zh.agents.reassign.action })).toBeNull();
        expect(screen.getByText("p / m")).toBeTruthy();
      }
    });
  }

  it("a member who owns the agent edits it, without 更换负责人", async () => {
    await agentPage("member", "a1");
    expect(await screen.findByRole("button", { name: zh.agents.form.submit })).toBeTruthy();
    expect(screen.queryByRole("button", { name: zh.agents.reassign.action })).toBeNull();
  });

  it("a guest who still owns an agent cannot edit it (agents.create is member up)", async () => {
    await agentPage("guest", "a1");
    expect(await screen.findByText(zh.agents.readOnly)).toBeTruthy();
  });

  it("an admin changes the owner: picks a member (no anonymous guests) and posts it", async () => {
    await agentPage("admin", "someone");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: zh.agents.reassign.action }));
    const dialog = await screen.findByRole("dialog", { name: zh.agents.reassign.title });
    const select = await within(dialog).findByRole("combobox", { name: zh.agents.reassign.owner });
    expect(within(select).queryByRole("option", { name: /Anonymous/ })).toBeNull();
    await user.selectOptions(select, "a2");
    await user.click(within(dialog).getByRole("button", { name: zh.agents.reassign.submit }));
    await vi.waitFor(() => expect(calls).toContain(`POST ${O}/agents/x1/owner`));
    expect(await screen.findByText(zh.agents.reassign.done)).toBeTruthy();
  });

  it("an agent that needs reassignment can be confirmed to its current owner", async () => {
    await agentPage("admin", "a2", { needsReassignment: true });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: zh.agents.reassign.action }));
    const dialog = await screen.findByRole("dialog", { name: zh.agents.reassign.title });
    await within(dialog).findByRole("combobox", { name: zh.agents.reassign.owner });
    const submit = within(dialog).getByRole("button", { name: zh.agents.reassign.submit });
    expect(submit).toHaveProperty("disabled", false);
    await user.click(submit);
    await vi.waitFor(() => expect(calls).toContain(`POST ${O}/agents/x1/owner`));
  });

  it("without needsReassignment the current owner is not a change", async () => {
    await agentPage("admin", "a2");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: zh.agents.reassign.action }));
    const dialog = await screen.findByRole("dialog", { name: zh.agents.reassign.title });
    await within(dialog).findByRole("combobox", { name: zh.agents.reassign.owner });
    expect(within(dialog).getByRole("button", { name: zh.agents.reassign.submit })).toHaveProperty(
      "disabled",
      true,
    );
  });

  for (const role of ROLES) {
    const admin = role === "admin" || role === "owner";
    it(`agent row menu · ${role}: 更换负责人 ${admin ? "shown" : "hidden"}`, async () => {
      routes = { [`GET ${O}/agents`]: { agents: [AGENT("ag1", "a1")] } };
      resetNavigation("/agents");
      await renderRoute(() => AgentsPage(), served(), { locale: "zh", me: meAs(role) });
      await screen.findByText("Agent ag1");
      await userEvent.setup().click(screen.getByRole("button", { name: "更多操作" }));
      const menu = await screen.findByRole("menu");
      expect(
        within(menu).queryByRole("menuitem", { name: zh.agents.reassign.action }) !== null,
      ).toBe(admin);
      // a guest who owns the agent cannot edit it either
      expect(within(menu).queryByRole("menuitem", { name: zh.agents.edit }) !== null).toBe(
        role !== "guest",
      );
    });
  }
});

describe("trajectories: only the tabs the role can use", () => {
  for (const role of ["member", "admin", "owner"] as const) {
    const admin = role !== "member";
    it(`/trajectories · ${role}: ${admin ? "评测集 · 运行记录 tabs" : "运行记录 only"}`, async () => {
      routes = { [`GET ${O}/agents`]: { agents: [] } };
      resetNavigation("/trajectories");
      renderPage(<TrajectoriesPage />, { locale: "zh", me: meAs(role) });
      const h1 = screen.getByRole("heading", { level: 1 });
      expect(h1.textContent).toBe(admin ? zh.trajectories.title : zh.trajectories.tabs.runs);
      expect(screen.queryByRole("link", { name: new RegExp(zh.evals.tabs.sets) }) !== null).toBe(
        admin,
      );
    });
  }
});

describe("read-only pages say why (R3)", () => {
  for (const role of ["member", "admin"] as const) {
    it(`/settings/members · ${role}: ${role === "member" ? "a read-only line" : "no line"}`, async () => {
      routes = { [`GET ${O}/members`]: MEMBERS, [`GET ${O}/invitations`]: { invitations: [] } };
      resetNavigation("/settings/members");
      renderPage(<MembersPage />, { locale: "zh", me: meAs(role) });
      await screen.findByText("Mia");
      const line = zh.roles.readOnly.replace("{role}", zh.members.roles.member);
      expect(screen.queryByText(line) !== null).toBe(role === "member");
    });
  }
});
