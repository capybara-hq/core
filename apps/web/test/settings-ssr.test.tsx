// The organization and personal settings pages render on the server (web-SSR spec §6, task 9):
// first paint complete without a browser fetch, the gate cases, and the failure modes of R5.
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import ExtensionsPage from "../src/app/(app)/settings/extensions/page";
import MembersPage from "../src/app/(app)/settings/members/page";
import ModelsPage from "../src/app/(app)/settings/models/page";
import OrganizationPage from "../src/app/(app)/settings/organization/page";
import PluginsPage from "../src/app/(app)/settings/plugins/page";
import SandboxPage from "../src/app/(app)/settings/sandbox/page";
import TokensPage from "../src/app/(app)/settings/tokens/page";
import { json } from "./support/api";
import { resetNavigation, router } from "./support/navigation";
import { ME } from "./support/render";
import { expectNoFirstPaintFetch, type Routes, renderRoute } from "./support/server";
import { NOT_READY } from "./support/shell";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

const O = "/api/v1/orgs/o1";
const T = "2026-10-19T12:00:00.000Z";
const as = (role: string) => ({
  ...ME,
  account: { ...ME.account, isEnterpriseAdmin: false },
  memberships: [{ orgId: "o1", slug: "acme", name: "Acme", role }],
});
const failing = () => json(500, { error: { code: "internal", message: "x" } });

const MEMBERS = [
  {
    account: { id: "a1", displayName: "Grant", email: null },
    role: "owner",
    joinedAt: T,
    anonymous: false,
  },
  {
    account: { id: "a2", displayName: "Bob", email: "bob@corp.example" },
    role: "member",
    joinedAt: T,
    anonymous: false,
  },
];
const INVITATION = {
  id: "i1",
  orgId: "o1",
  role: "member",
  createdBy: "a1",
  createdAt: T,
  expiresAt: "2026-10-27T00:00:00.000Z",
  acceptedAt: null,
  revokedAt: null,
  status: "pending",
};
const personalApp = (id: string, name: string) => ({
  id,
  slug: id,
  name,
  connector: "mcp",
  endpoint: {},
  auth: { type: "oauth_code", ownership: "personal" },
  status: "active",
  createdAt: T,
  updatedAt: T,
  tools: [],
  credential: { ownership: "personal", status: "missing" },
});
const IDENTITY = {
  source: "fake-im:t1",
  externalId: "u-alice",
  email: "alice@corp.example",
  emailVerified: true,
  displayName: "Alice Wong",
  avatarUrl: null,
  linkedVia: "bind",
  createdAt: T,
};

const ROUTES: Routes = {
  [`GET ${O}/settings`]: () =>
    json(200, {
      settings: { toolSearch: "off", locale: "en", sandboxToolPolicy: "ask" },
      deployment: { sandboxEgress: { mode: "open", allowHosts: [] } },
      sandboxLimits: { cpu: 2, memoryMb: 4096, source: "deployment" },
    }),
  [`GET ${O}/members`]: () => json(200, { members: MEMBERS }),
  [`GET ${O}/invitations`]: () => json(200, { invitations: [INVITATION] }),
  [`GET ${O}/model-purposes`]: () => json(200, { purposes: [] }),
  [`GET ${O}/models`]: () => json(200, { providers: [] }),
  [`GET ${O}/plugin-installs`]: () => json(200, { installs: [] }),
  [`GET ${O}/extensions`]: () => json(200, { extensions: [] }),
  [`GET ${O}/file-previewers`]: () => json(200, { items: [] }),
  [`GET ${O}/service-tokens`]: () => json(200, { tokens: [] }),
  [`GET ${O}/connectors`]: () =>
    json(200, {
      connectors: [
        personalApp("c1", "Docs"),
        personalApp("c2", "Wiki"),
        { ...personalApp("c3", "Shared"), auth: { type: "oauth_code", ownership: "shared" } },
      ],
    }),
  [`GET ${O}/connectors/c1`]: () => json(200, { connector: personalApp("c1", "Docs") }),
  [`GET ${O}/connectors/c2`]: () => json(200, { connector: personalApp("c2", "Wiki") }),
  [`GET ${O}/me/tool-grants`]: () => json(200, { grants: [] }),
  "GET /api/v1/me/identities": () => json(200, { identities: [IDENTITY] }),
  "GET /api/v1/auth/sources": () => json(200, { sources: [{ plugin: "fake-im" }] }),
};

const template = (name: string) => document.querySelector(`[data-template="${name}"]`);
const noAccess = () => template("StatusPage")?.getAttribute("data-kind") === "no-access";

beforeEach(() => resetNavigation("/settings/organization"));
afterEach(cleanup);

