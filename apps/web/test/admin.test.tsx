import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { activeNavOf } from "../src/components/shell/nav";
import type { Me } from "../src/lib/session";
import { bodyOf, json, lastStubRoutes, stubApi } from "./support/api";
import { resetNavigation } from "./support/navigation";
import { renderRouteWithCache } from "./support/query";
import { ME } from "./support/render";

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

describe("/admin 概览（OverviewPage）", () => {
  it.each(LOCALES)("超级管理员：四个数字与各页入口（%s）", async (locale) => {
    const a = msgs[locale].admin;
    stubApi({
      "GET /api/v1/admin/overview": () =>
        json(200, { extensionsNeedingAction: 3, catalogRequestsPending: 0, orgs: 2, accounts: 7 }),
    });
    const { container } = await renderRouteWithCache("/admin", lastStubRoutes(), { locale });
    expect(template("OverviewPage")).not.toBeNull();
    const metrics = await vi.waitFor(() => {
      const m = container.querySelector('[data-part="stat-cards"]');
      if (!m) throw new Error("no metrics yet");
      return m as HTMLElement;
    });
    const metric = (label: string) =>
      within(within(metrics).getByText(label).parentElement as HTMLElement);
    await vi.waitFor(() =>
      expect(metric(a.overview.metrics.extensions).getByText("3")).toBeTruthy(),
    );
    expect(metric(a.overview.metrics.catalogRequests).getByText("0")).toBeTruthy();
    expect(metric(a.overview.metrics.orgs).getByText("2")).toBeTruthy();
    expect(metric(a.overview.metrics.accounts).getByText("7")).toBeTruthy();
    // each number links to its page (the stat card is the link); no section cards duplicate the
    // sidebar
    const statLink = (label: string) =>
      within(metrics).getByText(label).closest("a")?.getAttribute("href");
    expect(statLink(a.overview.metrics.extensions)).toBe("/admin/extensions");
    expect(statLink(a.overview.metrics.catalogRequests)).toBe("/admin/plugins/pending");
    expect(statLink(a.overview.metrics.orgs)).toBe("/admin/orgs");
    expect(statLink(a.overview.metrics.accounts)).toBe("/admin/accounts");
    expect(container.querySelectorAll('[data-part="link-card"]')).toHaveLength(0);
    // one sentence under the title; the privacy fact is its own quiet note
    const description = container.querySelector('[data-part="page-header-description"]');
    expect(description?.textContent).toBe(a.overview.intro);
    expect(screen.getByRole("note").textContent).toBe(a.overview.noConversations);
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

describe("/admin/orgs（ListPage）", () => {
  it("says in one paragraph that defaults apply and org settings need an org admin", async () => {
    stubApi({
      "GET /api/v1/admin/orgs": () => json(200, { orgs: ORGS }),
      "GET /api/v1/admin/settings": () => json(200, SETTINGS),
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
      "GET /api/v1/admin/orgs": () => json(200, { orgs: ORGS }),
      "GET /api/v1/admin/settings": () => json(200, SETTINGS),
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
    expect(within(acme).getAllByText(o.default).length).toBe(3);

    const user = userEvent.setup();
    await user.click(within(acme).getByRole("button", { name: ROW_ACTIONS[locale] }));
    await user.click(await screen.findByRole("menuitem", { name: o.edit }));
    const dialog = await screen.findByRole("dialog", {
      name: fill(o.dialog.title, { name: "Acme" }),
    });
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
      "GET /api/v1/admin/orgs": () => json(200, { orgs: ORGS }),
      "GET /api/v1/admin/settings": () => json(200, SETTINGS),
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
        "GET /api/v1/admin/orgs": () => json(200, { orgs: ORGS }),
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
      await user.click(within(dialog).getByRole("button", { name: o.dialog.save }));
      await vi.waitFor(() =>
        expect(bodyOf(calls.find((c) => c.method === "PUT"))).toMatchObject({
          subagentLimitOverrides: {
            o2: { maxConcurrentPerRun: 2, maxDispatchesPerRun: 9, maxTokensPerRun: 200000 },
          },
        }),
      );
    },
  );

  it("内核 400（validation_failed）：在对话框里显示，对话框不关", async () => {
    stubApi({
      "GET /api/v1/admin/orgs": () => json(200, { orgs: ORGS }),
      "GET /api/v1/admin/settings": () => json(200, SETTINGS),
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

describe("/admin/settings（FormPage）", () => {
  it.each(LOCALES)(
    "部署设置：无二级导航；改自建连接器为「禁止」→ ActionRow → PUT 只含改动项（%s）",
    async (locale) => {
      const m = msgs[locale];
      const s = m.admin.settings;
      const calls = stubApi({
        "GET /api/v1/admin/settings": () => json(200, SETTINGS),
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

  it("币种不合法时不能保存", async () => {
    const calls = stubApi({ "GET /api/v1/admin/settings": () => json(200, SETTINGS) });
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
