// The org settings tables at 390: members, tokens, schedules and the audit log declare their compact
// rows (title, subtitle, trailing; responsive spec §4.2), and the audit log pages by infinite scroll.
import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import type { Me } from "../src/lib/session";
import { json, lastStubRoutes, stubApi } from "./support/api";
import { resetNavigation } from "./support/navigation";
import { renderRouteWithCache } from "./support/query";
import { ME } from "./support/render";
import { stubWindowWidth } from "./support/width";

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
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
const T = "2026-11-10T08:00:00.000Z";
const admin: Me = {
  ...ME,
  account: { ...ME.account, isSuperAdmin: false },
  memberships: [{ orgId: "o1", slug: "acme", name: "Acme", role: "admin" }],
};

beforeEach(() => void stubWindowWidth(390));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const compact = () => within(document.querySelector('[data-part="table-compact"]') as HTMLElement);
const part = (name: string) =>
  Array.from(document.querySelectorAll(`[data-part="compact-${name}"]`)).map((e) => e.textContent);

describe("org settings tables at 390", () => {
  it("members: the name leads, the email under it, the role at the end", async () => {
    resetNavigation("/settings/members");
    stubApi({
      [`GET ${O}/members`]: () =>
        json(200, {
          members: [
            {
              account: { id: "a2", displayName: "Bob", email: "bob@corp.example", avatarUrl: null },
              role: "member",
              joinedAt: T,
              anonymous: false,
            },
          ],
        }),
      [`GET ${O}/invitations`]: () => json(200, { invitations: [] }),
    });
    await renderRouteWithCache("/settings/members", lastStubRoutes(), { me: admin });
    await screen.findByText("Bob");
    expect(part("subtitle")).toContain("bob@corp.example");
    expect(part("trailing").join()).toContain(en.members.roles.member);
    expect(compact().queryByText(en.members.columns.joined)).toBeNull();
  });

  it("tokens: the name leads, the role under it, the expiry at the end", async () => {
    resetNavigation("/settings/tokens");
    stubApi({
      [`GET ${O}/service-tokens`]: () =>
        json(200, {
          tokens: [
            {
              id: "t1",
              kind: "service",
              accountId: null,
              orgId: "o1",
              role: "member",
              name: "ci",
              createdAt: T,
              lastUsedAt: null,
              expiresAt: null,
            },
          ],
        }),
    });
    await renderRouteWithCache("/settings/tokens", lastStubRoutes(), { me: admin });
    await screen.findByText("ci");
    expect(part("subtitle")).toContain(en.members.roles.member);
    expect(part("trailing")).toContain(en.tokens.noExpiry);
  });

  it("audit: the action leads, the actor and the time under it", async () => {
    resetNavigation("/settings/audit");
    stubApi({
      [`GET ${O}/audit?limit=20`]: () =>
        json(200, {
          events: [
            {
              id: "9",
              at: T,
              actor: { id: "a1", name: "Grant", email: null },
              viaToken: false,
              viaAgent: false,
              action: "org.created",
              target: "x",
            },
          ],
          next: null,
        }),
    });
    await renderRouteWithCache("/settings/audit", lastStubRoutes(), { me: admin });
    await screen.findByText("Grant");
    expect(part("title").join()).toContain(en.admin.audit.actions.orgCreated);
    expect(part("subtitle").join()).toContain("Grant");
    expect(part("subtitle").join()).toMatch(/·/);
  });

  it("schedules: the task leads, its owner under it, the state at the end", async () => {
    resetNavigation("/settings/schedules");
    const settings = {
      toolSearch: "on",
      scheduledTasks: {
        enabled: true,
        minIntervalMinutes: 60,
        maxTasksPerMember: 20,
        maxTasksPerOrg: 200,
        maxRunsPerHour: 60,
        defaultExpiryDays: null,
        catchUpWindowMinutes: 60,
        unattendedAsk: "fail",
        pauseAfterFailures: 5,
        forbiddenTools: [],
      },
    };
    stubApi({
      [`GET ${O}/settings`]: () => json(200, { settings }),
      [`GET ${O}/schedules?all=true`]: () =>
        json(200, {
          items: [
            {
              id: "s1",
              orgId: "o1",
              accountId: "a2",
              agentId: "ag1",
              name: "Daily report",
              prompt: "x",
              trigger: { kind: "cron", expr: "0 9 * * 1-5", timeZone: "Asia/Shanghai" },
              mode: "new",
              conversationId: null,
              chat: null,
              model: null,
              effort: null,
              deviceId: null,
              status: "active",
              pauseReason: null,
              pausedBy: null,
              nextRunAt: T,
              jitterSeconds: 0,
              expiresAt: null,
              consecutiveFailures: 0,
              lastRun: null,
              createdAt: T,
              updatedAt: T,
            },
          ],
        }),
      [`GET ${O}/agents`]: () => json(200, { agents: [] }),
      [`GET ${O}/members`]: () =>
        json(200, {
          members: [
            {
              account: { id: "a2", displayName: "Mei", email: null, avatarUrl: null },
              role: "member",
              joinedAt: T,
              anonymous: false,
            },
          ],
        }),
    });
    await renderRouteWithCache("/settings/schedules", lastStubRoutes(), { me: admin });
    await screen.findByText("Daily report");
    expect(part("title").join()).toContain("Daily report");
    expect(await screen.findByText("Mei")).toBeTruthy();
    expect(part("trailing").join()).toContain(en.schedules.state.active);
    expect(compact().queryByText(en.schedules.columns.lastResult)).toBeNull();
  });
});
