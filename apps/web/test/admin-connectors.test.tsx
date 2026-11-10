// The admin console's 连接器 tab (spec 2026-11-10-admin-agents-connectors §3.4, §3.5, §5): every
// org's connectors with the org / status filters and the name search, the read-only detail with
// 停用 / 启用 and 删除, and the mutations' cache invalidation.
import { describeNestedBox, findNestedBoxes } from "@capybara-hq/design/reference";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { ADMIN_PAGES } from "../src/components/admin-nav";
import { activeAdminOf } from "../src/components/shell/nav";
import { APP_PAGES } from "../src/components/shell/path";
import { adminConnectorsQuery } from "../src/lib/query/admin-items";
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

const C = en.adminItems.connectors;
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
  id: "c1",
  orgId: "o1",
  orgName: "Acme",
  name: "Jira",
  slug: "jira",
  connector: "mcp",
  status: "active",
  platformTemplateId: "ct1",
  templateName: "jira-kit",
  catalogItemId: null,
  toolCount: 4,
  toolsSyncedAt: T,
  createdBy: "u1",
  createdByName: "Grant",
  createdAt: T,
  updatedAt: T,
  ...over,
});
const ROWS = [
  row(),
  row({
    id: "c2",
    orgId: "o2",
    orgName: "Beta",
    name: "Billing API",
    slug: "billing",
    connector: "openapi",
    status: "disabled",
    platformTemplateId: null,
    templateName: null,
    toolCount: 0,
    toolsSyncedAt: null,
    createdByName: "Lin",
  }),
];
const DETAIL = {
  ...row(),
  endpoint: { url: "https://jira.example.test/mcp", spec: { size: 1200, sha256: "abc123" } },
  auth: { type: "bearer", ownership: "personal" },
  tools: [
    { name: "search", title: "Search issues", status: "enabled", defaultPolicy: "allow" },
    { name: "create", title: null, status: "pending_review", defaultPolicy: "ask" },
    { name: "purge", title: "Purge", status: "disabled", defaultPolicy: "deny" },
  ],
};

const LIST = "/api/v1/admin/connectors";
const base: Routes = {
  "GET /api/v1/admin/orgs": () => json(200, ORGS),
  [`GET ${LIST}`]: () => json(200, { connectors: ROWS, next: null }),
  [`GET ${LIST}/c1`]: () => json(200, { connector: DETAIL }),
};

