import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import AdminDirectoryItemPage from "../src/app/[locale]/(app)/admin/directory/[itemId]/page";
import AppReviewPage from "../src/app/[locale]/(app)/admin/directory/apps/review/page";
import CatalogPage from "../src/app/[locale]/(app)/admin/directory/catalog/page";
import AdminDirectoryPage from "../src/app/[locale]/(app)/admin/directory/page";
import RequestsPage from "../src/app/[locale]/(app)/admin/directory/requests/page";
import SourcesPage from "../src/app/[locale]/(app)/admin/directory/sources/page";
import InstallPage from "../src/app/[locale]/(app)/directory/[itemId]/install/page";
import DirectoryPage from "../src/app/[locale]/(app)/directory/page";
import InboxRoute from "../src/app/[locale]/(app)/inbox/page";
import AppsPage from "../src/app/[locale]/(app)/settings/apps/page";
import PluginsPage from "../src/app/[locale]/(app)/settings/plugins/page";
import { defaultSlug, slugOf } from "../src/components/DirectoryInstallWizard";
import type { Me } from "../src/lib/session";
import { bodyOf, json, stubApi } from "./support/api";
import { resetNavigation, router } from "./support/navigation";
import { ME, renderPage } from "./support/render";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
const params = { current: {} as Record<string, string> };
vi.mock("next/navigation", () => ({ useParams: () => params.current }));

const msgs = { zh, en } as const;
const LOCALES = ["zh", "en"] as const;
const fill = (s: string, vars: Record<string, string | number>) =>
  s.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k]));
const template = (name: string) => document.querySelector(`[data-template="${name}"]`);

const ORG = "/api/v1/orgs/o1";
const ID = "11111111-1111-4111-8111-111111111111";
const MEMBER: Me = {
  ...ME,
  memberships: [{ ...ME.memberships[0], role: "member" } as Me["memberships"][number]],
};

