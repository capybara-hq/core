import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import ExtensionDetailPage from "../src/app/[locale]/(app)/admin/extensions/[name]/page";
import ExtensionInstallPage from "../src/app/[locale]/(app)/admin/extensions/install/page";
import AdminExtensionsPage from "../src/app/[locale]/(app)/admin/extensions/page";
import { bodyOf, type Call, json, stubApi } from "./support/api";
import { resetNavigation, router } from "./support/navigation";
import { renderPage } from "./support/render";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
const params = { current: { name: "demo" } as Record<string, string> };
vi.mock("next/navigation", () => ({ useParams: () => params.current }));

const msgs = { zh, en } as const;
const LOCALES = ["zh", "en"] as const;
const template = (name: string) => document.querySelector(`[data-template="${name}"]`);
const fill = (s: string, vars: Record<string, string | number>) =>
  s.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k]));

const SHA = "a".repeat(64);
const HEARTBEAT = "2026-10-22T08:00:00.000Z";

type View = Record<string, unknown>;

/** 内核给的权限分组：`reasons` 里列出的项为敏感（原因码由内核判定，界面只渲染）。 */
function group(category: string, items: string[], reasons: Record<string, string> = {}) {
  const entries = items.map((value) =>
    reasons[value] === undefined
      ? { value, sensitive: false }
      : { value, sensitive: true, reason: reasons[value] },
  );
  return { category, sensitive: entries.some((e) => e.sensitive), items, entries };
}

/** `added` 与逐项的敏感标记（`addedItems`）。 */
function addedOf(keys: string[], reasons: Record<string, string> = {}) {
  return {
    added: keys,
    addedItems: keys.map((value) =>
      reasons[value] === undefined
        ? { value, sensitive: false }
        : { value, sensitive: true, reason: reasons[value] },
    ),
  };
}

function plugin(over: View = {}): View {
  return {
    name: "demo",
    version: "1.0.0",
    source: "install",
    sha256: SHA,
    status: "enabled",
    desired: { version: "1.0.0", sha256: SHA, state: "enabled" },
    replicas: [
      {
        replicaId: "web-1-111-aaaaaa",
        version: "1.0.0",
        state: "loaded",
        reason: null,
        detail: null,
        heartbeatAt: HEARTBEAT,
      },
      {
        replicaId: "web-2-222-bbbbbb",
        version: "1.0.0",
        state: "loaded",
        reason: null,
        detail: null,
        heartbeatAt: HEARTBEAT,
      },
    ],
    permissions: [
      group("tools", ["echo"], { echo: "tools" }),
      group("network", ["api.example.com"]),
    ],
    added: [],
    addedItems: [],
    warnings: [],
    removed: [],
    reviewHash: "0123456789abcdef",
    sensitive: true,
    snapshot: {
      version: "1.0.0",
      approvedAt: "2026-10-21T00:00:00.000Z",
      approvedBy: "a1",
      source: "web",
    },
    configurable: true,
    configValid: true,
    removable: true,
    ...over,
  };
}

const S3 = plugin({
  name: "object-store-s3",
  source: "builtin",
  sha256: null,
  desired: null,
  status: "pending_config",
  permissions: [group("provides", ["object-store@1"], { "object-store@1": "object_store" })],
  snapshot: null,
  removable: false,
});

const REVIEW = {
  sha256: SHA,
  name: "demo",
  version: "1.0.0",
  permissions: [
    group("provides", ["sandbox@1"], { "sandbox@1": "sandbox" }),
    group("network", ["api.example.com"]),
    group("tables", ["notes"]),
  ],
  ...addedOf(["provides:sandbox@1", "permissions.network:api.example.com"], {
    "provides:sandbox@1": "sandbox",
  }),
  removed: [],
  reviewHash: "0123456789abcdef",
  warnings: [],
};

