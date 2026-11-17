import { describeNestedBox, findNestedBoxes } from "@capybara-hq/design/reference";
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { AUDIT_ACTION_KEYS } from "../src/lib/audit-actions";
import type { Me } from "../src/lib/session";
import { bodyOf, json, lastStubRoutes, noContent, stubApi } from "./support/api";
import { resetNavigation } from "./support/navigation";
import { renderRouteWithCache } from "./support/query";
import { ME } from "./support/render";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));

const msgs = { zh, en } as const;
const LOCALES = ["zh", "en"] as const;
const ADMIN_PATH = "/api/v1/admin/orgs/o1/network-allowances";
const ORG_PATH = "/api/v1/orgs/o1/network-allowances";
const SETTINGS = "/api/v1/orgs/o1/settings";
const ROW_ACTIONS = { zh: "行操作", en: "Row actions" } as const;
const ORG_ADMIN: Me = {
  ...ME,
  account: { ...ME.account, isSuperAdmin: false },
  memberships: [{ orgId: "o1", slug: "acme", name: "Acme", role: "admin" }],
};
const MEMBER: Me = {
  ...ME,
  account: { ...ME.account, isSuperAdmin: false },
  memberships: [{ orgId: "o1", slug: "acme", name: "Acme", role: "member" }],
};
const ENTRY = { id: "n1", entry: "mcp.internal", createdAt: "2026-11-17T08:00:00.000Z" };

const ORGS = [
  { id: "o1", slug: "acme", name: "Acme", createdAt: "2026-10-01T00:00:00Z", memberCount: 4 },
];
const LIMIT_DEFAULTS = {
  runConcurrency: 10,
  sandbox: { cpu: 1, memoryMb: 2048 },
  subagents: {
    maxDepth: 3,
    maxConcurrentPerConversation: 4,
    maxDispatchesPerRun: 50,
    maxTokensPerRun: 5_000_000,
  },
};
const DEPLOYMENT_SETTINGS = {
  orgCreation: "anyone",
  runConcurrencyOverrides: {},
  priceCurrency: "USD",
  sandboxLimitOverrides: {},
};

function adminRoutes(extra: Parameters<typeof stubApi>[0] = {}) {
  return stubApi({
    "GET /api/v1/admin/orgs": () => json(200, { orgs: ORGS, limitDefaults: LIMIT_DEFAULTS }),
    "GET /api/v1/admin/extensions": () => json(200, { extensions: [], drainSeconds: 30 }),
    "GET /api/v1/admin/settings": () => json(200, DEPLOYMENT_SETTINGS),
    "GET /api/v1/admin/ui/arrangement": () => json(200, { slots: [] }),
    ...extra,
  });
}

async function openSheet(locale: "zh" | "en") {
  await renderRouteWithCache("/admin/orgs", lastStubRoutes(), { locale });
  const o = msgs[locale].orgNetwork;
  const user = userEvent.setup();
  const table = await screen.findByRole("table", { name: msgs[locale].admin.orgs.title });
  const row = within(table).getByText("Acme").closest("tr") as HTMLElement;
  await user.click(within(row).getByRole("button", { name: ROW_ACTIONS[locale] }));
  await user.click(
    await screen.findByRole("menuitem", { name: msgs[locale].admin.orgs.internalEndpoints }),
  );
  const sheet = await screen.findByRole("dialog", { name: o.sheetTitle.replace("{name}", "Acme") });
  return { user, sheet, o };
}