beforeEach(() => {
  resetNavigation("/");
  params.current = {};
  window.history.replaceState(null, "", "/");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function orgItem(over: Record<string, unknown> = {}) {
  return {
    id: ID,
    kind: "skill",
    name: "pdf-tools",
    publisher: "Acme",
    displayName: null,
    description: "PDF helpers",
    policy: "allow",
    latestVersion: "1.0.0",
    versions: ["1.0.0"],
    source: "file",
    updatedAt: "2026-10-22T00:00:00.000Z",
    installable: "yes",
    installed: null,
    request: null,
    ...over,
  };
}

describe("/directory：按 installable 显示操作", () => {
  it.each(LOCALES)(
    "组织管理员：可装 / 需审批 / 已获批 / 禁用 / 未部署 / 已装 / 已申请（%s）",
    async (locale) => {
      const a = msgs[locale].directory.org.action;
      const items = [
        orgItem({ id: "a", name: "yes-skill" }),
        orgItem({ id: "b", name: "approval", installable: "needs_approval" }),
        orgItem({
          id: "c",
          name: "granted-tpl",
          kind: "connector-template",
          installable: "granted",
        }),
        orgItem({ id: "d", name: "off", installable: "disabled" }),
        orgItem({ id: "e", name: "missing", kind: "app", installable: "not_deployed" }),
        orgItem({ id: "f", name: "done", installed: { skillId: "s1", version: "1.0.0" } }),
        orgItem({
          id: "g",
          name: "asked",
          installable: "needs_approval",
          request: { id: "r1", stage: "deployment", status: "pending" },
        }),
      ];
      const calls = stubApi({
        [`GET ${ORG}/directory`]: () => json(200, { items }),
        [`POST ${ORG}/directory/a/install`]: () =>
          json(201, { installed: { kind: "skill", itemId: "a", version: "1.0.0" } }),
      });
      renderPage(<DirectoryPage />, { locale });
      expect(template("ListPage")).not.toBeNull();
      const table = await screen.findByRole("table");
      const row = (name: string) => within(table).getByText(name).closest("tr") as HTMLElement;
      expect(within(row("yes-skill")).getByRole("button", { name: a.install })).toBeTruthy();
      expect(within(row("approval")).getByRole("button", { name: a.requestApproval })).toBeTruthy();
      expect(within(row("granted-tpl")).getByRole("button", { name: a.install })).toBeTruthy();
      expect(within(row("off")).queryByRole("button")).toBeNull();
      expect(within(row("off")).getByText(a.disabledHint)).toBeTruthy();
      expect(within(row("missing")).queryByRole("button")).toBeNull();
      expect(within(row("missing")).getByText(a.notDeployedHint)).toBeTruthy();
      expect(within(row("done")).queryByRole("button")).toBeNull();
      expect(within(row("asked")).queryByRole("button")).toBeNull();
      expect(
        within(row("asked")).getByText(fill(a.pendingHint, { stage: a.stage.deployment })),
      ).toBeTruthy();

      const user = userEvent.setup();
      // 连接器模板进安装向导
      await user.click(within(row("granted-tpl")).getByRole("button", { name: a.install }));
      expect(router.push).toHaveBeenCalledWith("/directory/c/install");
      // 技能直接安装
      await user.click(within(row("yes-skill")).getByRole("button", { name: a.install }));
      await waitFor(() =>
        expect(calls.some((c) => c.url === `${ORG}/directory/a/install`)).toBe(true),
      );
    },
  );

  it("成员：可装的条目只能申请（进组织管理员收件箱）", async () => {
    const a = en.directory.org.action;
    const calls = stubApi({
      [`GET ${ORG}/directory`]: () => json(200, { items: [orgItem()] }),
      [`POST ${ORG}/directory/${ID}/requests`]: () =>
        json(201, { request: { id: "r" }, created: true }),
    });
    renderPage(<DirectoryPage />, { me: MEMBER });
    const btn = await screen.findByRole("button", { name: a.request });
    expect(screen.queryByRole("button", { name: a.install })).toBeNull();
    await userEvent.setup().click(btn);
    await waitFor(() =>
      expect(calls.find((c) => c.url.endsWith("/requests"))?.method).toBe("POST"),
    );
  });
});

const plugin = (over: Record<string, unknown> = {}) => ({
  name: "crm-core",
  npm: "@acme/plugin-crm-core",
  range: "^1.0.0",
  lockVersion: "1.0.0",
  sha256: "a".repeat(64),
  action: "install",
  currentVersion: null,
  currentSha256: null,
  optional: false,
  permissions: [
    {
      category: "provides",
      sensitive: true,
      items: ["sandbox@1"],
      entries: [{ value: "sandbox@1", sensitive: true, reason: "sandbox" }],
    },
  ],
  added: [],
  addedItems: [],
  removed: [],
  warnings: [],
  reviewHash: "p1",
  sensitive: true,
  ...over,
});

const REVIEW = {
  name: "crm",
  version: "1.0.0",
  publisher: "Acme",
  description: "CRM bundle",
  plugins: [
    plugin(),
    plugin({
      name: "todo",
      action: "keep",
      currentVersion: "0.1.0",
      sensitive: false,
      permissions: [],
    }),
  ],
  connectorTemplates: [
    {
      id: "gh",
      plugin: "connector-mcp",
      connector: "mcp",
      endpoint: { url: "https://mcp.example.com" },
      auth: { type: "bearer", ownership: "org" },
      editableEndpoint: ["url"],
      endpointChecked: true,
    },
  ],
  skills: [{ name: "pdf-tools", description: "PDF helpers", path: "skills/pdf-tools", files: 2 }],
  sensitive: true,
  reviewHash: "h1",
};

describe("/admin/directory/apps/review（WizardPage）", () => {
  it.each(LOCALES)(
    "一次审阅：动作、敏感项、模板与技能；勾选「我已了解敏感项」前确认不可用；不装到部署时说明后果（%s）",
    async (locale) => {
      const r = msgs[locale].directory.admin.review;
      const w = msgs[locale].admin.plugins.wizard;
      const calls = stubApi({
        "POST /api/v1/admin/directory/apps/prepare/npm": () =>
          json(200, { stagingId: "st1", review: REVIEW }),
        "POST /api/v1/admin/directory/apps/st1/confirm": () =>
          json(201, { item: { id: ID, name: "crm" }, deploy: null }),
      });
      renderPage(<AppReviewPage />, { locale });
      expect(template("WizardPage")).not.toBeNull();
      const user = userEvent.setup();
      await user.click(screen.getByRole("radio", { name: r.sourceNpm }));
      await user.type(screen.getByRole("textbox", { name: w.npmPackage }), "@acme/app-crm");
      await user.click(screen.getByRole("button", { name: r.fetch }));
      expect(await screen.findByText(fill(r.action.install, { version: "1.0.0" }))).toBeTruthy();
      expect(screen.getByText(fill(r.action.keep, { version: "0.1.0" }))).toBeTruthy();
      expect(screen.getByText(fill(r.editable, { paths: "url" }))).toBeTruthy();
      expect(screen.getByText(/pdf-tools/)).toBeTruthy();
      expect(screen.getAllByText(msgs[locale].plugins.sensitive).length).toBeGreaterThan(0);
      await user.click(screen.getByRole("button", { name: w.next }));

      const confirm = screen.getByRole("button", { name: r.confirm }) as HTMLButtonElement;
      expect(confirm.disabled).toBe(true);
      // 默认不装到部署：说明插件只记为目录条目
      expect(screen.getByText(r.deployOff)).toBeTruthy();
      await user.click(screen.getByRole("checkbox", { name: r.deployPlugins }));
      expect(screen.getByText(r.deployOn)).toBeTruthy();
      expect(confirm.disabled).toBe(true);
      await user.click(screen.getByRole("checkbox", { name: r.ack }));
      expect(confirm.disabled).toBe(false);
      await user.click(confirm);
      await waitFor(() => expect(router.push).toHaveBeenCalledWith(`/admin/directory/${ID}`));
      expect(bodyOf(calls.find((c) => c.url.endsWith("/confirm")))).toEqual({
        reviewHash: "h1",
        deployPlugins: true,
      });
    },
  );

  it("从清单引入应用：进页面就按清单暂存；lock 不符用醒目的错误", async () => {
    window.history.replaceState(
      null,
      "",
      "/admin/directory/apps/review?catalog=official&name=crm&version=1.0.0",
    );
    stubApi({
      "POST /api/v1/admin/catalogs/official/entries/app/crm/import": () =>
        json(502, { error: { code: "app.lock_mismatch", message: "x" } }),
    });
    renderPage(<AppReviewPage />);
    expect(await screen.findByText(`✗ ${en.errors.app.lock_mismatch}`)).toBeTruthy();
  });
});

describe("/directory/[itemId]/install（WizardPage）", () => {
  it("不可编辑的端点只读，可编辑的可改；提交只带改过的可编辑字段与凭据；失败时说明已回滚", async () => {
    params.current = { itemId: ID };
    const t = en.directory.org.install;
    const detail = {
      item: orgItem({ kind: "app", name: "crm" }),
      hasIcon: false,
      templates: [
        {
          id: "gh",
          displayName: { zh: "GitHub", en: "GitHub" },
          description: "",
          plugin: "connector-mcp",
          connector: "mcp",
          endpoint: { url: "https://mcp.example.com", headers: { "X-Org": "acme" } },
          editableEndpoint: ["url"],
          auth: { type: "bearer", ownership: "org" },
          ownership: "org",
        },
      ],
      plugins: [{ name: "todo", range: "^0.1.0", optional: false }],
      skills: ["skills/pdf-tools"],
    };
    const calls = stubApi({
      [`GET ${ORG}/directory/${ID}`]: () => json(200, detail),
      [`GET ${ORG}/plugins`]: () => json(200, { plugins: [] }),
      [`POST ${ORG}/directory/${ID}/install`]: () =>
        json(502, {
          error: {
            code: "app.install_failed",
            message: "x",
            details: [{ step: "skills", code: "internal", rolledBack: true }],
          },
        }),
    });
    renderPage(<InstallPage />);
    expect(template("WizardPage")).not.toBeNull();
    const fixed = (await screen.findByLabelText("headers.X-Org")) as HTMLInputElement;
    expect(fixed.readOnly).toBe(true);
    expect(fixed.value).toBe("acme");
    const url = screen.getByLabelText("url") as HTMLInputElement;
    expect(url.readOnly).toBe(false);
    const user = userEvent.setup();
    await user.clear(url);
    await user.type(url, "https://mcp.acme.internal");
    await user.type(screen.getByLabelText(en.connectors.form.tokenLabel), "tok");
    await user.click(screen.getByRole("button", { name: t.next }));
    await user.click(screen.getByRole("button", { name: t.next }));
    await user.click(screen.getByRole("button", { name: t.submit }));
    expect(
      await screen.findByText(`✗ ${fill(t.failed, { step: t.step.skills, code: "internal" })}`),
    ).toBeTruthy();
    expect(bodyOf(calls.find((c) => c.method === "POST"))).toEqual({
      version: "1.0.0",
      app: {
        connectors: {
          gh: {
            name: "GitHub",
            slug: "gh",
            endpoint: { url: "https://mcp.acme.internal" },
            credential: { token: "tok" },
          },
        },
      },
    });
  });
});

const INSTALL = {
  id: "i1",
  itemId: ID,
  name: "crm",
  version: "1.0.0",
  status: "installed",
  installedBy: "a1",
  installedAt: "2026-10-22T00:00:00.000Z",
  error: null,
  components: [
    { kind: "plugin", ref: "todo", created: false, skillVersion: null },
    { kind: "connector", ref: "c1", created: true, skillVersion: null },
    { kind: "skill", ref: "s1", created: true, skillVersion: null },
  ],
};

describe("/settings/apps：已安装的应用与卸载", () => {
  it.each(LOCALES)("卸载后按报告列出移除项与保留项及原因（%s）", async (locale) => {
    const a = msgs[locale].directory.apps;
    let gone = false;
    stubApi({
      [`GET ${ORG}/app-installs`]: () => json(200, { installs: gone ? [] : [INSTALL] }),
      [`DELETE ${ORG}/app-installs/i1`]: () => {
        gone = true;
        return json(200, {
          removed: [{ kind: "connector", ref: "c1" }],
          kept: [
            { kind: "plugin", ref: "todo", reason: "pre_existing" },
            { kind: "skill", ref: "s1", reason: "used_by_agents" },
          ],
        });
      },
    });
    renderPage(<AppsPage />, { locale });
    expect(template("SettingsPage")).not.toBeNull();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: a.uninstall }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: a.confirm.confirm }));
    const report = await screen.findByRole("region", {
      name: fill(a.report.title, { name: "crm" }),
    });
    expect(within(report).getByText(`− ${a.componentKind.connector} c1`)).toBeTruthy();
    expect(
      within(report).getByText(
        `· ${a.componentKind.plugin} todo — ${a.report.reason.pre_existing}`,
      ),
    ).toBeTruthy();
    expect(
      within(report).getByText(`· ${a.componentKind.skill} s1 — ${a.report.reason.used_by_agents}`),
    ).toBeTruthy();
  });

  it("仍在安装中：409 app.install_in_progress 给出友好说明", async () => {
    stubApi({
      [`GET ${ORG}/app-installs`]: () =>
        json(200, { installs: [{ ...INSTALL, status: "installing" }] }),
      [`DELETE ${ORG}/app-installs/i1`]: () =>
        json(409, { error: { code: "app.install_in_progress", message: "x" } }),
    });
    renderPage(<AppsPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: en.directory.apps.cleanup }));
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: en.directory.apps.confirm.confirm,
      }),
    );
    expect(await screen.findByText(`✗ ${en.directory.apps.inProgress}`)).toBeTruthy();
  });
});

