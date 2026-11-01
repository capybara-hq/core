// The admin console renders on the server (web-SSR spec §6, task 10): first paint complete without a
// browser fetch, the enterprise-admin gate (only the session is read below it), and R5's failures.
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import AdminAccountsPage from "../src/app/(app)/admin/accounts/page";
import AdminModelsPage from "../src/app/(app)/admin/models/page";
import AdminOrgsPage from "../src/app/(app)/admin/orgs/page";
import AdminOverviewPage from "../src/app/(app)/admin/page";
import AdminSettingsPage from "../src/app/(app)/admin/settings/page";
import { json } from "./support/api";
import { resetNavigation } from "./support/navigation";
import { ME } from "./support/render";
import { expectNoFirstPaintFetch, type Routes, renderRoute } from "./support/server";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

const T = "2026-10-19T12:00:00.000Z";
const NOT_ADMIN = { ...ME, account: { ...ME.account, isEnterpriseAdmin: false } };
const failing = () => json(500, { error: { code: "internal", message: "x" } });
const template = (name: string) => document.querySelector(`[data-template="${name}"]`);
const noAccess = () => template("StatusPage")?.getAttribute("data-kind") === "no-access";

const ACCOUNT = (id: string, name: string) => ({
  id,
  displayName: name,
  email: null,
  status: "active",
  isEnterpriseAdmin: id === "a1",
  createdAt: T,
});
const SETTINGS = {
  orgCreation: "anyone",
  runConcurrencyOverrides: { o2: 3 },
  priceCurrency: "USD",
  sandboxLimitOverrides: {},
  customConnectors: "allow",
  customSkills: "allow",
};

const ROUTES: Routes = {
  "GET /api/v1/admin/overview": () =>
    json(200, { extensionsNeedingAction: 3, catalogRequestsPending: 1, orgs: 2, accounts: 7 }),
  "GET /api/v1/admin/accounts": () =>
    json(200, { accounts: [ACCOUNT("a1", "Grant"), ACCOUNT("a2", "Alice")], next: "a2" }),
  "GET /api/v1/admin/orgs": () =>
    json(200, { orgs: [{ id: "o2", slug: "beta", name: "Beta", memberCount: 4, createdAt: T }] }),
  "GET /api/v1/admin/settings": () => json(200, SETTINGS),
  "GET /api/v1/admin/models": () => json(200, { providers: [], prices: [], currency: "EUR" }),
  "GET /api/v1/admin/model-purposes": () => json(200, { purposes: [] }),
};

beforeEach(() => resetNavigation("/admin"));
afterEach(cleanup);

describe("first paint comes from the server (no browser fetch)", () => {
  it("/admin: the four numbers", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRoute(() => AdminOverviewPage(), ROUTES);
    expect(screen.getByText("7")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
    expect(browser).toEqual([]);
  });

  it("/admin/accounts: the first page, with load more when there is a next", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRoute(() => AdminAccountsPage(), ROUTES);
    expect(screen.getByText("Alice")).toBeTruthy();
    expect(screen.getByRole("button", { name: en.admin.accounts.loadMore })).toBeTruthy();
    expect(browser).toEqual([]);
  });

  it("/admin/orgs: the orgs with the deployment overrides", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRoute(() => AdminOrgsPage(), ROUTES);
    expect(screen.getByText("Beta")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
    expect(browser).toEqual([]);
  });

  it("/admin/settings and /admin/models", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRoute(() => AdminSettingsPage(), ROUTES);
    expect(screen.getByDisplayValue("USD")).toBeTruthy();
    cleanup();
    await renderRoute(() => AdminModelsPage(), ROUTES);
    expect(screen.getByText(en.models.admin.noProviders)).toBeTruthy();
    expect(browser).toEqual([]);
  });

  it("a failing required read is an error, not an empty page", async () => {
    expectNoFirstPaintFetch();
    await expect(
      renderRoute(() => AdminOrgsPage(), { ...ROUTES, "GET /api/v1/admin/settings": failing }),
    ).rejects.toThrow();
  });
});

type Page = () => Promise<ReactNode>;
const PAGES: [string, Page][] = [
  ["/admin", () => AdminOverviewPage()],
  ["/admin/accounts", () => AdminAccountsPage()],
  ["/admin/orgs", () => AdminOrgsPage()],
  ["/admin/settings", () => AdminSettingsPage()],
  ["/admin/models", () => AdminModelsPage()],
];

describe("the enterprise-admin gate", () => {
  it.each(PAGES)(
    "%s: a non-admin gets no access and only the session is read",
    async (_p, page) => {
      const r = await renderRoute(page, ROUTES, { me: NOT_ADMIN });
      expect(r.calls.map((c) => c.url)).toEqual(["/api/v1/me"]);
      expect(noAccess()).toBe(true);
    },
  );

  it("an admin needs no org: nothing is redirected", async () => {
    await renderRoute(() => AdminOverviewPage(), ROUTES, { me: { ...ME, currentOrgId: null } });
    expect(noAccess()).toBe(false);
  });
});

describe("accounts: load more stays in the browser", () => {
  it("appends the next page and drops the button at the end", async () => {
    expectNoFirstPaintFetch();
    const { calls } = await renderRoute(() => AdminAccountsPage(), ROUTES);
    const browser = (await import("./support/api")).stubApi({
      "GET /api/v1/admin/accounts": () =>
        json(200, { accounts: [ACCOUNT("a3", "Carol")], next: null }),
    });
    await userEvent.setup().click(screen.getByRole("button", { name: en.admin.accounts.loadMore }));
    expect(await screen.findByText("Carol")).toBeTruthy();
    expect(screen.queryByRole("button", { name: en.admin.accounts.loadMore })).toBeNull();
    expect(browser.map((c) => c.url)).toEqual(["/api/v1/admin/accounts?limit=200&after=a2"]);
    expect(calls.filter((c) => c.url.startsWith("/api/v1/admin/accounts")).length).toBe(1);
  });
});
