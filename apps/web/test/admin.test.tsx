import { describeNestedBox, findNestedBoxes } from "@capybara-hq/design/reference";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { activeNavOf } from "../src/components/shell/nav";
import { Catalog } from "../src/dev/catalog";
import type { Me } from "../src/lib/session";
import { bodyOf, json, lastStubRoutes, stubApi } from "./support/api";
import { resetNavigation } from "./support/navigation";
import { renderRouteWithCache } from "./support/query";
import { ME, renderPage } from "./support/render";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));

const msgs = { zh, en } as const;
const LOCALES = ["zh", "en"] as const;
const ROW_ACTIONS = { zh: "行操作", en: "Row actions" } as const;
const NOT_ADMIN: Me = { ...ME, account: { ...ME.account, isSuperAdmin: false } };
const template = (name: string) => document.querySelector(`[data-template="${name}"]`);
const fill = (s: string, vars: Record<string, string | number>) =>
  s.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k]));

const SETTINGS = {
  orgCreation: "anyone",
  runConcurrencyOverrides: { o2: 3 },
  priceCurrency: "USD",
  sandboxLimitOverrides: { o2: { cpu: 2 } },
  customConnectors: "allow",
  customSkills: "allow",
};

beforeEach(() => resetNavigation("/admin"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("管理后台导航", () => {
  it("/admin 下的路由归在一级导航「管理」", () => {
    expect(activeNavOf("/admin")).toBe("admin");
    expect(activeNavOf("/admin/accounts")).toBe("admin");
    expect(activeNavOf("/administrator")).toBe("");
  });
});

const OV_T = "2026-11-10T08:00:00.000Z";
const BY_TYPE = {
  catalog_request: 3,
  permission_confirmation: 0,
  scope_sync_failed: 2,
  platform_migration: 1,
  ownership_transferred: 0,
  org_upload_pending: 0,
};
const OV_INBOX = { items: [], truncated: false, total: 6, byType: BY_TYPE };
const ATTENTION = {
  extensions: [
    {
      name: "crm",
      displayName: { zh: "客户管理", en: "CRM" },
      icon: null,
      status: "pending_config",
      reason: "config",
    },
    { name: "bad-config", displayName: null, icon: null, status: "enabled", reason: "config" },
    { name: "lark", displayName: null, icon: null, status: "failed", reason: "load_failed" },
  ],
  updates: [
    {
      itemId: "item-1",
      name: "slack",
      displayName: null,
      icon: null,
      version: "1.2.0",
      marketplaceVersion: "1.3.0",
      marketplaceId: "official",
      marketplaceName: "Capybara Official",
    },
  ],
  providers: [{ plugin: "model-openai", displayName: null, icon: null, problem: "list_failed" }],
  more: { extensions: 2, updates: 0, providers: 0 },
  unavailable: [],
};
const EMPTY_ATTENTION = {
  extensions: [],
  updates: [],
  providers: [],
  more: { extensions: 0, updates: 0, providers: 0 },
  unavailable: [],
};
const AUDIT = {
  events: [
    {
      id: "3",
      at: OV_T,
      actor: null,
      viaToken: false,
      viaAgent: false,
      action: "bootstrap.completed",
      target: null,
    },
    {
      id: "2",
      at: OV_T,
      actor: { id: "a1", name: "Grant", email: null },
      viaToken: false,
      viaAgent: true,
      action: "marketplace.added",
      target: "official",
    },
    {
      id: "1",
      at: OV_T,
      actor: { id: "a2", name: "Alice", email: "alice@example.com" },
      viaToken: true,
      viaAgent: false,
      action: "weird.unlabelled_action",
      target: "x-1",
    },
  ],
  next: null,
};
const overviewRoutes = (over: Record<string, () => Response> = {}) => ({
  "GET /api/v1/admin/overview": () => json(200, { orgs: 2, accounts: 7, attentionTotal: 12 }),
  "GET /api/v1/admin/inbox": () => json(200, OV_INBOX),
  "GET /api/v1/admin/inbox/count": () => json(200, { total: 6 }),
  "GET /api/v1/admin/overview/attention": () => json(200, ATTENTION),
  "GET /api/v1/admin/audit": () => json(200, AUDIT),
  ...over,
});
/** The section titled `title` (an OverviewSection is the section's Card). */
const section = (title: string) =>
  screen
    .getAllByText(title)
    .map((el) => el.closest('[data-part="overview-section"]'))
    .find((el): el is HTMLElement => el !== null) as HTMLElement;
const metricsOf = async (container: HTMLElement) =>
  vi.waitFor(() => {
    const m = container.querySelector('[data-part="stat-cards"]');
    if (!m) throw new Error("no metrics yet");
    return m as HTMLElement;
  });

describe("/admin 概览（OverviewPage）", () => {
  it.each(LOCALES)("超级管理员：三个数字与各页入口，页脚说明（%s）", async (locale) => {
    const a = msgs[locale].admin;
    stubApi(overviewRoutes());
    const { container } = await renderRouteWithCache("/admin", lastStubRoutes(), { locale });
    expect(template("OverviewPage")).not.toBeNull();
    const metrics = await metricsOf(container);
    const metric = (label: string) =>
      within(within(metrics).getByText(label).parentElement as HTMLElement);
    expect(metric(a.overview.metrics.attention).getByText("12")).toBeTruthy();
    expect(metric(a.overview.metrics.orgs).getByText("2")).toBeTruthy();
    expect(metric(a.overview.metrics.accounts).getByText("7")).toBeTruthy();
    expect(container.querySelectorAll('[data-part="stat-card"]')).toHaveLength(3);
    const statLink = (label: string) =>
      within(metrics).getByText(label).closest("a")?.getAttribute("href");
    expect(statLink(a.overview.metrics.attention)).toBe("/admin/inbox");
    expect(statLink(a.overview.metrics.orgs)).toBe("/admin/orgs");
    expect(statLink(a.overview.metrics.accounts)).toBe("/admin/accounts");
    const description = container.querySelector('[data-part="page-header-description"]');
    expect(description?.textContent).toBe(a.overview.intro);
    // the privacy footnote is muted prose under the sections, not a callout
    const footnote = screen.getByText(a.overview.footnote);
    expect(footnote.getAttribute("data-variant")).toBe("prose");
    expect(footnote.getAttribute("data-tone")).toBe("muted");
    expect(screen.queryByRole("note")).toBeNull();
  });

  it.each(LOCALES)("待处理：收件箱按类型、扩展、插件更新与模型供应商（%s）", async (locale) => {
    const o = msgs[locale].admin.overview.attention;
    stubApi(overviewRoutes());
    await renderRouteWithCache("/admin", lastStubRoutes(), { locale });
    const box = await vi.waitFor(() => {
      const s = section(o.title);
      if (s.getAttribute("data-state") !== "ready") throw new Error("not ready");
      return within(s);
    });
    // the inbox: one row per type with items, its count and where it is handled
    const inbox = box.getByRole("list", { name: o.groups.inbox });
    const typeRow = (label: string) => within(inbox).getByText(label).closest("li") as HTMLElement;
    expect(within(typeRow(o.inboxTypes.catalog_request)).getByText("3")).toBeTruthy();
    expect(
      within(inbox).getByRole("link", { name: o.inboxTypes.catalog_request }).getAttribute("href"),
    ).toBe("/admin/plugins/pending");
    expect(
      within(inbox)
        .getByRole("link", { name: o.inboxTypes.scope_sync_failed })
        .getAttribute("href"),
    ).toBe("/admin/inbox?type=scope_sync_failed");
    expect(within(typeRow(o.inboxTypes.platform_migration)).getByText("1")).toBeTruthy();
    expect(within(inbox).queryByText(o.inboxTypes.permission_confirmation)).toBeNull();
    expect(box.getByRole("link", { name: o.viewInbox }).getAttribute("href")).toBe("/admin/inbox");
    // extensions: the reason in words, linking to the extension
    const exts = box.getByRole("list", { name: o.groups.extensions });
    const crm = locale === "zh" ? "客户管理" : "CRM";
    expect(within(exts).getByRole("link", { name: crm }).getAttribute("href")).toBe(
      "/admin/extensions/crm",
    );
    const extRow = (name: string) => within(exts).getByText(name).closest("li") as HTMLElement;
    expect(within(extRow(crm)).getByText(o.reasons.missingConfig)).toBeTruthy();
    expect(within(extRow("bad-config")).getByText(o.reasons.invalidConfig)).toBeTruthy();
    expect(within(extRow("lark")).getByText(o.reasons.load_failed)).toBeTruthy();
    // a capped list ends with "+n", linking to the full list
    const more = fill(o.more, { n: 2 });
    expect(within(exts).getByRole("link", { name: more }).getAttribute("href")).toBe(
      "/admin/extensions",
    );
    // plugin updates: the two versions
    const updates = box.getByRole("list", { name: o.groups.updates });
    expect(within(updates).getByText("v1.2.0 → v1.3.0")).toBeTruthy();
    // and the marketplace it comes from
    expect(within(updates).getByText("Capybara Official")).toBeTruthy();
    expect(within(updates).getByRole("link", { name: "slack" }).getAttribute("href")).toBe(
      "/admin/plugins/item-1",
    );
    // providers: the problem in words
    const providers = box.getByRole("list", { name: o.groups.providers });
    expect(within(providers).getByText(o.problems.list_failed)).toBeTruthy();
    expect(within(providers).getByRole("link", { name: "model-openai" }).getAttribute("href")).toBe(
      "/admin/models",
    );
    expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
  });

  it("待处理：读不到的列表显示「暂时无法读取」，其余照常", async () => {
    const o = zh.admin.overview.attention;
    stubApi(
      overviewRoutes({
        "GET /api/v1/admin/overview/attention": () =>
          json(200, { ...ATTENTION, providers: [], unavailable: ["providers"] }),
      }),
    );
    await renderRouteWithCache("/admin", lastStubRoutes(), { locale: "zh" });
    expect(await screen.findByText(o.unavailable)).toBeTruthy();
    const box = within(section(o.title));
    expect(box.getByText(o.groups.providers)).toBeTruthy();
    expect(box.queryByRole("list", { name: o.groups.providers })).toBeNull();
    expect(box.getByRole("list", { name: o.groups.extensions })).toBeTruthy();
  });

  it("待处理：什么都没有时是区块里的空状态", async () => {
    const o = zh.admin.overview.attention;
    stubApi(
      overviewRoutes({
        "GET /api/v1/admin/inbox": () =>
          json(200, {
            ...OV_INBOX,
            total: 0,
            byType: Object.fromEntries(Object.keys(BY_TYPE).map((k) => [k, 0])),
          }),
        "GET /api/v1/admin/overview/attention": () => json(200, EMPTY_ATTENTION),
      }),
    );
    await renderRouteWithCache("/admin", lastStubRoutes(), { locale: "zh" });
    const empty = await screen.findByText(o.empty);
    expect(section(o.title).contains(empty)).toBe(true);
    expect(within(section(o.title)).queryByRole("list")).toBeNull();
  });

  it("待处理读取失败：只有这个区块出错，重试只重读它；数字与平台操作照常", async () => {
    const o = zh.admin.overview;
    let failing = true;
    const calls = stubApi(
      overviewRoutes({
        "GET /api/v1/admin/overview/attention": () =>
          failing
            ? json(500, { error: { code: "internal", message: "boom" } })
            : json(200, ATTENTION),
      }),
    );
    const { container } = await renderRouteWithCache("/admin", lastStubRoutes(), {
      locale: "zh",
    });
    const alert = await vi.waitFor(() => within(section(o.attention.title)).getByRole("alert"), {
      timeout: 3000,
    });
    expect(within(alert).getByText(o.attention.failed)).toBeTruthy();
    // the numbers and the audit section are there
    const metrics = await metricsOf(container);
    expect(within(metrics).getByText("12")).toBeTruthy();
    expect(within(section(o.audit.title)).getByText("Grant")).toBeTruthy();
    const before = calls.map((c) => c.url);
    failing = false;
    await userEvent.setup().click(within(alert).getByRole("button", { name: "重试" }));
    await vi.waitFor(() =>
      expect(within(section(o.attention.title)).getByText("v1.2.0 → v1.3.0")).toBeTruthy(),
    );
    const after = calls.slice(before.length).map((c) => new URL(c.url, "http://x").pathname);
    expect(after).toEqual(["/api/v1/admin/overview/attention"]);
  });

  it.each(LOCALES)(
    "最近的平台操作：系统、经由智能体、个人令牌、未知操作原样显示（%s）",
    async (locale) => {
      const m = msgs[locale].admin;
      stubApi(overviewRoutes());
      await renderRouteWithCache("/admin", lastStubRoutes(), { locale });
      const box = within(section(m.overview.audit.title));
      const table = box.getByRole("table", { name: m.overview.audit.title });
      for (const h of Object.values(m.audit.columns)) {
        expect(within(table).getByRole("columnheader", { name: h })).toBeTruthy();
      }
      const row = (text: string) => within(table).getByText(text).closest("tr") as HTMLElement;
      expect(
        within(row(m.audit.system)).getByText(m.audit.actions.bootstrapCompleted),
      ).toBeTruthy();
      expect(within(row("Grant")).getByText(m.audit.viaAgent)).toBeTruthy();
      expect(within(row("Grant")).getByText(m.audit.actions.marketplaceAdded)).toBeTruthy();
      expect(within(row("Grant")).getByText("official")).toBeTruthy();
      expect(within(row("Alice")).getByText(m.audit.viaToken)).toBeTruthy();
      // an action without a label is shown as written, in mono (not prose)
      const raw = within(row("Alice")).getByText("weird.unlabelled_action");
      expect(raw.getAttribute("data-variant")).toBe("body");
      expect(box.getByRole("link", { name: m.overview.audit.viewAll }).getAttribute("href")).toBe(
        "/admin/audit",
      );
    },
  );

  it("最近的平台操作：没有记录时是区块里的空状态", async () => {
    stubApi(
      overviewRoutes({ "GET /api/v1/admin/audit": () => json(200, { events: [], next: null }) }),
    );
    await renderRouteWithCache("/admin", lastStubRoutes(), { locale: "zh" });
    const empty = await screen.findByText(zh.admin.audit.empty);
    expect(section(zh.admin.overview.audit.title).contains(empty)).toBe(true);
  });

  it("the /dev/ui page the visual spec shoots draws the overview from its seeded cache, no box in a box", async () => {
    const calls = stubApi({});
    renderPage(<Catalog route="pages/admin-overview" />, { locale: "zh" });
    const o = zh.admin.overview;
    expect(await screen.findByText("v1.2.0 → v1.3.0")).toBeTruthy();
    expect(section(o.audit.title).getAttribute("data-state")).toBe("ready");
    expect(screen.getByText(o.footnote)).toBeTruthy();
    expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("非超级管理员：没有访问权限（需要超级管理员），不请求后台接口", async () => {
    const calls = stubApi({});
    await renderRouteWithCache("/admin", lastStubRoutes(), { locale: "zh", me: NOT_ADMIN });
    expect(template("StatusPage")?.getAttribute("data-kind")).toBe("no-access");
    expect(document.querySelector('[data-part="status-need"]')?.textContent).toBe(
      `需要：${zh.roles.need.superAdmin}`,
    );
    expect(screen.getByText(zh.roles.noAccess.askSuperAdmin)).toBeTruthy();
    expect(calls).toEqual([]);
  });
});

const ACCOUNTS = [
  {
    id: "a1",
    displayName: "Grant",
    email: null,
    status: "active",
    isSuperAdmin: true,
    createdAt: "2026-10-01T00:00:00Z",
  },
  {
    id: "a2",
    displayName: "Alice",
    email: "alice@example.com",
    status: "active",
    isSuperAdmin: false,
    createdAt: "2026-10-02T00:00:00Z",
  },
];

describe("/admin/accounts（ListPage）", () => {
  it.each(LOCALES)("授予超级管理员要先确认，确认后才 PATCH（%s）", async (locale) => {
    const a = msgs[locale].admin.accounts;
    const calls = stubApi({
      "GET /api/v1/admin/accounts": () => json(200, { accounts: ACCOUNTS, next: null }),
      "PATCH /api/v1/admin/accounts/a2": (c) =>
        json(200, { account: { ...ACCOUNTS[1], ...(bodyOf(c) as object) } }),
    });
    await renderRouteWithCache("/admin/accounts", lastStubRoutes(), { locale });
    expect(template("ListPage")).not.toBeNull();
    const table = await screen.findByRole("table", { name: a.title });
    const alice = within(table).getByText("Alice").closest("tr") as HTMLElement;
    const user = userEvent.setup();
    await user.click(within(alice).getByRole("button", { name: ROW_ACTIONS[locale] }));
    await user.click(await screen.findByRole("menuitem", { name: a.menu.grant }));
    const dialog = await screen.findByRole("dialog", {
      name: fill(a.confirm.grantTitle, { name: "Alice" }),
    });
    expect(calls.filter((c) => c.method === "PATCH")).toEqual([]);
    await user.click(within(dialog).getByRole("button", { name: a.confirm.grant }));
    await vi.waitFor(() =>
      expect(bodyOf(calls.find((c) => c.method === "PATCH"))).toEqual({ isSuperAdmin: true }),
    );
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // A role is plain text, not an accent badge.
    expect(within(alice).getByText(a.superAdmin).closest(".cb-badge")).toBeNull();
  });

  it("取消确认：不发请求", async () => {
    const calls = stubApi({
      "GET /api/v1/admin/accounts": () =>
        json(200, {
          accounts: [ACCOUNTS[0], { ...ACCOUNTS[1], isSuperAdmin: true }],
          next: null,
        }),
    });
    await renderRouteWithCache("/admin/accounts", lastStubRoutes());
    const a = en.admin.accounts;
    const table = await screen.findByRole("table", { name: a.title });
    const grant = within(table).getByText("Grant").closest("tr") as HTMLElement;
    const user = userEvent.setup();
    await user.click(within(grant).getByRole("button", { name: ROW_ACTIONS.en }));
    await user.click(await screen.findByRole("menuitem", { name: a.menu.revoke }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: en.common.cancel }));
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("the only active super admin of the full list: no 撤销, no 停用, so no row menu at all", async () => {
    stubApi({
      "GET /api/v1/admin/accounts": () =>
        json(200, {
          accounts: [
            ...ACCOUNTS,
            {
              ...ACCOUNTS[1],
              id: "a3",
              displayName: "Old",
              isSuperAdmin: true,
              status: "disabled",
            },
          ],
          next: null,
        }),
    });
    await renderRouteWithCache("/admin/accounts", lastStubRoutes(), { locale: "zh" });
    const a = zh.admin.accounts;
    const table = await screen.findByRole("table", { name: a.title });
    const grant = within(table).getByText("Grant").closest("tr") as HTMLElement;
    // a menu holding only an explanation is not a menu: the row has no ⋯
    expect(within(grant).queryByRole("button", { name: ROW_ACTIONS.zh })).toBeNull();
    const old = within(table).getByText("Old").closest("tr") as HTMLElement;
    expect(within(old).getByRole("button", { name: ROW_ACTIONS.zh })).toBeTruthy();
  });

  it("撤销最后一个超级管理员：显示 account.last_super_admin 的文案，对话框保持打开", async () => {
    // a partial list (more pages) cannot tell the last admin: the kernel's refusal shows
    stubApi({
      "GET /api/v1/admin/accounts": () => json(200, { accounts: ACCOUNTS, next: "c2" }),
      "PATCH /api/v1/admin/accounts/a1": () =>
        json(409, { error: { code: "account.last_super_admin", message: "x" } }),
    });
    await renderRouteWithCache("/admin/accounts", lastStubRoutes(), { locale: "zh" });
    const a = zh.admin.accounts;
    const table = await screen.findByRole("table", { name: a.title });
    const grant = within(table).getByText("Grant").closest("tr") as HTMLElement;
    const user = userEvent.setup();
    await user.click(within(grant).getByRole("button", { name: ROW_ACTIONS.zh }));
    await user.click(await screen.findByRole("menuitem", { name: a.menu.revoke }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: a.confirm.revoke }));
    expect(
      await within(dialog).findByText(zh.errors.account.last_super_admin, { exact: false }),
    ).toBeTruthy();
  });

  it("新建账号：POST /admin/accounts，新账号出现在列表里", async () => {
    const created = {
      id: "a3",
      displayName: "Bob",
      email: null,
      status: "active",
      isSuperAdmin: false,
      createdAt: "2026-10-03T00:00:00Z",
    };
    const calls = stubApi({
      "GET /api/v1/admin/accounts": () => json(200, { accounts: ACCOUNTS, next: null }),
      "POST /api/v1/admin/accounts": () => json(201, { account: created }),
    });
    await renderRouteWithCache("/admin/accounts", lastStubRoutes());
    const a = en.admin.accounts;
    await screen.findByRole("table", { name: a.title });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: a.new }));
    const dialog = await screen.findByRole("dialog", { name: a.form.title });
    await user.type(within(dialog).getByRole("textbox", { name: a.form.login }), "bob");
    await user.type(
      within(dialog).getByLabelText(a.form.password, { exact: false }),
      "correct horse battery",
    );
    await user.type(within(dialog).getByRole("textbox", { name: a.form.displayName }), "Bob");
    await user.click(within(dialog).getByRole("button", { name: a.form.submit }));
    await vi.waitFor(() =>
      expect(bodyOf(calls.find((c) => c.method === "POST"))).toEqual({
        login: "bob",
        password: "correct horse battery",
        displayName: "Bob",
        superAdmin: false,
      }),
    );
    expect(await screen.findByText("Bob")).toBeTruthy();
  });

  it("停用账号也要确认，确认后 PATCH status disabled", async () => {
    const calls = stubApi({
      "GET /api/v1/admin/accounts": () => json(200, { accounts: ACCOUNTS, next: null }),
      "PATCH /api/v1/admin/accounts/a2": (c) =>
        json(200, { account: { ...ACCOUNTS[1], ...(bodyOf(c) as object) } }),
    });
    await renderRouteWithCache("/admin/accounts", lastStubRoutes());
    const a = en.admin.accounts;
    const table = await screen.findByRole("table", { name: a.title });
    const alice = within(table).getByText("Alice").closest("tr") as HTMLElement;
    const user = userEvent.setup();
    await user.click(within(alice).getByRole("button", { name: ROW_ACTIONS.en }));
    await user.click(await screen.findByRole("menuitem", { name: a.menu.disable }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: a.confirm.disable }));
    await vi.waitFor(() =>
      expect(bodyOf(calls.find((c) => c.method === "PATCH"))).toEqual({ status: "disabled" }),
    );
  });
});