const SOURCES = {
  offline: true,
  items: [
    {
      id: "official",
      name: "Capybara official catalog",
      url: "https://catalog.capybarahq.com/v1/index.json",
      mirrors: [],
      builtin: true,
      enabled: false,
      disabledByConfig: true,
      hasToken: false,
      lastRefreshedAt: null,
      lastStatus: "never",
      lastError: null,
      entryCount: 0,
    },
    {
      id: "s2",
      name: "Acme",
      url: "https://catalog.acme.com/index.json",
      mirrors: [],
      builtin: false,
      enabled: true,
      disabledByConfig: false,
      hasToken: true,
      lastRefreshedAt: "2026-10-22T00:00:00.000Z",
      lastStatus: "error",
      lastError: "HTTP 500",
      entryCount: 3,
    },
  ],
};

describe("/admin/directory/sources（SettingsPage）", () => {
  it.each(LOCALES)(
    "官方地址只读、离线模式说明；企业清单可改，显示状态与刷新（%s）",
    async (locale) => {
      const s = msgs[locale].directory.admin.sources;
      stubApi({
        "GET /api/v1/admin/catalogs": () => json(200, SOURCES),
        "POST /api/v1/admin/catalogs/s2/refresh": () =>
          json(200, { ...SOURCES.items[1], lastStatus: "ok", lastError: null }),
      });
      renderPage(<SourcesPage />, { locale });
      expect(template("SettingsPage")).not.toBeNull();
      expect(await screen.findByText(s.offline)).toBeTruthy();
      const official = screen.getByDisplayValue(
        SOURCES.items[0]?.url as string,
      ) as HTMLInputElement;
      expect(official.readOnly).toBe(true);
      const acme = screen.getByDisplayValue(SOURCES.items[1]?.url as string) as HTMLInputElement;
      expect(acme.readOnly).toBe(false);
      expect(screen.getByText(fill(s.statusValue.error, { error: "HTTP 500" }))).toBeTruthy();
      const refresh = screen.getAllByRole("button", { name: s.refresh });
      // 官方清单被配置关闭：不能刷新
      expect((refresh[0] as HTMLButtonElement).disabled).toBe(true);
      await userEvent.setup().click(refresh[1] as HTMLElement);
      expect(await screen.findByText(fill(s.refreshed, { name: "Acme" }))).toBeTruthy();
    },
  );
});