beforeEach(() => {
  resetNavigation("/admin/connectors");
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

describe("/admin/connectors", () => {
  it("lists name, org, kind, template, status, tools, last sync and creator; no browser read", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRouteWithCache("/admin/connectors", base);
    const table = await screen.findByRole("table", { name: C.listLabel });
    expect(browser).toEqual([]);
    const headers = within(table)
      .getAllByRole("columnheader")
      .map((h) => h.textContent);
    expect(headers).toEqual([
      C.columns.name,
      C.columns.org,
      C.columns.kind,
      C.columns.from,
      C.columns.status,
      C.columns.tools,
      C.columns.synced,
      C.columns.createdBy,
    ]);
    const first = within(table).getByText("Jira").closest("tr") as HTMLElement;
    expect(within(first).getByText("Acme")).toBeTruthy();
    expect(within(first).getByText("mcp")).toBeTruthy();
    expect(within(first).getByText("jira-kit")).toBeTruthy();
    expect(within(first).getByText(C.status.active)).toBeTruthy();
    expect(within(first).getByText("4")).toBeTruthy();
    expect(first.querySelector("time")).not.toBeNull();
    expect(within(first).getByText("Grant")).toBeTruthy();
    const second = within(table).getByText("Billing API").closest("tr") as HTMLElement;
    expect(within(second).getByText("openapi")).toBeTruthy();
    expect(within(second).getByText(C.status.disabled)).toBeTruthy();
    expect(within(second).getByText(C.never)).toBeTruthy();
    expect(second.querySelector("time")).toBeNull();
    // the header tabs: 连接器 active, 模板 a link
    const items = screen.getByRole("link", { name: en.adminItems.tabs.connectors });
    expect([items.getAttribute("href"), items.getAttribute("aria-current")]).toEqual([
      "/admin/connectors",
      "page",
    ]);
    expect(
      screen.getByRole("link", { name: en.adminItems.tabs.templates }).getAttribute("href"),
    ).toBe("/admin/connectors/templates");
    expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
    expect(zh.adminItems.connectors.status).toEqual({ active: "启用", disabled: "停用" });
  });

  it("a row opens the connector's detail", async () => {
    await open("/admin/connectors");
    const user = userEvent.setup();
    await user.click(await screen.findByText("Billing API"));
    expect(router.push).toHaveBeenCalledWith("/admin/connectors/c2");
  });

  it("the org filter, the status filter and the search change the address, which reads it", async () => {
    const { calls, navigate } = await open("/admin/connectors");
    const user = userEvent.setup();
    await pickOption(await screen.findByRole("combobox", { name: C.filters.org }), "o2", user);
    expect(router.replace).toHaveBeenLastCalledWith("/admin/connectors?orgId=o2");
    await act(() => navigate("/admin/connectors?orgId=o2"));
    await waitFor(() => expect(calls.map((c) => c.url)).toContain(`${LIST}?orgId=o2`));

    await pickOption(
      await screen.findByRole("combobox", { name: C.filters.status }),
      "disabled",
      user,
    );
    expect(router.replace).toHaveBeenLastCalledWith("/admin/connectors?orgId=o2&status=disabled");
    await act(() => navigate("/admin/connectors?orgId=o2&status=disabled"));
    await waitFor(() =>
      expect(calls.map((c) => c.url)).toContain(`${LIST}?orgId=o2&status=disabled`),
    );

    await user.type(screen.getByRole("searchbox", { name: C.search }), "bil");
    await waitFor(() =>
      expect(router.replace).toHaveBeenLastCalledWith(
        "/admin/connectors?orgId=o2&status=disabled&q=bil",
      ),
    );
    await act(() => navigate("/admin/connectors?orgId=o2&status=disabled&q=bil"));
    await waitFor(() =>
      expect(calls.map((c) => c.url)).toContain(`${LIST}?orgId=o2&status=disabled&q=bil`),
    );
  });

  it("a filtered first load reads that filter on the server", async () => {
    const { calls } = await renderRouteWithCache(
      "/admin/connectors?orgId=o1&status=active&q=ji",
      base,
    );
    expect(calls.map((c) => c.url)).toContain(`${LIST}?orgId=o1&status=active&q=ji`);
  });

  it("Load more reads the page after the cursor", async () => {
    const { calls } = await open("/admin/connectors", {
      [`GET ${LIST}`]: (c) =>
        c.url.includes("after=c1")
          ? json(200, { connectors: [ROWS[1]], next: null })
          : json(200, { connectors: [ROWS[0]], next: "c1" }),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: C.loadMore }));
    expect(await screen.findByText("Billing API")).toBeTruthy();
    expect(calls.map((c) => c.url)).toContain(`${LIST}?after=c1`);
    expect(screen.queryByRole("button", { name: C.loadMore })).toBeNull();
  });

  it("empty: no org has added a connector yet", async () => {
    await open("/admin/connectors", {
      [`GET ${LIST}`]: () => json(200, { connectors: [], next: null }),
    });
    expect(await screen.findByText(C.empty)).toBeTruthy();
    expect(zh.adminItems.connectors.empty).toBe("还没有组织添加连接器");
  });

  it("an empty cache shows the table's loading state, then the rows", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    await renderRouteEmptyCache("/admin/connectors", {
      ...base,
      [`GET ${LIST}`]: async () => {
        await gate;
        return json(200, { connectors: ROWS, next: null });
      },
    });
    await vi.waitFor(() => expect(document.querySelector('[aria-busy="true"]')).not.toBeNull());
    await act(async () => release());
    expect(await screen.findByText("Jira")).toBeTruthy();
  });

  it("a non super admin gets no access and no admin read", async () => {
    const calls = stubApi({});
    await renderRouteWithCache("/admin/connectors", base, { me: NOT_ADMIN });
    expect(template("StatusPage")?.getAttribute("data-kind")).toBe("no-access");
    expect(calls).toEqual([]);
  });
});