beforeEach(() => resetNavigation("/admin/orgs"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("org internal endpoints", () => {
  it.each(LOCALES)("a super admin adds and removes an entry (%s)", async (locale) => {
    let list = [ENTRY];
    const calls = adminRoutes({
      [`GET ${ADMIN_PATH}`]: () => json(200, { allowances: list }),
      [`POST ${ADMIN_PATH}`]: (c) => {
        const entry = (bodyOf(c) as { entry: string }).entry;
        const added = { id: "n2", entry, createdAt: "2026-11-17T09:00:00.000Z" };
        list = [...list, added];
        return json(201, { allowance: added });
      },
      [`DELETE ${ADMIN_PATH}/n1`]: () => {
        list = list.filter((a) => a.id !== "n1");
        return noContent();
      },
    });
    const { user, sheet, o } = await openSheet(locale);
    expect(await within(sheet).findByText("mcp.internal")).toBeTruthy();
    await user.type(within(sheet).getByRole("textbox", { name: o.field }), " *.corp.example ");
    await user.click(within(sheet).getByRole("button", { name: o.add }));
    await vi.waitFor(() =>
      expect(bodyOf(calls.find((c) => c.method === "POST"))).toEqual({ entry: "*.corp.example" }),
    );
    expect(await within(sheet).findByText("*.corp.example")).toBeTruthy();
    await user.click(
      within(sheet).getByRole("button", { name: o.removeLabel.replace("{entry}", "mcp.internal") }),
    );
    await vi.waitFor(() =>
      expect(calls.some((c) => c.method === "DELETE" && c.url === `${ADMIN_PATH}/n1`)).toBe(true),
    );
    await vi.waitFor(() => expect(within(sheet).queryByText("mcp.internal")).toBeNull());
    expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
  });

  it("an invalid entry shows the sentence and the kernel's reason behind the toggle", async () => {
    adminRoutes({
      [`GET ${ADMIN_PATH}`]: () => json(200, { allowances: [] }),
      [`POST ${ADMIN_PATH}`]: () =>
        json(400, {
          error: {
            code: "org.network_allowance_invalid",
            message: "localhost: loopback is never allowed",
            details: [{ entry: "localhost", reason: "loopback is never allowed" }],
          },
        }),
    });
    const { user, sheet, o } = await openSheet("en");
    expect(await within(sheet).findByText(o.empty)).toBeTruthy();
    await user.type(within(sheet).getByRole("textbox", { name: o.field }), "localhost");
    await user.click(within(sheet).getByRole("button", { name: o.add }));
    const alert = await within(sheet).findByRole("alert");
    expect(within(alert).getByText(en.errors.org.network_allowance_invalid)).toBeTruthy();
    await user.click(within(alert).getByRole("button"));
    expect(within(alert).getByText(/loopback is never allowed/)).toBeTruthy();
  });

  it.each(LOCALES)("an org admin reads the list without any control (%s)", async (locale) => {
    const o = msgs[locale].orgNetwork;
    const calls = stubApi({
      [`GET ${SETTINGS}`]: () => json(200, { settings: { toolSearch: "on" } }),
      [`GET ${ORG_PATH}`]: () => json(200, { allowances: [ENTRY] }),
      "GET /api/v1/orgs/o1/ui/contributions": () => json(200, { items: [] }),
    });
    resetNavigation("/settings/organization");
    await renderRouteWithCache("/settings/organization", lastStubRoutes(), {
      locale,
      me: ORG_ADMIN,
    });
    const section = await screen.findByRole("region", { name: o.title });
    expect(await within(section).findByText("mcp.internal")).toBeTruthy();
    expect(within(section).getByText(o.sectionHelp)).toBeTruthy();
    expect(within(section).queryByRole("button")).toBeNull();
    expect(within(section).queryByRole("textbox")).toBeNull();
    expect(calls.some((c) => c.url.includes("/admin/"))).toBe(false);
  });

  it("a member sees no section and does not read the list", async () => {
    const calls = stubApi({
      [`GET ${SETTINGS}`]: () => json(200, { settings: { toolSearch: "on" } }),
      "GET /api/v1/orgs/o1/ui/contributions": () => json(200, { items: [] }),
    });
    resetNavigation("/settings/organization");
    await renderRouteWithCache("/settings/organization", lastStubRoutes(), { me: MEMBER });
    await screen.findByText(en.orgSettings.readonly);
    expect(screen.queryByText(en.orgNetwork.title)).toBeNull();
    expect(calls.some((c) => c.url.includes("network-allowances"))).toBe(false);
  });

  it("both audit actions are labelled in zh and en", () => {
    for (const action of ["org.network_allowance_added", "org.network_allowance_removed"]) {
      const key = AUDIT_ACTION_KEYS[action] as string;
      expect(key).toBeTruthy();
      const labels = (m: typeof en) => (m.admin.audit.actions as Record<string, string>)[key];
      expect(labels(en)).toBeTruthy();
      expect(labels(zh as typeof en)).toBeTruthy();
    }
  });
});