describe("/admin/directory 与清单", () => {
  const item = (over: Record<string, unknown>) => ({
    id: ID,
    kind: "plugin",
    name: "cat-a",
    publisher: "Acme",
    displayName: null,
    description: "",
    policy: "allow",
    latestVersion: "1.0.0",
    versions: ["1.0.0"],
    installs: 2,
    source: "catalog",
    catalogSourceId: "official",
    latestCatalogVersion: "2.0.0",
    newerInCatalog: true,
    updatedAt: "2026-10-22T00:00:00.000Z",
    ...over,
  });
  const entry = (over: Record<string, unknown> = {}) => ({
    sourceId: "official",
    sourceName: "Official",
    kind: "plugin",
    name: "cat-a",
    npm: "@acme/plugin-cat-a",
    publisher: "Acme",
    summary: { en: "Cat A" },
    permissions: { keys: ["tools"], sensitive: ["tools"] },
    versions: [
      { version: "3.0.0", compatible: false },
      { version: "2.0.0", compatible: true },
      { version: "1.0.0", compatible: true },
    ],
    adopted: { itemId: ID, versions: ["1.0.0"] },
    newerAvailable: true,
    ...over,
  });

  it("列表：来源与「有新版本」，按来源筛选", async () => {
    const t = en.directory;
    stubApi({
      "GET /api/v1/admin/directory/items": () =>
        json(200, {
          items: [
            item({}),
            item({
              id: "m",
              name: "manual-skill",
              kind: "skill",
              catalogSourceId: null,
              latestCatalogVersion: null,
              newerInCatalog: false,
            }),
          ],
          nextOffset: null,
        }),
      "GET /api/v1/admin/catalogs": () => json(200, SOURCES),
    });
    renderPage(<AdminDirectoryPage />);
    const table = await screen.findByRole("table", { name: t.admin.title });
    const row = (name: string) => within(table).getByText(name).closest("tr") as HTMLElement;
    expect(within(row("cat-a")).getByText(t.source.official)).toBeTruthy();
    expect(await within(row("cat-a")).findByText(t.newer)).toBeTruthy();
    expect(within(row("manual-skill")).getByText(t.source.manual)).toBeTruthy();
    expect(within(row("manual-skill")).queryByText(t.newer)).toBeNull();
    await userEvent.setup().click(screen.getByRole("radio", { name: t.source.manual }));
    expect(within(table).queryByText("cat-a")).toBeNull();
  });

  it("清单：不兼容的版本标出；截断时提示；integrity 不符用醒目的错误", async () => {
    const c = en.directory.admin.catalog;
    stubApi({
      "GET /api/v1/admin/catalogs": () => json(200, SOURCES),
      "GET /api/v1/admin/catalogs/entries": () => json(200, { items: [entry()], truncated: true }),
      "POST /api/v1/admin/catalogs/official/entries/plugin/cat-a/import": () =>
        json(502, { error: { code: "catalog.integrity_mismatch", message: "x" } }),
    });
    renderPage(<CatalogPage />);
    expect(await screen.findByText(c.truncated)).toBeTruthy();
    expect(screen.getByText(fill(c.incompatible, { version: "3.0.0" }))).toBeTruthy();
    const user = userEvent.setup();
    const table = screen.getByRole("table", { name: c.title });
    await user.click(within(table).getAllByRole("button").at(-1) as HTMLElement);
    await user.click(
      await screen.findByRole("menuitem", { name: fill(c.importVersion, { version: "2.0.0" }) }),
    );
    expect(await screen.findByText(`✗ ${en.errors.catalog.integrity_mismatch}`)).toBeTruthy();
  });

  it("条目详情：图标只用 <img> 指向内核路由，不内联", async () => {
    params.current = { itemId: ID };
    stubApi({
      [`GET /api/v1/admin/directory/items/${ID}`]: () =>
        json(200, {
          item: {
            ...item({ kind: "connector-template", name: "gh" }),
            packageName: "@acme/gh",
            deletedAt: null,
          },
          versions: [],
          hasIcon: true,
        }),
      "GET /api/v1/admin/catalogs": () => json(200, SOURCES),
    });
    renderPage(<AdminDirectoryItemPage />);
    const img = (await screen.findByRole("img", {
      name: fill(en.directory.iconAlt, { name: "gh" }),
    })) as HTMLImageElement;
    expect(img.src).toMatch(new RegExp(`/api/v1/admin/directory/items/${ID}/icon$`));
    expect(document.querySelector("svg[data-directory-icon]")).toBeNull();
  });

  it("条目详情：没有图标（hasIcon false）时不渲染图片", async () => {
    params.current = { itemId: ID };
    stubApi({
      [`GET /api/v1/admin/directory/items/${ID}`]: () =>
        json(200, {
          item: {
            ...item({ kind: "app", name: "crm" }),
            packageName: "@acme/crm",
            deletedAt: null,
          },
          versions: [],
          hasIcon: false,
        }),
      "GET /api/v1/admin/catalogs": () => json(200, SOURCES),
    });
    renderPage(<AdminDirectoryItemPage />);
    expect(await screen.findByText("@acme/crm")).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("清单搜索防抖：连续输入只发一次带关键词的请求", async () => {
    const calls = stubApi({
      "GET /api/v1/admin/catalogs": () => json(200, SOURCES),
      "GET /api/v1/admin/catalogs/entries": () => json(200, { items: [entry()], truncated: false }),
    });
    renderPage(<CatalogPage />);
    await screen.findByText("@acme/plugin-cat-a");
    await userEvent
      .setup()
      .type(screen.getByRole("textbox", { name: en.directory.admin.catalog.search }), "cat-a");
    await waitFor(() => expect(calls.some((c) => c.url.includes("q=cat-a"))).toBe(true));
    expect(calls.filter((c) => c.url.includes("q=")).map((c) => c.url)).toEqual([
      "/api/v1/admin/catalogs/entries?q=cat-a",
    ]);
  });
});

describe("收件箱：directory_request", () => {
  it("组织管理员批准成员的目录申请", async () => {
    const d = en.directory.inbox;
    const request = {
      id: "r1",
      orgId: "o1",
      orgName: "Acme",
      item: { id: ID, kind: "skill", name: "pdf-tools", displayName: null },
      version: "1.0.0",
      stage: "org",
      status: "pending",
      note: "please",
      requestedBy: "a2",
      requestedByName: "Mia",
      decidedBy: null,
      decidedAt: null,
      orgDecidedBy: null,
      orgDecidedAt: null,
      createdAt: "2026-10-22T00:00:00.000Z",
    };
    let done = false;
    const calls = stubApi({
      [`GET ${ORG}/inbox`]: () =>
        json(200, {
          items: done
            ? []
            : [{ type: "directory_request", id: "r1", createdAt: request.createdAt, request }],
          truncated: false,
        }),
      [`POST ${ORG}/directory-requests/r1/decide`]: () => {
        done = true;
        return json(200, { request: { ...request, status: "approved" } });
      },
    });
    renderPage(<InboxRoute />);
    expect(
      (await screen.findAllByText(fill(d.title, { name: "pdf-tools" }))).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText("please")).toBeTruthy();
    expect(screen.getByText("Mia")).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: d.approve }));
    expect(await screen.findByText(d.approved)).toBeTruthy();
    expect(bodyOf(calls.find((c) => c.method === "POST"))).toEqual({ decision: "approve" });
  });
});