const ORGS = [
  { id: "o1", slug: "acme", name: "Acme", createdAt: "2026-10-01T00:00:00Z", memberCount: 4 },
  { id: "o2", slug: "beta", name: "Beta", createdAt: "2026-10-02T00:00:00Z", memberCount: 1 },
];

/** The deployment's defaults `GET /admin/orgs` carries. */
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

describe("/admin/orgs（ListPage）", () => {
  it("says in one paragraph that defaults apply and org settings need an org admin", async () => {
    stubApi({
      "GET /api/v1/admin/orgs": () => json(200, { orgs: ORGS, limitDefaults: LIMIT_DEFAULTS }),
      // 插件界面代码 lists the extensions with client code
      "GET /api/v1/admin/extensions": () => json(200, { extensions: [], drainSeconds: 30 }),
      "GET /api/v1/admin/settings": () => json(200, SETTINGS),
      "GET /api/v1/admin/ui/arrangement": () => json(200, { slots: [] }),
    });
    await renderRouteWithCache("/admin/orgs", lastStubRoutes(), { locale: "zh" });
    const hint = await screen.findByText(zh.admin.orgs.hint);
    expect(hint.textContent).toContain("需要成为组织管理员");
    expect(hint.getAttribute("data-variant")).toBe("prose");
    expect("memberHint" in zh.admin.orgs).toBe(false);
  });

  it.each(LOCALES)("显示覆盖值；设置运行并发与沙箱限额 → PUT settings（%s）", async (locale) => {
    const o = msgs[locale].admin.orgs;
    const calls = stubApi({
      "GET /api/v1/admin/orgs": () => json(200, { orgs: ORGS, limitDefaults: LIMIT_DEFAULTS }),
      // 插件界面代码 lists the extensions with client code
      "GET /api/v1/admin/extensions": () => json(200, { extensions: [], drainSeconds: 30 }),
      "GET /api/v1/admin/settings": () => json(200, SETTINGS),
      "GET /api/v1/admin/ui/arrangement": () => json(200, { slots: [] }),
      "PUT /api/v1/admin/settings": () =>
        json(200, {
          ...SETTINGS,
          runConcurrencyOverrides: { o1: 5, o2: 3 },
          sandboxLimitOverrides: { o1: { cpu: 1.5, memoryMb: 4096 }, o2: { cpu: 2 } },
        }),
    });
    await renderRouteWithCache("/admin/orgs", lastStubRoutes(), { locale });
    expect(template("ListPage")).not.toBeNull();
    const table = await screen.findByRole("table", { name: o.title });
    const beta = within(table).getByText("Beta").closest("tr") as HTMLElement;
    expect(within(beta).getByText("3")).toBeTruthy();
    expect(within(beta).getByText("2")).toBeTruthy();
    const acme = within(table).getByText("Acme").closest("tr") as HTMLElement;
    // an org without overrides shows the deployment defaults, grouped
    expect(
      ["10", "1", "2,048 MB", "5,000,000"].map(
        (v) => within(acme).getAllByText(fill(o.defaultValue, { value: v })).length,
      ),
    ).toEqual([1, 1, 1, 1]);

    const user = userEvent.setup();
    await user.click(within(acme).getByRole("button", { name: ROW_ACTIONS[locale] }));
    await user.click(await screen.findByRole("menuitem", { name: o.edit }));
    const dialog = await screen.findByRole("dialog", {
      name: fill(o.dialog.title, { name: "Acme" }),
    });
    // the limits as titled regions: 运行, 沙箱 (its note as the help line), 子智能体
    expect(
      within(dialog)
        .getAllByRole("heading", { level: 3 })
        .map((h) => h.textContent),
    ).toEqual([o.dialog.groups.run, o.dialog.groups.sandbox, o.dialog.groups.subagents]);
    const sandbox = within(dialog).getByRole("region", { name: o.dialog.groups.sandbox });
    expect(within(sandbox).getByText(o.dialog.newOnly)).toBeTruthy();
    expect(within(sandbox).getByRole("textbox", { name: o.dialog.cpu })).toBeTruthy();
    await user.type(within(dialog).getByRole("textbox", { name: o.dialog.runConcurrency }), "5");
    await user.type(within(dialog).getByRole("textbox", { name: o.dialog.cpu }), "1.5");
    await user.type(within(dialog).getByRole("textbox", { name: o.dialog.memory }), "4096");
    await user.click(within(dialog).getByRole("button", { name: o.dialog.save }));
    await vi.waitFor(() =>
      expect(bodyOf(calls.find((c) => c.method === "PUT"))).toEqual({
        runConcurrencyOverrides: { o1: 5 },
        sandboxLimitOverrides: { o1: { cpu: 1.5, memoryMb: 4096 } },
      }),
    );
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByText(o.saved)).toBeTruthy();
    expect(within(acme).getByText("5")).toBeTruthy();
  });

  it("清空覆盖 → 发 null；cpu 越界在界面拦下、不发请求", async () => {
    const calls = stubApi({
      "GET /api/v1/admin/orgs": () => json(200, { orgs: ORGS, limitDefaults: LIMIT_DEFAULTS }),
      // 插件界面代码 lists the extensions with client code
      "GET /api/v1/admin/extensions": () => json(200, { extensions: [], drainSeconds: 30 }),
      "GET /api/v1/admin/settings": () => json(200, SETTINGS),
      "GET /api/v1/admin/ui/arrangement": () => json(200, { slots: [] }),
      "PUT /api/v1/admin/settings": () =>
        json(200, { ...SETTINGS, runConcurrencyOverrides: {}, sandboxLimitOverrides: {} }),
    });
    await renderRouteWithCache("/admin/orgs", lastStubRoutes());
    const o = en.admin.orgs;
    const table = await screen.findByRole("table", { name: o.title });
    const beta = within(table).getByText("Beta").closest("tr") as HTMLElement;
    const user = userEvent.setup();
    await user.click(within(beta).getByRole("button", { name: ROW_ACTIONS.en }));
    await user.click(await screen.findByRole("menuitem", { name: o.edit }));
    const dialog = await screen.findByRole("dialog");
    const cpu = within(dialog).getByRole("textbox", { name: o.dialog.cpu }) as HTMLInputElement;
    expect(cpu.value).toBe("2");
    await user.clear(cpu);
    await user.type(cpu, "100");
    expect(within(dialog).getByText(`${o.dialog.cpuInvalid}`)).toBeTruthy();
    expect(
      (within(dialog).getByRole("button", { name: o.dialog.save }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await user.clear(cpu);
    await user.clear(within(dialog).getByRole("textbox", { name: o.dialog.runConcurrency }));
    await user.click(within(dialog).getByRole("button", { name: o.dialog.save }));
    await vi.waitFor(() =>
      expect(bodyOf(calls.find((c) => c.method === "PUT"))).toEqual({
        runConcurrencyOverrides: { o2: null },
        sandboxLimitOverrides: { o2: null },
      }),
    );
  });

  it.each(LOCALES)(
    "sub-agent limits: set per organization, sent only when changed (%s)",
    async (locale) => {
      const o = msgs[locale].admin.orgs;
      const calls = stubApi({
        "GET /api/v1/admin/orgs": () => json(200, { orgs: ORGS, limitDefaults: LIMIT_DEFAULTS }),
        // 插件界面代码 lists the extensions with client code
        "GET /api/v1/admin/extensions": () => json(200, { extensions: [], drainSeconds: 30 }),
        "GET /api/v1/admin/settings": () =>
          json(200, { ...SETTINGS, subagentLimitOverrides: { o2: { maxDispatchesPerRun: 9 } } }),
        "PUT /api/v1/admin/settings": () => json(200, SETTINGS),
      });
      await renderRouteWithCache("/admin/orgs", lastStubRoutes(), { locale });
      const table = await screen.findByRole("table", { name: o.title });
      const user = userEvent.setup();
      const beta = within(table).getByText("Beta").closest("tr") as HTMLElement;
      await user.click(within(beta).getByRole("button", { name: ROW_ACTIONS[locale] }));
      await user.click(await screen.findByRole("menuitem", { name: o.edit }));
      const dialog = await screen.findByRole("dialog");
      expect(
        (
          within(dialog).getByRole("textbox", {
            name: o.dialog.subagentDispatches,
          }) as HTMLInputElement
        ).value,
      ).toBe("9");
      await user.type(
        within(dialog).getByRole("textbox", { name: o.dialog.subagentConcurrent }),
        "2",
      );
      await user.type(
        within(dialog).getByRole("textbox", { name: o.dialog.subagentTokens }),
        "200000",
      );
      const depth = within(dialog).getByRole("textbox", { name: o.dialog.subagentDepth });
      await user.type(depth, "6");
      expect(within(dialog).getByText(o.dialog.subagentDepthInvalid)).toBeTruthy();
      await user.clear(depth);
      await user.type(depth, "2");
      await user.click(within(dialog).getByRole("button", { name: o.dialog.save }));
      await vi.waitFor(() =>
        expect(bodyOf(calls.find((c) => c.method === "PUT"))).toMatchObject({
          subagentLimitOverrides: {
            o2: {
              maxDepth: 2,
              maxConcurrentPerConversation: 2,
              maxDispatchesPerRun: 9,
              maxTokensPerRun: 200000,
            },
          },
        }),
      );
    },
  );

  it.each(LOCALES)(
    "placeholders show the deployment defaults; 不限制 saves 0 for dispatches and tokens (%s)",
    async (locale) => {
      const o = msgs[locale].admin.orgs;
      const calls = stubApi({
        "GET /api/v1/admin/orgs": () =>
          json(200, {
            orgs: ORGS,
            limitDefaults: {
              ...LIMIT_DEFAULTS,
              subagents: { ...LIMIT_DEFAULTS.subagents, maxDispatchesPerRun: 0 },
            },
          }),
        // 插件界面代码 lists the extensions with client code
        "GET /api/v1/admin/extensions": () => json(200, { extensions: [], drainSeconds: 30 }),
        "GET /api/v1/admin/settings": () =>
          json(200, { ...SETTINGS, subagentLimitOverrides: { o2: { maxTokensPerRun: 0 } } }),
        "PUT /api/v1/admin/settings": () =>
          json(200, {
            ...SETTINGS,
            subagentLimitOverrides: { o2: { maxDispatchesPerRun: 0 } },
          }),
      });
      await renderRouteWithCache("/admin/orgs", lastStubRoutes(), { locale });
      const table = await screen.findByRole("table", { name: o.title });
      const beta = within(table).getByText("Beta").closest("tr") as HTMLElement;
      // the org's token budget is unlimited
      expect(within(beta).getByText(o.unlimited)).toBeTruthy();
      const user = userEvent.setup();
      await user.click(within(beta).getByRole("button", { name: ROW_ACTIONS[locale] }));
      await user.click(await screen.findByRole("menuitem", { name: o.edit }));
      const dialog = await screen.findByRole("dialog");
      const box = (name: string) =>
        within(dialog).getByRole("textbox", { name }) as HTMLInputElement;
      expect(box(o.dialog.runConcurrency).placeholder).toBe(
        fill(o.dialog.placeholder, { value: "10" }),
      );
      expect(box(o.dialog.memory).placeholder).toBe(fill(o.dialog.placeholder, { value: "2,048" }));
      // a deployment default of 0 is no limit
      expect(box(o.dialog.subagentDispatches).placeholder).toBe(
        fill(o.dialog.placeholder, { value: o.unlimited }),
      );
      // the org's 0 checks 不限制 and disables its input
      const [dispatchesOff, tokensOff] = within(dialog).getAllByRole("checkbox", {
        name: o.dialog.unlimited,
      }) as HTMLInputElement[];
      expect(tokensOff?.checked).toBe(true);
      expect(box(o.dialog.subagentTokens).disabled).toBe(true);
      expect(dispatchesOff?.checked).toBe(false);
      // unchecking tokens (empty: the default) and checking dispatches saves 0 for dispatches only
      await user.click(tokensOff as HTMLInputElement);
      expect(box(o.dialog.subagentTokens).disabled).toBe(false);
      await user.click(dispatchesOff as HTMLInputElement);
      expect(box(o.dialog.subagentDispatches).disabled).toBe(true);
      await user.click(within(dialog).getByRole("button", { name: o.dialog.save }));
      await vi.waitFor(() =>
        expect(bodyOf(calls.find((c) => c.method === "PUT"))).toMatchObject({
          subagentLimitOverrides: { o2: { maxDispatchesPerRun: 0 } },
        }),
      );
    },
  );

  it("内核 400（validation_failed）：在对话框里显示，对话框不关", async () => {
    stubApi({
      "GET /api/v1/admin/orgs": () => json(200, { orgs: ORGS, limitDefaults: LIMIT_DEFAULTS }),
      // 插件界面代码 lists the extensions with client code
      "GET /api/v1/admin/extensions": () => json(200, { extensions: [], drainSeconds: 30 }),
      "GET /api/v1/admin/settings": () => json(200, SETTINGS),
      "GET /api/v1/admin/ui/arrangement": () => json(200, { slots: [] }),
      "PUT /api/v1/admin/settings": () =>
        json(400, { error: { code: "validation_failed", message: "x" } }),
    });
    await renderRouteWithCache("/admin/orgs", lastStubRoutes());
    const o = en.admin.orgs;
    const table = await screen.findByRole("table", { name: o.title });
    const acme = within(table).getByText("Acme").closest("tr") as HTMLElement;
    const user = userEvent.setup();
    await user.click(within(acme).getByRole("button", { name: ROW_ACTIONS.en }));
    await user.click(await screen.findByRole("menuitem", { name: o.edit }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByRole("textbox", { name: o.dialog.memory }), "1024");
    await user.click(within(dialog).getByRole("button", { name: o.dialog.save }));
    expect(await within(dialog).findByText(`${en.errors.validation_failed}`)).toBeTruthy();
  });
});

/** 外观 reads the themes and the current org's (none here). */
const THEME_ROUTES = {
  "GET /api/v1/admin/components?kind=theme": () => json(200, { components: [] }),
  "GET /api/v1/orgs/o1/themes": () =>
    json(200, { themes: [], resolved: null, org: { id: null, personal: "allowed" } }),
};

describe("/admin/settings（FormPage）", () => {
  it.each(LOCALES)(
    "部署设置：无二级导航；改自建连接器为「禁止」→ ActionRow → PUT 只含改动项（%s）",
    async (locale) => {
      const m = msgs[locale];
      const s = m.admin.settings;
      const calls = stubApi({
        // 插件界面代码 lists the extensions with client code
        "GET /api/v1/admin/extensions": () => json(200, { extensions: [], drainSeconds: 30 }),
        "GET /api/v1/admin/settings": () => json(200, SETTINGS),
        "GET /api/v1/admin/ui/arrangement": () => json(200, { slots: [] }),
        ...THEME_ROUTES,
        "PUT /api/v1/admin/settings": (c) => json(200, { ...SETTINGS, ...(bodyOf(c) as object) }),
      });
      resetNavigation("/admin/settings");
      const { container } = await renderRouteWithCache("/admin/settings", lastStubRoutes(), {
        locale,
      });
      expect(template("FormPage")).not.toBeNull();
      expect(container.querySelector(".cb-settings-nav")).toBeNull();
      const group = await screen.findByRole("radiogroup", { name: s.customConnectors.title });
      expect(within(group).getByRole("radio", { name: new RegExp(`^${s.allow}`) })).toHaveProperty(
        "checked",
        true,
      );
      const user = userEvent.setup();
      await user.click(within(group).getByRole("radio", { name: new RegExp(`^${s.deny}`) }));
      const row = screen.getByRole("region", {
        name: locale === "zh" ? "待提交改动" : "Pending changes",
      });
      await user.click(within(row).getByRole("button", { name: s.save }));
      await vi.waitFor(() =>
        expect(bodyOf(calls.find((c) => c.method === "PUT"))).toEqual({
          customConnectors: "deny",
        }),
      );
      expect(await screen.findByText(s.saved)).toBeTruthy();
    },
  );

  it("warns super admins with the operator details only on an insecure origin", async () => {
    stubApi({
      // 插件界面代码 lists the extensions with client code
      "GET /api/v1/admin/extensions": () => json(200, { extensions: [], drainSeconds: 30 }),
      "GET /api/v1/admin/settings": () => json(200, SETTINGS),
      "GET /api/v1/admin/ui/arrangement": () => json(200, { slots: [] }),
      ...THEME_ROUTES,
    });
    vi.stubGlobal("isSecureContext", false);
    await renderRouteWithCache("/admin/settings", lastStubRoutes());
    const note = await screen.findByText(/CAPYBARA_AUTH__COOKIE_SECURE=false/);
    expect(note.textContent).toContain("CAPYBARA_PUBLIC_URL");
    cleanup();
    vi.stubGlobal("isSecureContext", true);
    await renderRouteWithCache("/admin/settings", lastStubRoutes());
    await screen.findByRole("radiogroup", { name: en.admin.settings.customConnectors.title });
    expect(screen.queryByText(/CAPYBARA_AUTH__COOKIE_SECURE/)).toBeNull();
    vi.unstubAllGlobals();
  });

  it("币种不合法时不能保存", async () => {
    const calls = stubApi({
      // 插件界面代码 lists the extensions with client code
      "GET /api/v1/admin/extensions": () => json(200, { extensions: [], drainSeconds: 30 }),
      "GET /api/v1/admin/settings": () => json(200, SETTINGS),
      "GET /api/v1/admin/ui/arrangement": () => json(200, { slots: [] }),
      ...THEME_ROUTES,
    });
    await renderRouteWithCache("/admin/settings", lastStubRoutes());
    const s = en.admin.settings;
    const input = (await screen.findByRole("textbox", {
      name: s.currency.label,
    })) as HTMLInputElement;
    const user = userEvent.setup();
    await user.clear(input);
    await user.type(input, "us");
    expect(screen.getByText(`${s.currency.invalid}`)).toBeTruthy();
    const row = screen.getByRole("region", { name: "Pending changes" });
    expect((within(row).getByRole("button", { name: s.save }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(calls.filter((c) => c.method === "PUT")).toEqual([]);
  });
});

describe("org-owned plugins in the admin console (phase 3)", () => {
  const P = en.catalog.admin;
  const T = "2026-11-06T00:00:00.000Z";
  const ACME = { kind: "org", orgId: "o1", name: "Acme" };
  const ID = "55555555-5555-4555-8555-555555555555";
  const NEW_ID = "66666666-6666-4666-8666-666666666666";
  const item = (over: Record<string, unknown> = {}) => ({
    id: ID,
    name: "acme-crm",
    publisher: "Acme",
    displayName: null,
    description: "CRM tools",
    descriptionZh: null,
    policy: "allow",
    scope: "named",
    scopeOrgs: ["o1"],
    builtin: false,
    disabled: false,
    shownToOthers: false,
    owner: ACME,
    shareable: false,
    awaitingConfirmation: false,
    pendingVersion: null,
    enabledOrgs: 1,
    pending: false,
    permissionsHash: null,
    latestVersion: "1.0.0",
    platformVersion: "1.0.0",
    versions: ["1.0.0"],
    installs: 1,
    source: "file",
    marketplaceId: null,
    latestMarketplaceVersion: null,
    newerInMarketplace: false,
    contentChanged: false,
    componentCounts: { extension: 1, skills: 1, connectorTemplates: 0, agentTemplates: 0 },
    sourceFormat: "capybara",
    updatedAt: T,
    ...over,
  });
  const manifest = (version: string, tools: string[]) => ({
    name: "acme-crm",
    version,
    publisher: "Acme",
    description: "",
    extension: {
      entry: "dist/index.js",
      manifest: {
        name: "acme-crm",
        version,
        sdk: "^0.1.0",
        provides: [],
        requires: [],
        optional: [],
        permissions: { tools },
      },
    },
  });
  const version = (v: string, tools: string[]) => ({
    version: v,
    source: "file",
    sourceRef: null,
    integrity: null,
    contentDigest: null,
    sourceDetail: null,
    manifest: manifest(v, tools),
    size: 1024,
    extensionSha256: "a".repeat(64),
    importedAt: T,
  });
  const detail = (i: ReturnType<typeof item>, versions = [version("1.0.0", ["search"])]) => ({
    item: { ...i, packageName: "@acme/crm", deletedAt: null },
    versions,
    hasIcon: false,
  });
  // a new version waiting, and a first upload waiting
  const UPDATE = item({
    pending: true,
    permissionsHash: "pd1",
    pendingVersion: "1.1.0",
    versions: ["1.1.0", "1.0.0"],
  });
  const FIRST = item({
    id: NEW_ID,
    name: "acme-files",
    awaitingConfirmation: true,
    pending: true,
    permissionsHash: "pd2",
    pendingVersion: "0.1.0",
    latestVersion: "0.1.0",
    versions: ["0.1.0"],
    enabledOrgs: 0,
    owner: { kind: "org", orgId: "o2", name: "Beta" },
    scopeOrgs: ["o2"],
  });
  const ORGS = {
    orgs: [
      { id: "o1", slug: "acme", name: "Acme", memberCount: 3, createdAt: T },
      { id: "o2", slug: "beta", name: "Beta", memberCount: 4, createdAt: T },
    ],
  };
  const routes = (items: ReturnType<typeof item>[], pending: ReturnType<typeof item>[] = []) => ({
    "GET /api/v1/admin/catalog/items": () => json(200, { items, nextOffset: null }),
    "GET /api/v1/admin/catalog/items?pending=true": () =>
      json(200, { items: pending, nextOffset: null }),
    "GET /api/v1/admin/catalog/requests": () => json(200, { requests: [] }),
    "GET /api/v1/admin/marketplaces": () => json(200, { items: [], offline: false }),
    "GET /api/v1/admin/orgs": () => json(200, ORGS),
    "GET /api/v1/admin/components?kind=skill": () => json(200, { components: [] }),
    "GET /api/v1/admin/components?kind=connector_template": () => json(200, { components: [] }),
    "GET /api/v1/admin/components?kind=agent_template": () => json(200, { components: [] }),
  });

  it("the plugin list shows the owner org and when its org does not share it", async () => {
    stubApi(
      routes([item(), item({ id: NEW_ID, name: "acme-docs", shareable: true }), FIRST], [FIRST]),
    );
    await renderRouteWithCache("/admin/plugins", lastStubRoutes());
    const list = await screen.findByRole("list", { name: P.title });
    const row = (name: string) => within(list).getAllByText(name)[0]?.closest("li") as HTMLElement;
    expect(within(row("acme-crm")).getByText(fill(P.chips.owner, { org: "Acme" }))).toBeTruthy();
    expect(within(row("acme-crm")).getByText(P.chips.notShareable)).toBeTruthy();
    expect(within(row("acme-docs")).queryByText(P.chips.notShareable)).toBeNull();
    expect(within(row("acme-files")).getByText(fill(P.chips.owner, { org: "Beta" }))).toBeTruthy();
  });

  it("the scope cell of an `all` plugin says how many orgs turned it off", async () => {
    stubApi(
      routes([
        item({ id: NEW_ID, name: "everywhere", scope: "all", scopeOrgs: [], offCount: 2 }),
        item({ name: "quiet", scope: "all", scopeOrgs: [], offCount: 0 }),
      ]),
    );
    await renderRouteWithCache("/admin/plugins", lastStubRoutes());
    const list = await screen.findByRole("list", { name: P.title });
    const row = (name: string) => within(list).getAllByText(name)[0]?.closest("li") as HTMLElement;
    const has = (el: HTMLElement, text: string) =>
      within(el).queryByText((c) => c.includes(text)) !== null;
    expect(has(row("everywhere"), fill(en.catalog.admin.meta.allOff, { n: 2 }))).toBe(true);
    expect(has(row("quiet"), "turned off")).toBe(false);
    expect(has(row("quiet"), en.catalog.scope.all)).toBe(true);
  });

  it("detail of a plugin its org does not share: the owner, the reason, 设置范围 only narrows", async () => {
    const listed = item({ scopeOrgs: ["o1", "o2"] });
    stubApi({
      ...routes([listed]),
      [`GET /api/v1/admin/catalog/items/${ID}`]: () => json(200, detail(listed)),
    });
    await renderRouteWithCache(`/admin/plugins/${ID}`, lastStubRoutes());
    expect(await screen.findByRole("heading", { name: "acme-crm" })).toBeTruthy();
    expect(screen.getAllByText("Acme").length).toBeGreaterThan(0);
    expect(screen.getByText(P.detail.notShareableNote)).toBeTruthy();
    expect(screen.getByRole("button", { name: P.detail.actions.disable })).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: P.detail.actions.scope }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(P.scopeDialog.narrowOnly)).toBeTruthy();
    expect(within(dialog).queryByRole("radio")).toBeNull();
    expect(within(dialog).queryByRole("switch")).toBeNull();
    const owner = (await within(dialog).findByRole("checkbox", {
      name: "Acme",
    })) as HTMLInputElement;
    expect(owner.disabled).toBe(true);
    expect(
      (within(dialog).getByRole("checkbox", { name: "Beta" }) as HTMLInputElement).disabled,
    ).toBe(false);
  });

  it("detail: what needs attention is one notice above the tabs, the facts one block above the tab", async () => {
    const listed = item({
      disabled: true,
      contentChanged: true,
      pendingVersion: "1.1.0",
      versions: ["1.1.0", "1.0.0"],
    });
    stubApi({
      ...routes([listed]),
      [`GET /api/v1/admin/catalog/items/${ID}`]: () => json(200, detail(listed)),
    });
    await renderRouteWithCache(`/admin/plugins/${ID}`, lastStubRoutes());
    expect(await screen.findByRole("heading", { name: "acme-crm" })).toBeTruthy();
    // one Callout in the head (above the tabs) listing every note, each said once
    const callouts = document.querySelectorAll('[data-part="callout"]');
    expect(callouts).toHaveLength(1);
    const notice = callouts[0] as HTMLElement;
    expect(notice.closest('[data-part="page-tabs"]')).toBeNull();
    expect(notice.closest(".cb-pageheader-notice")).not.toBeNull();
    for (const note of [
      P.detail.notShareableNote,
      fill(P.detail.pendingVersionNote, { version: "v1.1.0" }),
      P.detail.disabledNote,
      P.detail.contentChanged,
    ]) {
      expect(within(notice).getAllByText(note)).toHaveLength(1);
      expect(screen.getAllByText(note)).toHaveLength(1);
    }
    // the owner is a fact (no separate owner sentence); the facts sit in the facts block
    const facts = document.querySelector('[data-part="detail-facts"]') as HTMLElement;
    expect(within(facts).getByText(fill(P.detail.ownerValue, { org: "Acme" }))).toBeTruthy();
    // the facts do not repeat per tab: switching tabs keeps the one block
    await userEvent.setup().click(screen.getByRole("tab", { name: P.detail.tabs.orgs }));
    expect(document.querySelectorAll('[data-part="detail-facts"]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-part="callout"]')).toHaveLength(1);
  });

  it("detail of a shared org plugin: the full scope dialog, the owner kept; no 更新到 a pending version", async () => {
    const shared = item({
      shareable: true,
      pending: true,
      pendingVersion: "1.1.0",
      versions: ["1.1.0", "1.0.0"],
    });
    stubApi({
      ...routes([shared]),
      [`GET /api/v1/admin/catalog/items/${ID}`]: () => json(200, detail(shared)),
    });
    await renderRouteWithCache(`/admin/plugins/${ID}`, lastStubRoutes());
    expect(await screen.findByRole("heading", { name: "acme-crm" })).toBeTruthy();
    expect(screen.queryByText(P.detail.notShareableNote)).toBeNull();
    // the owner uploads versions; the waiting one is confirmed in 待确认
    expect(
      screen.queryByRole("button", { name: fill(P.detail.actions.update, { version: "v1.1.0" }) }),
    ).toBeNull();
    await userEvent.setup().click(screen.getByRole("button", { name: P.detail.actions.scope }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getAllByRole("radio").length).toBe(3);
    const owner = (await within(dialog).findByRole("checkbox", {
      name: "Acme",
    })) as HTMLInputElement;
    expect(owner.disabled).toBe(true);
  });

  it("待确认: an org upload shows the owner org, new plugin or from → to, the extension notice; 确认 sends the digest", async () => {
    const calls = stubApi({
      ...routes([UPDATE, FIRST], [UPDATE, FIRST]),
      [`GET /api/v1/admin/catalog/items/${ID}`]: () =>
        json(200, detail(UPDATE, [version("1.1.0", ["crm.write"]), version("1.0.0", ["search"])])),
      [`POST /api/v1/admin/catalog/items/${ID}/confirm`]: () =>
        json(200, { ...UPDATE, pending: false, pendingVersion: null }),
    });
    await renderRouteWithCache("/admin/plugins/pending", lastStubRoutes());
    const list = await screen.findByRole("list", { name: P.pending.listLabel });
    const row = (name: string) => within(list).getAllByText(name)[0]?.closest("li") as HTMLElement;
    const upd = row("acme-crm");
    expect(within(upd).getByText(fill(P.pending.upload.by, { org: "Acme" }))).toBeTruthy();
    // the meta line joins its parts
    const meta = (row: HTMLElement, text: string) =>
      within(row).getByText(
        (_, el) => el?.children.length === 0 && (el.textContent ?? "").includes(text),
      );
    expect(meta(upd, fill(P.pending.upload.update, { from: "v1.0.0", to: "v1.1.0" }))).toBeTruthy();
    expect(within(upd).getByText(P.pending.upload.extension)).toBeTruthy();
    const first = row("acme-files");
    expect(within(first).getByText(fill(P.pending.upload.by, { org: "Beta" }))).toBeTruthy();
    expect(meta(first, P.pending.upload.newPlugin)).toBeTruthy();
    const user = userEvent.setup();
    await user.click(within(upd).getByRole("button", { name: P.pending.upload.confirm }));
    const dialog = await screen.findByRole("dialog");
    // the permission review of the waiting version, not the running one
    expect(await within(dialog).findByText(/crm\.write/)).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: P.pending.confirm }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/confirm"))).toBe(true));
    expect(bodyOf(calls.find((c) => c.url.endsWith("/confirm")))).toEqual({
      permissionsHash: "pd1",
    });
  });

  it("待确认: an org item whose pending version carries no extension to confirm is not an upload row", async () => {
    // a stale pending version with nothing waiting (not pending, not awaiting): no 确认 of a digest
    const STALE = item({ pending: false, pendingVersion: "1.1.0", versions: ["1.1.0", "1.0.0"] });
    stubApi(routes([STALE, FIRST], [STALE, FIRST]));
    await renderRouteWithCache("/admin/plugins/pending", lastStubRoutes());
    const list = await screen.findByRole("list", { name: P.pending.listLabel });
    const row = (name: string) =>
      within(list).queryAllByText(name)[0]?.closest("li") as HTMLElement | undefined;
    const first = row("acme-files") as HTMLElement;
    expect(within(first).getByText(P.pending.upload.extension)).toBeTruthy();
    const stale = row("acme-crm");
    if (stale !== undefined) {
      expect(within(stale).queryByText(P.pending.upload.extension)).toBeNull();
      expect(within(stale).queryByText(fill(P.pending.upload.by, { org: "Acme" }))).toBeNull();
    }
  });

  it("待确认: 拒绝 an org upload posts the reason", async () => {
    const calls = stubApi({
      ...routes([FIRST], [FIRST]),
      [`POST /api/v1/admin/catalog/items/${NEW_ID}/reject`]: () =>
        new Response(null, { status: 204 }),
    });
    await renderRouteWithCache("/admin/plugins/pending", lastStubRoutes());
    const list = await screen.findByRole("list", { name: P.pending.listLabel });
    const first = within(list).getAllByText("acme-files")[0]?.closest("li") as HTMLElement;
    const user = userEvent.setup();
    await user.click(within(first).getByRole("button", { name: P.pending.reject }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(
        fill(P.pending.upload.rejectTitle, { org: "Beta", name: "acme-files" }),
      ),
    ).toBeTruthy();
    await user.type(within(dialog).getByRole("textbox"), "Too broad");
    await user.click(within(dialog).getByRole("button", { name: P.pending.reject }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/reject"))).toBe(true));
    expect(bodyOf(calls.find((c) => c.url.endsWith("/reject")))).toEqual({ reason: "Too broad" });
    expect(
      await screen.findByText(fill(P.pending.upload.rejected, { name: "acme-files" })),
    ).toBeTruthy();
  });

  it("the platform inbox: an org upload waiting and an ownership transfer, which 知道了 dismisses", async () => {
    const I = en.admin.inbox;
    const calls = stubApi({
      "GET /api/v1/admin/inbox": () =>
        json(200, {
          items: [
            {
              type: "org_upload_pending",
              id: NEW_ID,
              createdAt: T,
              item: { ...FIRST, displayName: { zh: "文件助手", en: "Acme files" } },
            },
            {
              type: "ownership_transferred",
              id: "n1",
              createdAt: T,
              notice: {
                id: "n1",
                kind: "ownership_transferred",
                createdAt: T,
                detail: {
                  ref: { kind: "skill", id: "p7" },
                  name: "brand-voice",
                  fromOrg: { id: "o1", name: "Acme" },
                  reason: "org_deleted",
                  usedBy: 2,
                },
              },
            },
          ],
          truncated: false,
          total: 2,
        }),
      "GET /api/v1/admin/inbox/count": () => json(200, { total: 2 }),
      "POST /api/v1/admin/inbox/notices/n1/dismiss": () => new Response(null, { status: 204 }),
    });
    await renderRouteWithCache("/admin/inbox", lastStubRoutes());
    // the selected item's card says who uploaded what
    expect(
      (await screen.findAllByText(fill(I.orgUpload.title, { org: "Beta", name: "Acme files" })))
        .length,
    ).toBeGreaterThan(0);
    // a row leads with the plugin's display name, its version beside it, whole; the kind and the
    // org second; the column header is neutral
    const table = screen.getByRole("table", { name: I.listLabel });
    expect(within(table).getByRole("columnheader", { name: I.columns.item })).toBeTruthy();
    const name = within(table).getByText("Acme files", { selector: ".cb-cell-title-name" });
    expect(name.getAttribute("title")).toBe("Acme files");
    const upload = name.closest("tr") as HTMLElement;
    expect(within(upload).getByText("v0.1.0").getAttribute("data-part")).toBe(
      "cell-title-trailing",
    );
    expect(within(upload).getByText(`${I.orgUpload.label} · Beta`)).toBeTruthy();
    const transferred = fill(I.transferred.title, {
      name: "brand-voice",
      why: fill(I.transferred.reason.org_deleted, { org: "Acme" }),
    });
    const user = userEvent.setup();
    await user.click(within(table).getByText("brand-voice", { selector: ".cb-cell-title-name" }));
    expect(await screen.findByText(transferred)).toBeTruthy();
    expect(await screen.findByText("2 organizations still use it.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: I.transferred.dismiss }));
    await waitFor(() =>
      expect(calls.some((c) => c.url.endsWith("/notices/n1/dismiss"))).toBe(true),
    );
  });

  it("zh copy of the owner, the share gate and the inbox", () => {
    expect(zh.catalog.admin.chips.owner).toBe("归属：{org}");
    expect(zh.adminComponents.share.notShareable).toBe("该组织未开放共享");
    expect(zh.catalog.admin.pending.upload.by).toBe("{org} 上传");
    expect(zh.catalog.admin.pending.upload.update).toBe("更新 {from} → {to}");
    expect(zh.admin.inbox.orgUpload.title).toBe("{org} 上传了 {name}，等待确认");
    expect(zh.admin.inbox.transferred.dismiss).toBe("知道了");
  });
});

describe("/admin/inbox?type=（按类型过滤）", () => {
  const SYNC = (id: string, org: string) => ({
    type: "scope_sync_failed",
    id,
    createdAt: "2026-11-10T08:00:00.000Z",
    failure: {
      item: { id: "item-1", name: "crm", displayName: null },
      org: { id: `o-${org}`, name: org },
      op: "install",
      code: "plugin.skill_conflict",
      message: "A skill named pdf already exists",
      failedAt: "2026-11-10T08:00:00.000Z",
    },
  });
  const MIGRATION = {
    type: "platform_migration",
    id: "run1",
    createdAt: "2026-11-10T09:00:00.000Z",
    run: {
      id: "run1",
      startedAt: "2026-11-10T09:00:00.000Z",
      finishedAt: null,
      stuck: true,
      itemsFailed: [],
    },
  };
  const routes = () => ({
    "GET /api/v1/admin/inbox": () =>
      json(200, {
        items: [MIGRATION, SYNC("s1", "Beta"), SYNC("s2", "Gamma")],
        truncated: false,
        total: 3,
        byType: {
          catalog_request: 0,
          permission_confirmation: 0,
          scope_sync_failed: 2,
          platform_migration: 1,
          ownership_transferred: 0,
          org_upload_pending: 0,
        },
      }),
    "GET /api/v1/admin/inbox/count": () => json(200, { total: 3 }),
  });

  it.each(LOCALES)("只列出该类型的事项，并能清除过滤（%s）", async (locale) => {
    const I = msgs[locale].admin.inbox;
    const types = msgs[locale].admin.overview.attention.inboxTypes;
    stubApi(routes());
    await renderRouteWithCache("/admin/inbox?type=scope_sync_failed", lastStubRoutes(), {
      locale,
    });
    const table = await screen.findByRole("table", { name: I.listLabel });
    expect(within(table).getAllByRole("row").slice(1)).toHaveLength(2);
    expect(within(table).queryByText(I.migration.label)).toBeNull();
    expect(screen.getByText(fill(I.filtered, { type: types.scope_sync_failed }))).toBeTruthy();
    expect(screen.getByRole("link", { name: I.clearFilter }).getAttribute("href")).toBe(
      "/admin/inbox",
    );
  });

  it("未知类型被忽略：列出全部，没有过滤提示", async () => {
    const I = zh.admin.inbox;
    stubApi(routes());
    await renderRouteWithCache("/admin/inbox?type=nope", lastStubRoutes(), { locale: "zh" });
    const table = await screen.findByRole("table", { name: I.listLabel });
    expect(within(table).getAllByRole("row").slice(1)).toHaveLength(3);
    expect(screen.queryByRole("link", { name: I.clearFilter })).toBeNull();
  });
});