describe("first paint comes from the server (no browser fetch)", () => {
  it("/settings/organization and /settings/sandbox: the settings", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRoute(() => OrganizationPage(), ROUTES);
    expect(
      screen.getByRole("radio", { name: new RegExp(`^${en.orgSettings.toolSearch.off}`) }),
    ).toHaveProperty("checked", true);
    cleanup();
    await renderRoute(() => SandboxPage(), ROUTES);
    expect(
      screen.getByRole("radio", { name: new RegExp(`^${en.orgSettings.sandbox.ask}`) }),
    ).toHaveProperty("checked", true);
    expect(screen.getByText(en.orgSettings.limits.title)).toBeTruthy();
    expect(browser).toEqual([]);
  });

  it("/settings/members: members and, for an admin, the invitations", async () => {
    const browser = expectNoFirstPaintFetch();
    const { calls } = await renderRoute(() => MembersPage(), ROUTES);
    expect(screen.getByText("Bob")).toBeTruthy();
    expect(screen.getByText(en.members.invitations.status.pending)).toBeTruthy();
    expect(calls.map((c) => c.url)).toContain(`${O}/invitations`);
    expect(browser).toEqual([]);
  });

  it("/settings/members: a member reads no invitations", async () => {
    const browser = expectNoFirstPaintFetch();
    const { calls } = await renderRoute(() => MembersPage(), ROUTES, { me: as("member") });
    expect(screen.getByText("Bob")).toBeTruthy();
    expect(calls.map((c) => c.url)).not.toContain(`${O}/invitations`);
    expect(screen.queryByText(en.members.invitations.title)).toBeNull();
    expect(browser).toEqual([]);
  });

  it("/settings/members: invitations the kernel fails draw the table's error, retried on the server", async () => {
    const browser = expectNoFirstPaintFetch();
    const { calls } = await renderRoute(() => MembersPage(), {
      ...ROUTES,
      [`GET ${O}/invitations`]: failing,
    });
    expect(screen.getByText("Bob")).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: en.common.retry }));
    expect(router.refresh).toHaveBeenCalled();
    expect(calls.filter((c) => c.url === `${O}/invitations`).length).toBe(2);
    expect(browser).toEqual([]);
  });

  it("/settings/members: a failing member list is an error, not an empty page", async () => {
    expectNoFirstPaintFetch();
    await expect(
      renderRoute(() => MembersPage(), { ...ROUTES, [`GET ${O}/members`]: failing }),
    ).rejects.toThrow();
  });

  it("/settings/models, /plugins, /extensions, /tokens", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRoute(() => ModelsPage(), ROUTES);
    expect(screen.getByText(en.models.org.description)).toBeTruthy();
    cleanup();
    await renderRoute(() => PluginsPage(), ROUTES);
    expect(screen.getByText(en.catalog.plugins.empty)).toBeTruthy();
    cleanup();
    await renderRoute(() => ExtensionsPage(), ROUTES);
    expect(screen.getByText(en.extensions.empty)).toBeTruthy();
    cleanup();
    await renderRoute(() => TokensPage(), ROUTES);
    expect(screen.getByText(en.tokens.empty)).toBeTruthy();
    expect(browser).toEqual([]);
  });

  it("/settings/extensions: previewers the kernel fails only hide their block", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRoute(() => ExtensionsPage(), { ...ROUTES, [`GET ${O}/file-previewers`]: failing });
    expect(screen.getByText(en.extensions.empty)).toBeTruthy();
    expect(browser).toEqual([]);
  });
});

type Page = () => Promise<ReactNode>;
const GATES: [string, Page, "member" | "admin" | "guest", boolean][] = [
  ["/settings/organization", () => OrganizationPage(), "member", false],
  ["/settings/sandbox", () => SandboxPage(), "member", false],
  ["/settings/members", () => MembersPage(), "member", true],
  ["/settings/models", () => ModelsPage(), "admin", true],
  ["/settings/plugins", () => PluginsPage(), "admin", false],
  ["/settings/extensions", () => ExtensionsPage(), "admin", false],
  ["/settings/tokens", () => TokensPage(), "admin", false],
];

describe("the gates", () => {
  it.each(GATES)(
    "%s: below its role no access and nothing read; no org renders nothing; setup",
    async (_p, page, min, step) => {
      if (min !== "guest") {
        const denied = min === "admin" ? as("member") : as("guest");
        const r = await renderRoute(page, ROUTES, { me: denied });
        expect(new Set(r.calls.map((c) => c.url))).toEqual(
          new Set(["/api/v1/me", `${O}/readiness`]),
        );
        expect(noAccess()).toBe(true);
        cleanup();
      }
      const none = await renderRoute(page, ROUTES, { me: { ...ME, currentOrgId: null } });
      expect(none.calls.map((c) => c.url)).toEqual(["/api/v1/me"]);
      cleanup();
      if (step) {
        await renderRoute(page, ROUTES, { readiness: NOT_READY });
        expect(template("StatusPage")).toBeNull();
        expect(document.querySelector("h1")).not.toBeNull();
      } else {
        await expect(renderRoute(page, ROUTES, { readiness: NOT_READY })).rejects.toThrow(
          "REDIRECT /",
        );
      }
    },
  );
});