beforeEach(() => {
  resetNavigation("/admin/extensions");
  params.current = { name: "demo" };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("/admin/extensions (ListPage)", () => {
  it.each(LOCALES)(
    "列出来源、状态、敏感与副本是否一致；Rail 按状态与来源筛选（%s）",
    async (locale) => {
      const p = msgs[locale].admin.extensions;
      const diverged = plugin({
        name: "split",
        status: "failed",
        replicas: [
          { ...(plugin().replicas as View[])[0], state: "loaded" },
          {
            ...(plugin().replicas as View[])[1],
            state: "failed",
            reason: "setup_failed",
            detail: "boom",
          },
        ],
      });
      stubApi({
        "GET /api/v1/admin/extensions": () =>
          json(200, { extensions: [plugin(), diverged, S3], drainSeconds: 30 }),
      });
      renderPage(<AdminExtensionsPage />, { locale });
      expect(template("ListPage")).not.toBeNull();
      const table = await screen.findByRole("table", { name: p.title });
      const row = (name: string) => within(table).getByText(name).closest("tr") as HTMLElement;
      expect(within(row("demo")).getByText(p.source.install)).toBeTruthy();
      expect(within(row("demo")).getByText(fill(p.replicas.consistent, { n: 2 }))).toBeTruthy();
      expect(within(row("demo")).getByText(p.sensitive)).toBeTruthy();
      expect(within(row("split")).getByText(fill(p.replicas.diverged, { n: 2 }))).toBeTruthy();
      expect(within(row("object-store-s3")).getByText(p.source.builtin)).toBeTruthy();
      expect(
        within(row("object-store-s3")).getByText(new RegExp(escapeRe(p.status.pending_config))),
      ).toBeTruthy();

      const user = userEvent.setup();
      await user.click(screen.getByRole("radio", { name: p.status.failed }));
      expect(within(table).queryByText("demo")).toBeNull();
      expect(within(table).getByText("split")).toBeTruthy();
      await user.click(screen.getByRole("radio", { name: p.filters.allStatuses }));
      await user.click(screen.getByRole("radio", { name: p.source.builtin }));
      expect(within(table).queryByText("demo")).toBeNull();
      expect(within(table).getByText("object-store-s3")).toBeTruthy();
    },
  );
});

/** 只给详情页用的路由：列表（详情页从列表取，带 drainSeconds）与配置。 */
function detailRoutes(view: View, extra: Record<string, (c: Call) => Response> = {}) {
  return stubApi({
    "GET /api/v1/admin/extensions": () => json(200, { extensions: [view], drainSeconds: 45 }),
    ...extra,
  });
}

describe("/admin/extensions/[name] (DetailPage)", () => {
  it.each(LOCALES)(
    "内置插件：没有停用 / 升级 / 卸载按钮并说明原因；权限只读、注明预先批准（%s）",
    async (locale) => {
      const p = msgs[locale].admin.extensions;
      params.current = { name: "object-store-s3" };
      detailRoutes(S3);
      renderPage(<ExtensionDetailPage />, { locale });
      expect(template("DetailPage")).not.toBeNull();
      await screen.findByText(p.detail.builtinNote);
      for (const label of Object.values(p.detail.actions)) {
        expect(screen.queryByRole("button", { name: label })).toBeNull();
        expect(screen.queryByRole("link", { name: label })).toBeNull();
      }
      const user = userEvent.setup();
      await user.click(screen.getByRole("tab", { name: p.detail.tabs.permissions }));
      expect(await screen.findByText(p.approve.builtin)).toBeTruthy();
      expect(screen.queryByRole("button", { name: p.approve.submit })).toBeNull();
    },
  );

  it("配置声明的插件：同样没有生命周期按钮，并说明要改启动配置", async () => {
    detailRoutes(plugin({ source: "config", sha256: null, desired: null, removable: false }));
    renderPage(<ExtensionDetailPage />);
    const p = en.admin.extensions;
    await screen.findByText(p.detail.configNote);
    expect(screen.queryByRole("button", { name: p.detail.actions.disable })).toBeNull();
    expect(screen.queryByRole("button", { name: p.detail.actions.uninstall })).toBeNull();
  });

  it.each(LOCALES)(
    "副本分歧：列出出错的副本与翻译后的原因、心跳；新版失败而旧版仍在服务时两者都显示（%s）",
    async (locale) => {
      const view = plugin({
        status: "failed",
        replicas: [
          { ...(plugin().replicas as View[])[0], servingVersion: null },
          {
            ...(plugin().replicas as View[])[1],
            version: "2.0.0",
            state: "failed",
            reason: "setup_failed",
            detail: "connect ECONNREFUSED",
            servingVersion: "1.0.0",
          },
        ],
      });
      detailRoutes(view);
      renderPage(<ExtensionDetailPage />, { locale });
      const p = msgs[locale].admin.extensions;
      const reason = p.detail.replicaReason.setup_failed;
      const alert = await screen.findByText(
        fill(p.detail.failedReplica, { replica: "web-2-222-bbbbbb", reason }),
      );
      expect(alert).toBeTruthy();
      expect(screen.getAllByText(/connect ECONNREFUSED/).length).toBeGreaterThan(0);
      const serving = fill(p.detail.stillServing, { version: "1.0.0" });
      expect(screen.getAllByText(serving).length).toBeGreaterThan(0);
      const replicas = screen.getByRole("table", { name: p.detail.replicasTitle });
      expect(within(replicas).getByText("web-1-111-aaaaaa")).toBeTruthy();
      expect(within(replicas).getByText("web-2-222-bbbbbb")).toBeTruthy();
      expect(within(replicas).getByText(`${reason} · connect ECONNREFUSED`)).toBeTruthy();
      expect(within(replicas).queryByText(/setup_failed/)).toBeNull();
    },
  );

  it("停用：确认框写明在途调用最多等待 N 秒；确认后 POST disable 并显示收敛中", async () => {
    const calls = detailRoutes(plugin(), {
      "POST /api/v1/admin/extensions/demo/disable": () =>
        json(
          200,
          plugin({
            status: "converging",
            desired: { version: "1.0.0", sha256: SHA, state: "disabled" },
          }),
        ),
    });
    renderPage(<ExtensionDetailPage />);
    const p = en.admin.extensions;
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: p.detail.actions.disable }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(fill(p.detail.drainHint, { seconds: 45 }))).toBeTruthy();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: p.detail.disableConfirm.confirm }));
    await vi.waitFor(() =>
      expect(calls.some((c) => c.url.endsWith("/demo/disable") && c.method === "POST")).toBe(true),
    );
    expect(await screen.findByText(p.detail.converging)).toBeTruthy();
  });

  it("启用中的安装记录：卸载须先停用（不提供卸载按钮）；升级链接到安装向导", async () => {
    detailRoutes(plugin());
    renderPage(<ExtensionDetailPage />);
    const p = en.admin.extensions;
    await screen.findByText(p.detail.uninstallNeedsDisable);
    expect(screen.queryByRole("button", { name: p.detail.actions.uninstall })).toBeNull();
    expect(screen.getByRole("link", { name: p.detail.actions.upgrade }).getAttribute("href")).toBe(
      "/admin/extensions/install?upgrade=demo",
    );
  });

  it("待批准：勾选「我已了解敏感项」前批准不可用；409 approval_stale 时提示刷新，刷新后重读", async () => {
    const pending = plugin({
      status: "pending_approval",
      snapshot: null,
      ...addedOf(["permissions.tools:echo"], { "permissions.tools:echo": "tools" }),
    });
    const calls = detailRoutes(pending, {
      "POST /api/v1/admin/extensions/demo/approve": () =>
        json(409, { error: { code: "extension.approval_stale", message: "stale" } }),
    });
    renderPage(<ExtensionDetailPage />, { locale: "zh" });
    const p = zh.admin.extensions;
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: p.detail.tabs.permissions }));
    const submit = await screen.findByRole("button", { name: p.approve.submit });
    expect(submit.hasAttribute("disabled")).toBe(true);
    await user.click(screen.getByRole("checkbox", { name: p.approve.ack }));
    expect(submit.hasAttribute("disabled")).toBe(false);
    await user.click(submit);
    expect(await screen.findByText(new RegExp(escapeRe(p.approve.stale)))).toBeTruthy();
    expect(bodyOf(calls.find((c) => c.method === "POST"))).toEqual({
      sha256: SHA,
      reviewHash: "0123456789abcdef",
    });
    const before = calls.filter((c) => c.method === "GET").length;
    await user.click(screen.getByRole("button", { name: p.approve.refresh }));
    await vi.waitFor(() =>
      expect(calls.filter((c) => c.method === "GET").length).toBeGreaterThan(before),
    );
  });

  it("待批准且包里有迁移警告（权限都不敏感）：详情页列出警告，批准前同样须勾选", async () => {
    const pending = plugin({
      status: "pending_approval",
      snapshot: null,
      permissions: [group("tables", ["notes"])],
      sensitive: false,
      ...addedOf(["tables:notes"]),
      warnings: [
        {
          kind: "destructive_migration",
          sensitive: true,
          file: "0002_drop.sql",
          line: 1,
          statement: "DROP TABLE plugin_demo.old",
        },
      ],
    });
    detailRoutes(pending);
    renderPage(<ExtensionDetailPage />);
    const p = en.admin.extensions;
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: p.detail.tabs.permissions }));
    expect(await screen.findByText("DROP TABLE plugin_demo.old")).toBeTruthy();
    const submit = screen.getByRole("button", { name: p.approve.submit });
    expect(submit.hasAttribute("disabled")).toBe(true);
    await user.click(screen.getByRole("checkbox", { name: p.approve.ack }));
    expect(submit.hasAttribute("disabled")).toBe(false);
  });

  it("新增权限按内核给的逐项标记高亮并写原因码对应的文案（界面不自己判定）", async () => {
    const pending = plugin({
      status: "pending_approval",
      ...addedOf(["permissions.tools:echo", "permissions.network:x.example.com"], {
        "permissions.tools:echo": "tools",
      }),
    });
    detailRoutes(pending);
    renderPage(<ExtensionDetailPage />, { locale: "zh" });
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("tab", { name: zh.admin.extensions.detail.tabs.permissions }),
    );
    expect(
      await screen.findByText(`+ permissions.tools:echo · ${zh.extensions.review.reason.tools}`),
    ).toBeTruthy();
    expect(screen.getByText("+ permissions.network:x.example.com")).toBeTruthy();
  });

  it("收敛中：只轮询 GET /:name；轮询出错时保留上一次的数据", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let polls = 0;
      const calls = detailRoutes(plugin({ status: "converging" }), {
        "GET /api/v1/admin/extensions/demo": () => {
          polls++;
          return polls === 1
            ? json(503, { error: { code: "upstream_unavailable", message: "down" } })
            : json(200, plugin({ status: "enabled" }));
        },
      });
      renderPage(<ExtensionDetailPage />);
      const p = en.admin.extensions;
      expect(await screen.findByText(p.detail.converging)).toBeTruthy();
      await vi.advanceTimersByTimeAsync(3100);
      await vi.waitFor(() => expect(polls).toBe(1));
      // 出错：仍显示上一次的数据（收敛中），没有变成错误页
      expect(screen.getByText(p.detail.converging)).toBeTruthy();
      expect(screen.getByRole("table", { name: p.detail.replicasTitle })).toBeTruthy();
      await vi.advanceTimersByTimeAsync(3100);
      await vi.waitFor(() => expect(screen.queryByText(p.detail.converging)).toBeNull());
      expect(calls.filter((c) => c.url === "/api/v1/admin/extensions").length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(LOCALES)(
    "配置：只读字段显示来源且不可改；密钥不回显，只能设置或清除；保存只发改动（补丁）（%s）",
    async (locale) => {
      const p = msgs[locale].admin.extensions;
      const sf = msgs[locale].schemaForm;
      const calls = detailRoutes(plugin(), {
        "GET /api/v1/admin/extensions/demo/config": () =>
          json(200, {
            plugin: "demo",
            version: "1.0.0",
            configurable: true,
            schema: {
              type: "object",
              properties: {
                region: { type: "string" },
                greeting: { type: "string", default: "hi" },
                token: { type: "string", "x-secret": true },
                limits: { type: "object", properties: { burst: { type: "integer" } } },
              },
            },
            fields: [
              {
                path: "region",
                secret: false,
                hot: false,
                source: "file",
                readonly: true,
                value: "eu-1",
              },
              {
                path: "greeting",
                secret: false,
                hot: true,
                source: "default",
                readonly: false,
                value: "hi",
              },
              { path: "token", secret: true, hot: false, source: "db", readonly: false, set: true },
              { path: "limits.burst", secret: false, hot: false, source: "unset", readonly: false },
            ],
            valid: true,
            validated: true,
            issues: [],
          }),
        "PUT /api/v1/admin/extensions/demo/config": (c) =>
          json(200, {
            plugin: "demo",
            version: "1.0.0",
            configurable: true,
            schema: null,
            fields: [],
            valid: true,
            validated: true,
            issues: [],
            echo: bodyOf(c),
          }),
      });
      renderPage(<ExtensionDetailPage />, { locale });
      const user = userEvent.setup();
      await user.click(await screen.findByRole("tab", { name: p.detail.tabs.config }));
      const region = (await screen.findByLabelText("region")) as HTMLInputElement;
      expect(region.disabled).toBe(true);
      expect(region.value).toBe("eu-1");
      expect(
        screen.getAllByText(new RegExp(escapeRe(p.config.source.file))).length,
      ).toBeGreaterThan(0);
      // 密钥：不回显值、密码框，可清除
      const token = screen.getByLabelText("token") as HTMLInputElement;
      expect(token.type).toBe("password");
      expect(token.value).toBe("");
      expect(
        screen.getByRole("button", { name: fill(sf.clearLabel, { field: "token" }) }),
      ).toBeTruthy();
      // 改 hot 字段 + 清除密钥 + 填嵌套字段
      const greeting = screen.getByLabelText("greeting") as HTMLInputElement;
      await user.clear(greeting);
      await user.type(greeting, "hello");
      await user.click(
        screen.getByRole("button", { name: fill(sf.clearLabel, { field: "token" }) }),
      );
      await user.type(screen.getByLabelText("limits.burst"), "5");
      await user.click(screen.getByRole("button", { name: p.config.save }));
      await vi.waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
      expect(bodyOf(calls.find((c) => c.method === "PUT"))).toEqual({
        values: { greeting: "hello", token: null, "limits.burst": 5 },
      });
    },
  );
});

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("/admin/extensions/install (WizardPage)", () => {
  it.each(LOCALES)(
    "npm → 审阅（敏感项高亮并写明原因，网络标「声明，平台不拦截」）→ 勾选前确认不可用 → install → approve → enable（%s）",
    async (locale) => {
      const p = msgs[locale].admin.extensions;
      const calls = stubApi({
        "GET /api/v1/admin/extensions": () => json(200, { extensions: [S3], drainSeconds: 30 }),
        "POST /api/v1/admin/extensions/packages/npm": () => json(200, REVIEW),
        "POST /api/v1/admin/extensions/demo/install": () =>
          json(
            200,
            plugin({
              status: "pending_approval",
              desired: { version: "1.0.0", sha256: SHA, state: "disabled" },
            }),
          ),
        "POST /api/v1/admin/extensions/demo/approve": () =>
          json(200, plugin({ status: "disabled" })),
        "POST /api/v1/admin/extensions/demo/enable": () =>
          json(200, plugin({ status: "converging" })),
      });
      renderPage(<ExtensionInstallPage />, { locale });
      expect(template("WizardPage")).not.toBeNull();
      const user = userEvent.setup();
      await user.click(screen.getByRole("radio", { name: p.wizard.sourceNpm }));
      await user.type(screen.getByLabelText(p.wizard.npmPackage), "@acme/plugin-demo");
      await user.click(screen.getByRole("button", { name: p.wizard.fetch }));
      await vi.waitFor(() =>
        expect(bodyOf(calls.find((c) => c.url.endsWith("/packages/npm")))).toEqual({
          package: "@acme/plugin-demo",
        }),
      );
      // 审阅：敏感项高亮并写明原因；外部网络标注
      const review = await screen.findByRole("region", {
        name: fill(msgs[locale].extensions.permissionsLabel, { plugin: "demo" }),
      });
      expect(within(review).getByText(msgs[locale].extensions.review.reason.sandbox)).toBeTruthy();
      expect(within(review).getByText(msgs[locale].extensions.review.network)).toBeTruthy();
      expect(within(review).getAllByText(msgs[locale].extensions.sensitive).length).toBeGreaterThan(
        0,
      );
      await user.click(screen.getByRole("button", { name: p.wizard.next }));
      // 确认：勾选前不可用
      const submit = await screen.findByRole("button", { name: p.wizard.install });
      expect(submit.hasAttribute("disabled")).toBe(true);
      await user.click(screen.getByRole("checkbox", { name: p.wizard.ack }));
      expect(submit.hasAttribute("disabled")).toBe(false);
      await user.click(submit);
      await vi.waitFor(() => expect(router.push).toHaveBeenCalledWith("/admin/extensions/demo"));
      const posts = calls.filter((c) => c.method === "POST").map((c) => c.url);
      expect(posts).toEqual([
        "/api/v1/admin/extensions/packages/npm",
        "/api/v1/admin/extensions/demo/install",
        "/api/v1/admin/extensions/demo/approve",
        "/api/v1/admin/extensions/demo/enable",
      ]);
      expect(bodyOf(calls.find((c) => c.url.endsWith("/install")))).toEqual({ sha256: SHA });
      expect(bodyOf(calls.find((c) => c.url.endsWith("/approve")))).toEqual({
        sha256: SHA,
        reviewHash: "0123456789abcdef",
      });
    },
  );

  it("不勾「安装后立即启用」：只 install → approve；迁移警告也算敏感项", async () => {
    const calls = stubApi({
      "GET /api/v1/admin/extensions": () => json(200, { extensions: [], drainSeconds: 30 }),
      "POST /api/v1/admin/extensions/packages/npm": () =>
        json(200, {
          ...REVIEW,
          permissions: [group("tables", ["notes"])],
          warnings: [
            {
              kind: "destructive_migration",
              sensitive: true,
              file: "0002_drop.sql",
              line: 3,
              statement: "DROP TABLE notes",
            },
          ],
        }),
      "POST /api/v1/admin/extensions/demo/install": () =>
        json(200, plugin({ status: "pending_approval" })),
      "POST /api/v1/admin/extensions/demo/approve": () => json(200, plugin({ status: "disabled" })),
    });
    renderPage(<ExtensionInstallPage />);
    const p = en.admin.extensions;
    const user = userEvent.setup();
    await user.click(screen.getByRole("radio", { name: p.wizard.sourceNpm }));
    await user.type(screen.getByLabelText(p.wizard.npmPackage), "demo");
    await user.click(screen.getByRole("button", { name: p.wizard.fetch }));
    expect(await screen.findByText("DROP TABLE notes")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: p.wizard.next }));
    await user.click(await screen.findByRole("checkbox", { name: p.wizard.enableAfter }));
    const submit = screen.getByRole("button", { name: p.wizard.install });
    expect(submit.hasAttribute("disabled")).toBe(true);
    await user.click(screen.getByRole("checkbox", { name: p.wizard.ack }));
    await user.click(submit);
    await vi.waitFor(() => expect(router.push).toHaveBeenCalledWith("/admin/extensions/demo"));
    expect(calls.filter((c) => c.method === "POST").map((c) => c.url.split("/").pop())).toEqual([
      "npm",
      "install",
      "approve",
    ]);
  });

  it("升级：显示新增 / 减少的权限与在途调用的等待时限；包名不符时不能继续", async () => {
    window.history.replaceState(null, "", "/admin/extensions/install?upgrade=demo");
    stubApi({
      "GET /api/v1/admin/extensions": () => json(200, { extensions: [plugin()], drainSeconds: 45 }),
      "POST /api/v1/admin/extensions/packages/npm": (c) =>
        (bodyOf(c) as { package: string }).package === "other"
          ? json(200, { ...REVIEW, name: "other" })
          : json(200, {
              ...REVIEW,
              version: "2.0.0",
              ...addedOf(["provides:sandbox@1"], { "provides:sandbox@1": "sandbox" }),
              removed: ["permissions.tools:echo"],
            }),
    });
    renderPage(<ExtensionInstallPage />);
    const p = en.admin.extensions;
    expect(await screen.findByText(fill(p.wizard.upgradeTitle, { name: "demo" }))).toBeTruthy();
    const user = userEvent.setup();
    await user.click(screen.getByRole("radio", { name: p.wizard.sourceNpm }));
    await user.type(screen.getByLabelText(p.wizard.npmPackage), "demo");
    await user.click(screen.getByRole("button", { name: p.wizard.fetch }));
    expect(
      await screen.findByText(fill(p.wizard.upgradeFrom, { from: "1.0.0", to: "2.0.0" })),
    ).toBeTruthy();
    expect(screen.getByText(fill(p.detail.drainHint, { seconds: 45 }))).toBeTruthy();
    expect(screen.getByText(en.extensions.review.added)).toBeTruthy();
    expect(screen.getByText(en.extensions.review.removed)).toBeTruthy();
    expect(screen.getByText("permissions.tools:echo")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: p.wizard.back }));
    const pkg = screen.getByLabelText(p.wizard.npmPackage);
    await user.clear(pkg);
    await user.type(pkg, "other");
    await user.click(screen.getByRole("button", { name: p.wizard.fetch }));
    expect(
      await screen.findByText(
        new RegExp(escapeRe(fill(p.wizard.upgradeMismatch, { got: "other", want: "demo" }))),
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: p.wizard.next }).hasAttribute("disabled")).toBe(true);
    window.history.replaceState(null, "", "/");
  });

  it("上传 tgz：显示进度，可取消（中止请求，回到选文件）", async () => {
    stubApi({
      "GET /api/v1/admin/extensions": () => json(200, { extensions: [], drainSeconds: 30 }),
      "GET /api/v1/me": () => json(200, {}),
    });
    const xhrs: FakeXhr[] = [];
    class FakeXhr {
      upload: { onprogress: ((e: ProgressEvent) => void) | null } = { onprogress: null };
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      status = 0;
      responseText = "";
      withCredentials = false;
      headers: Record<string, string> = {};
      url = "";
      aborted = false;
      body: unknown;
      constructor() {
        xhrs.push(this);
      }
      open(_m: string, url: string) {
        this.url = url;
      }
      setRequestHeader(k: string, v: string) {
        this.headers[k.toLowerCase()] = v;
      }
      send(body: unknown) {
        this.body = body;
      }
      abort() {
        this.aborted = true;
        this.onabort?.();
      }
    }
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    renderPage(<ExtensionInstallPage />);
    const p = en.admin.extensions;
    const user = userEvent.setup();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(
      input,
      new File([new Uint8Array([1, 2, 3])], "demo-1.0.0.tgz", { type: "application/gzip" }),
    );
    await user.click(screen.getByRole("button", { name: p.wizard.upload }));
    await vi.waitFor(() => expect(xhrs).toHaveLength(1));
    const xhr = xhrs[0] as FakeXhr;
    expect(xhr.url).toBe("/api/v1/admin/extensions/packages/file");
    expect(xhr.headers["x-capybara-csrf"]).toBe("1");
    expect(xhr.headers["content-type"]).toBe("application/octet-stream");
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 2 } as ProgressEvent);
    const bar = await screen.findByRole("progressbar");
    await vi.waitFor(() => expect(bar.getAttribute("aria-valuenow")).toBe("50"));
    await user.click(screen.getByRole("button", { name: /demo-1\.0\.0\.tgz/ }));
    expect(xhr.aborted).toBe(true);
    expect(await screen.findByText(p.wizard.cancelled)).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("上传遇到登录过期（代理报上游不可达且 /me 401）：提示重新登录，不说后端不可用", async () => {
    let me = 0;
    stubApi({
      "GET /api/v1/admin/extensions": () => json(200, { extensions: [], drainSeconds: 30 }),
      "GET /api/v1/me": () => {
        me++;
        return me === 1
          ? json(200, {})
          : json(401, { error: { code: "auth.refresh_invalid", message: "expired" } });
      },
      "POST /api/v1/auth/refresh": () =>
        json(401, { error: { code: "auth.refresh_invalid", message: "expired" } }),
    });
    class FakeXhr {
      upload: { onprogress: ((e: ProgressEvent) => void) | null } = { onprogress: null };
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      status = 502;
      responseText = JSON.stringify({
        error: { code: "upstream_unavailable", message: "Kernel is unreachable" },
      });
      withCredentials = false;
      open() {}
      setRequestHeader() {}
      send() {
        setTimeout(() => this.onload?.(), 0);
      }
      abort() {}
    }
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    renderPage(<ExtensionInstallPage />, { locale: "zh" });
    const p = zh.admin.extensions;
    const user = userEvent.setup();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, new File([new Uint8Array([1])], "x.tgz"));
    await user.click(screen.getByRole("button", { name: p.wizard.upload }));
    expect(await screen.findByText(new RegExp(escapeRe(p.wizard.sessionExpired)))).toBeTruthy();
    expect(screen.queryByText(new RegExp(escapeRe(zh.errors.upstream_unavailable)))).toBeNull();
  });
});