describe("/admin/connectors/[id]", () => {
  it("shows the facts, the endpoint view and the tools; no credential section; no browser read", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRouteWithCache("/admin/connectors/c1", base);
    expect(await screen.findByRole("heading", { level: 1, name: "Jira" })).toBeTruthy();
    expect(browser).toEqual([]);
    expect(template("DetailPage")).not.toBeNull();
    expect(screen.getByText("Acme")).toBeTruthy();
    expect(screen.getByText("mcp")).toBeTruthy();
    expect(screen.getByText(C.fromPlatform)).toBeTruthy();
    // auth: type and ownership only
    expect(screen.getByText(C.detail.auth.bearer)).toBeTruthy();
    expect(screen.getByText(C.detail.ownership.personal)).toBeTruthy();
    // the endpoint view as given (large fields as size and sha256)
    const body = document.body.textContent ?? "";
    expect(body).toContain("https://jira.example.test/mcp");
    expect(body).toContain("abc123");
    // the tools: title or name, status and policy
    const tools = screen.getByRole("list", { name: C.detail.sections.tools });
    const text = within(tools)
      .getAllByRole("listitem")
      .map((r) => r.textContent ?? "");
    expect(text[0]).toContain("Search issues");
    expect(text[0]).toContain(C.detail.toolStatus.enabled);
    expect(text[0]).toContain(C.detail.policy.allow);
    expect(text[1]).toContain("create");
    expect(text[1]).toContain(C.detail.toolStatus.pending_review);
    expect(text[1]).toContain(C.detail.policy.ask);
    expect(text[2]).toContain(C.detail.toolStatus.disabled);
    expect(text[2]).toContain(C.detail.policy.deny);
    // no credential section, nothing about a member's credential
    expect(screen.queryByText(/credential/i)).toBeNull();
    expect(screen.queryByText(/凭据/)).toBeNull();
    expect(screen.queryByRole("heading", { name: /credential/i })).toBeNull();
    // the actions: 停用 while active, 删除
    expect(screen.getByRole("button", { name: C.actions.disable })).toBeTruthy();
    expect(screen.queryByRole("button", { name: C.actions.enable })).toBeNull();
    expect(screen.getByRole("button", { name: C.actions.delete })).toBeTruthy();
    // the path links back to the list
    expect(screen.getByRole("link", { name: "connectors" }).getAttribute("href")).toBe(
      "/admin/connectors",
    );
    expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
    expect(zh.adminItems.connectors.actions).toEqual({
      disable: "停用",
      enable: "启用",
      delete: "删除",
    });
  });

  it("a disabled connector offers 启用", async () => {
    await open("/admin/connectors/c1", {
      [`GET ${LIST}/c1`]: () => json(200, { connector: { ...DETAIL, status: "disabled" } }),
    });
    expect(await screen.findByRole("button", { name: C.actions.enable })).toBeTruthy();
    expect(screen.queryByRole("button", { name: C.actions.disable })).toBeNull();
  });

  it("a missing connector is the not-found state", async () => {
    await open("/admin/connectors/nope", {
      [`GET ${LIST}/nope`]: () =>
        json(404, { error: { code: "connector.not_found", message: "Connector not found" } }),
    });
    expect(template("StatusPage")?.getAttribute("data-kind")).toBe("404");
  });

  it("停用 patches { status } and the detail and the list are read again", async () => {
    let status = "active";
    const { calls } = await open("/admin/connectors/c1", {
      [`GET ${LIST}/c1`]: () => json(200, { connector: { ...DETAIL, status } }),
      [`PATCH ${LIST}/c1`]: () => {
        status = "disabled";
        return json(200, { connector: { ...DETAIL, status } });
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: C.actions.disable }));
    expect(await screen.findByRole("button", { name: C.actions.enable })).toBeTruthy();
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.url).toBe(`${LIST}/c1`);
    expect(bodyOf(patch)).toEqual({ status: "disabled" });
    // the detail was invalidated and read again
    const patchAt = calls.findIndex((c) => c.method === "PATCH");
    expect(
      calls.slice(patchAt + 1).filter((c) => c.method === "GET" && c.url === `${LIST}/c1`).length,
    ).toBeGreaterThanOrEqual(1);
  });

  it("启用 patches { status: active }", async () => {
    let status = "disabled";
    const { calls } = await open("/admin/connectors/c1", {
      [`GET ${LIST}/c1`]: () => json(200, { connector: { ...DETAIL, status } }),
      [`PATCH ${LIST}/c1`]: () => {
        status = "active";
        return json(200, { connector: { ...DETAIL, status } });
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: C.actions.enable }));
    expect(await screen.findByRole("button", { name: C.actions.disable })).toBeTruthy();
    expect(bodyOf(calls.find((c) => c.method === "PATCH"))).toEqual({ status: "active" });
  });

  it("toggling marks the cached list and the detail stale (read again on the next visit)", async () => {
    let status = "active";
    const { client } = await open("/admin/connectors/c1", {
      [`GET ${LIST}/c1`]: () => json(200, { connector: { ...DETAIL, status } }),
      [`PATCH ${LIST}/c1`]: () => {
        status = "disabled";
        return json(200, { connector: { ...DETAIL, status } });
      },
    });
    // the list was read earlier (a visit to it); no page observes it now
    await client.prefetchQuery(adminConnectorsQuery({}));
    const listKey = adminConnectorsQuery({}).queryKey;
    expect(client.getQueryState(listKey)?.isInvalidated).toBe(false);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: C.actions.disable }));
    await waitFor(() => expect(client.getQueryState(listKey)?.isInvalidated).toBe(true));
    // the open detail is read again at once
    expect(await screen.findByRole("button", { name: C.actions.enable })).toBeTruthy();
  });

  it("删除 names the org, deletes and goes back to the list", async () => {
    const { calls } = await open("/admin/connectors/c1", {
      [`DELETE ${LIST}/c1`]: () => new Response(null, { status: 204 }),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: C.actions.delete }));
    const dialog = await screen.findByRole("dialog", {
      name: fill(C.delete.title, { name: "Jira" }),
    });
    expect(dialog.textContent).toContain(fill(C.delete.hint, { org: "Acme" }));
    await user.click(within(dialog).getByRole("button", { name: C.delete.confirm }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/admin/connectors"));
    expect(calls.some((c) => c.method === "DELETE" && c.url === `${LIST}/c1`)).toBe(true);
  });

  it("after 删除 the cached list is stale", async () => {
    const { client } = await open("/admin/connectors/c1", {
      [`DELETE ${LIST}/c1`]: () => new Response(null, { status: 204 }),
    });
    await client.prefetchQuery(adminConnectorsQuery({}));
    const listKey = adminConnectorsQuery({}).queryKey;
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: C.actions.delete }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: C.delete.confirm }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/admin/connectors"));
    expect(client.getQueryState(listKey)?.isInvalidated).toBe(true);
  });
});

describe("admin nav and paths", () => {
  it("highlights 连接器 on the list, its detail and the template pages", () => {
    for (const p of [
      "/admin/connectors",
      "/admin/connectors/c1",
      "/admin/connectors/templates",
      "/admin/connectors/templates/a1",
    ]) {
      expect(activeAdminOf(p, [...ADMIN_PAGES])).toBe("connectors");
    }
  });

  it("the connector pages are app pages (path segments link to them)", () => {
    expect(APP_PAGES).toContain("/admin/connectors");
    expect(APP_PAGES).toContain("/admin/connectors/[id]");
  });
});