describe("组织插件：启用被目录条目拒绝", () => {
  it.each(LOCALES)("approval_required 显示翻译后的原因与去目录的入口（%s）", async (locale) => {
    const m = msgs[locale];
    stubApi({
      [`GET ${ORG}/plugins`]: () =>
        json(200, {
          plugins: [
            {
              plugin: "crm-core",
              version: "1.0.0",
              enabled: false,
              configurable: false,
              config: null,
              secrets: [],
              permissions: [],
              orgConfigSchema: null,
            },
          ],
        }),
      [`PUT ${ORG}/plugins/crm-core`]: () =>
        json(403, { error: { code: "directory.approval_required", message: "x" } }),
    });
    renderPage(<PluginsPage />, { locale });
    await userEvent.setup().click(
      await screen.findByRole("switch", {
        name: fill(m.plugins.enableLabel, { plugin: "crm-core" }),
      }),
    );
    expect(await screen.findByText(`✗ ${m.errors.directory.approval_required}`)).toBeTruthy();
    expect(screen.getByRole("link", { name: m.plugins.openDirectory }).getAttribute("href")).toBe(
      "/directory",
    );
  });
});

describe("安装向导的默认 slug", () => {
  it("连接器模板条目按条目名推导（不是连接器种类）；应用里的模板按模板 id", () => {
    expect(defaultSlug({ id: "connector" }, "github-mcp")).toBe("github_mcp");
    expect(defaultSlug({ id: "connector" }, "9-docs")).toBe("docs");
    expect(defaultSlug({ id: "crm-mcp" }, "crm")).toBe("crm_mcp");
    expect(slugOf("中文")).toBe("");
    expect(slugOf("a".repeat(30))).toHaveLength(24);
  });

  it("单模板条目：向导里预填的 slug 来自条目名", async () => {
    params.current = { itemId: ID };
    stubApi({
      [`GET ${ORG}/directory/${ID}`]: () =>
        json(200, {
          item: orgItem({ kind: "connector-template", name: "github-mcp" }),
          hasIcon: false,
          templates: [
            {
              id: "connector",
              displayName: null,
              description: "",
              plugin: "connector-mcp",
              connector: "mcp",
              endpoint: { url: "https://mcp.example.com" },
              editableEndpoint: [],
              auth: { type: "none" },
              ownership: null,
            },
          ],
          plugins: [],
          skills: [],
        }),
      [`GET ${ORG}/plugins`]: () => json(200, { plugins: [] }),
    });
    renderPage(<InstallPage />);
    const slug = (await screen.findByLabelText(en.directory.org.install.slug, {
      exact: false,
    })) as HTMLInputElement;
    expect(slug.value).toBe("github_mcp");
  });
});

describe("部署申请页显示申请人", () => {
  it("Inspector 里有申请人的显示名", async () => {
    stubApi({
      "GET /api/v1/admin/directory/requests": () =>
        json(200, {
          requests: [
            {
              id: "r1",
              orgId: "o1",
              orgName: "Acme",
              item: { id: ID, kind: "app", name: "crm", displayName: null },
              version: null,
              stage: "deployment",
              status: "pending",
              note: "",
              requestedBy: "a2",
              requestedByName: "Mia",
              decidedBy: null,
              decidedAt: null,
              orgDecidedBy: null,
              orgDecidedAt: null,
              createdAt: "2026-10-22T00:00:00.000Z",
            },
          ],
        }),
    });
    renderPage(<RequestsPage />);
    expect(await screen.findByText("Mia")).toBeTruthy();
    expect(screen.getByText(en.directory.admin.requests.fields.requester)).toBeTruthy();
  });
});
