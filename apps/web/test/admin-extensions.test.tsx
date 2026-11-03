import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import ExtensionDetailPage from "../src/app/(app)/admin/extensions/[name]/page";
import ExtensionInstallPage from "../src/app/(app)/admin/extensions/install/page";
import AdminExtensionsPage from "../src/app/(app)/admin/extensions/page";
import { bodyOf, type Call, json, lastStubRoutes, stubApi } from "./support/api";
import { resetNavigation, router } from "./support/navigation";
import { renderRoute, sessionRoutes } from "./support/server";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
const params = { current: { name: "demo" } as Record<string, string> };
const query = { current: {} as Record<string, string> };
const detailPage = () => ExtensionDetailPage({ params: Promise.resolve(params.current) as never });
const installPage = () => ExtensionInstallPage({ searchParams: Promise.resolve(query.current) });
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

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
    required: false,
    installSource: "file",
    ...over,
  };
}

/** A required bootstrap plugin (an install record with source bootstrap, pre-approved). */
const S3 = plugin({
  name: "object-store-s3",
  version: "0.1.0",
  source: "install",
  installSource: "bootstrap",
  required: true,
  desired: { version: "0.1.0", sha256: SHA, state: "enabled" },
  status: "pending_config",
  permissions: [group("provides", ["object-store@1"], { "object-store@1": "object_store" })],
  snapshot: {
    version: "0.1.0",
    approvedAt: "2026-10-21T00:00:00.000Z",
    approvedBy: null,
    source: "bootstrap",
  },
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
  query.current = {};
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("/admin/extensions (ListPage, object rows)", () => {
  it.each(LOCALES)(
    "warn callout first, tabs with counts, rows with chips, meta, state and one action (%s)",
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
      const off = plugin({
        name: "quiet",
        status: "disabled",
        desired: { version: "1.0.0", sha256: SHA, state: "disabled" },
      });
      stubApi({
        "GET /api/v1/admin/extensions": () =>
          json(200, { extensions: [plugin(), diverged, S3, off], drainSeconds: 30 }),
      });
      await renderRoute(() => AdminExtensionsPage(), lastStubRoutes(), { locale });
      expect(template("ListPage")).not.toBeNull();
      const list = await screen.findByRole("list", { name: p.title });
      const row = (name: string) => within(list).getByText(name).closest("li") as HTMLElement;
      // The callout names the two extensions that need attention, above the tabs
      const callout = document.querySelector(".cb-callout") as HTMLElement;
      expect(callout.textContent).toContain("split");
      expect(callout.textContent).toContain("object-store-s3");
      expect(callout.textContent).not.toContain("quiet");
      // Tabs with counts: all 4, needs attention 2, enabled 1, disabled 1
      const tabs = screen.getByRole("tablist");
      for (const [id, n] of [
        ["all", 4],
        ["attention", 2],
        ["enabled", 1],
        ["disabled", 1],
      ] as const) {
        const tab = within(tabs).getByRole("tab", { name: new RegExp(`^${p.tabs[id]}`) });
        expect(tab.textContent).toContain(String(n));
      }
      // Rows: the version and "required" are meta text (no badge), state label, one secondary
      // action (configure when pending; the page head keeps the one primary)
      const s3Meta = within(row("object-store-s3")).getByText(
        new RegExp(`^v\\d.* · ${escapeRe(p.required)} · `),
      );
      expect(s3Meta.closest(".cb-object-chip")).toBeNull();
      // Only "sensitive" is still a badge.
      for (const r of [row("object-store-s3"), row("demo")]) {
        const chips = [...r.querySelectorAll(".cb-object-chip")].map((c) => c.textContent);
        expect(chips.filter((c) => c !== p.sensitive)).toEqual([]);
      }
      expect(within(row("object-store-s3")).getByText(p.status.pending_config)).toBeTruthy();
      expect(
        within(row("object-store-s3"))
          .getByRole("link", { name: p.configure })
          .getAttribute("href"),
      ).toBe("/admin/extensions/object-store-s3");
      expect(
        within(row("object-store-s3")).getByRole("link", { name: p.configure }).className,
      ).toContain("cb-btn-link-default");
      expect(within(row("demo")).getByText(p.status.enabled)).toBeTruthy();
      expect(within(row("demo")).getByRole("link", { name: p.settings })).toBeTruthy();
      expect(
        within(row("demo")).queryByText(new RegExp(` · ${escapeRe(p.required)} · `)),
      ).toBeNull();
      expect(within(row("demo")).getByText(new RegExp(escapeRe(p.source.install)))).toBeTruthy();
      expect(
        within(row("split")).getByText(
          new RegExp(escapeRe(fill(p.replicas.diverged, { ok: 1, n: 2 }))),
        ),
      ).toBeTruthy();
      // 「副本一致 2/2」: the replicas that agree out of all of them
      expect(
        within(row("demo")).getByText(
          new RegExp(escapeRe(fill(p.replicas.consistent, { ok: 2, n: 2 }))),
        ),
      ).toBeTruthy();
      expect(
        within(row("object-store-s3")).getByText(new RegExp(escapeRe(p.source.bootstrap))),
      ).toBeTruthy();

      const user = userEvent.setup();
      await user.click(within(tabs).getByRole("tab", { name: new RegExp(`^${p.tabs.disabled}`) }));
      expect(within(list).queryByText("demo")).toBeNull();
      expect(within(list).getByText("quiet")).toBeTruthy();
    },
  );

  it("row actions: no 详情 (the name and the action open it); 升级 alone is a button, no menu of one", async () => {
    const p = msgs.zh.admin.extensions;
    stubApi({
      "GET /api/v1/admin/extensions": () =>
        json(200, { extensions: [plugin(), S3], drainSeconds: 30 }),
    });
    await renderRoute(() => AdminExtensionsPage(), lastStubRoutes(), { locale: "zh" });
    const list = await screen.findByRole("list", { name: p.title });
    const row = (name: string) => within(list).getByText(name).closest("li") as HTMLElement;
    expect(within(list).queryByRole("button", { name: "更多操作" })).toBeNull();
    expect(within(list).queryByText("查看详情")).toBeNull();
    expect(within(row("demo")).getByRole("link", { name: p.upgrade }).getAttribute("href")).toBe(
      "/admin/extensions/install?upgrade=demo",
    );
    expect(
      within(row("object-store-s3"))
        .getAllByRole("link")
        .map((l) => l.textContent),
    ).toEqual(["object-store-s3", p.configure, p.upgrade]);
  });

  it("nothing needs attention: no callout, no tab that equals All", async () => {
    stubApi({
      "GET /api/v1/admin/extensions": () =>
        json(200, { extensions: [plugin(), plugin({ name: "other" })], drainSeconds: 30 }),
    });
    await renderRoute(() => AdminExtensionsPage(), lastStubRoutes());
    await screen.findByRole("list", { name: en.admin.extensions.title });
    expect(document.querySelector(".cb-callout")).toBeNull();
    expect(screen.queryByRole("tablist")).toBeNull();
  });
});

/** 只给详情页用的路由：列表（详情页从列表取，带 drainSeconds）与配置。 */
function detailRoutes(view: View, extra: Record<string, (c: Call) => Response> = {}) {
  return stubApi({
    "GET /api/v1/admin/extensions": () => json(200, { extensions: [view], drainSeconds: 45 }),
    // the detail page reads the deployment config on the server too
    [`GET /api/v1/admin/extensions/${String(view.name)}/config`]: () =>
      json(200, {
        plugin: view.name,
        version: "1.0.0",
        configurable: false,
        schema: null,
        fields: [],
        valid: true,
        validated: true,
        issues: [],
      }),
    ...extra,
  });
}

describe("/admin/extensions/[name] (DetailPage)", () => {
  it.each(LOCALES)(
    "a required bootstrap plugin: no disable or uninstall, says why; upgradable; approved via bootstrap (%s)",
    async (locale) => {
      const p = msgs[locale].admin.extensions;
      params.current = { name: "object-store-s3" };
      detailRoutes(S3);
      await renderRoute(detailPage, lastStubRoutes(), { locale });
      expect(template("DetailPage")).not.toBeNull();
      // waiting for config: the page opens on the Config tab
      const user = userEvent.setup();
      const configTab = await screen.findByRole("tab", { name: p.detail.tabs.config });
      expect(configTab.getAttribute("aria-selected")).toBe("true");
      await user.click(screen.getByRole("tab", { name: p.detail.tabs.overview }));
      await screen.findByText(p.detail.requiredNote);
      expect(screen.getByText(p.source.bootstrap)).toBeTruthy();
      expect(screen.queryByRole("button", { name: p.detail.actions.disable })).toBeNull();
      expect(screen.queryByRole("button", { name: p.detail.actions.uninstall })).toBeNull();
      expect(screen.queryByText(p.detail.uninstallNeedsDisable)).toBeNull();
      const upgrade = screen.getByRole("link", { name: p.detail.actions.upgrade });
      expect(upgrade.getAttribute("href")).toBe(
        "/admin/extensions/install?upgrade=object-store-s3",
      );
      // 升级 is a secondary button, never a browser-default blue link
      expect(upgrade.getAttribute("data-variant")).toBe("secondary");
      expect(upgrade.className).toContain("cb-btn");
      // The bootstrap step installs from npm with pinned versions and checksums
      expect(p.detail.requiredNote).toContain(
        locale === "zh" ? "由预装步骤从 npm 安装（版本与校验和已固定）。" : "from npm",
      );
      await user.click(
        screen.getByRole("tab", { name: new RegExp(`^${p.detail.tabs.permissions}`) }),
      );
      expect(await screen.findByText(new RegExp(escapeRe(p.approve.via.bootstrap)))).toBeTruthy();
      expect(screen.queryByRole("button", { name: p.approve.submit })).toBeNull();
    },
  );

  it("an optional bootstrap plugin is managed like any install record", async () => {
    detailRoutes(
      plugin({
        installSource: "bootstrap",
        desired: { version: "1.0.0", sha256: SHA, state: "disabled" },
        status: "disabled",
      }),
    );
    await renderRoute(detailPage, lastStubRoutes());
    const p = en.admin.extensions;
    expect(await screen.findByText(p.source.bootstrap)).toBeTruthy();
    expect(screen.queryByText(p.detail.requiredNote)).toBeNull();
    expect(screen.getByRole("button", { name: p.detail.actions.enable })).toBeTruthy();
    expect(screen.getByRole("button", { name: p.detail.actions.uninstall })).toBeTruthy();
  });

  it("配置声明的插件：同样没有生命周期按钮，并说明要改启动配置", async () => {
    detailRoutes(plugin({ source: "config", sha256: null, desired: null, removable: false }));
    await renderRoute(detailPage, lastStubRoutes());
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
      await renderRoute(detailPage, lastStubRoutes(), { locale });
      const p = msgs[locale].admin.extensions;
      const reason = p.detail.replicaReason.setup_failed;
      const alert = await screen.findByText(
        fill(p.detail.failedReplica, { replica: "web-2-222-bbbbbb", reason }),
      );
      expect(alert).toBeTruthy();
      expect(screen.getAllByText(/connect ECONNREFUSED/).length).toBeGreaterThan(0);
      const serving = fill(p.detail.stillServing, { version: "v1.0.0" });
      expect(screen.getAllByText(serving).length).toBeGreaterThan(0);
      const replicas = screen.getByRole("table", { name: p.detail.replicasTitle });
      expect(within(replicas).getByText("web-1-111-aaaaaa")).toBeTruthy();
      expect(within(replicas).getByText("web-2-222-bbbbbb")).toBeTruthy();
      expect(within(replicas).getByText(`${reason} · connect ECONNREFUSED`)).toBeTruthy();
      expect(within(replicas).queryByText(/setup_failed/)).toBeNull();
    },
  );

  it("停用：确认框写明在途调用最多等待 N 秒；确认后 POST disable 并显示收敛中", async () => {
    // the page renders again on the server after the change: the list then answers with the new state
    let current = plugin();
    const calls = detailRoutes(plugin(), {
      "GET /api/v1/admin/extensions": () => json(200, { extensions: [current], drainSeconds: 45 }),
      "POST /api/v1/admin/extensions/demo/disable": () => {
        current = plugin({
          status: "converging",
          desired: { version: "1.0.0", sha256: SHA, state: "disabled" },
        });
        return json(200, current);
      },
    });
    await renderRoute(detailPage, lastStubRoutes());
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
    await renderRoute(detailPage, lastStubRoutes());
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
    const { calls: server } = await renderRoute(detailPage, lastStubRoutes(), { locale: "zh" });
    const p = zh.admin.extensions;
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("tab", { name: new RegExp(`^${p.detail.tabs.permissions}`) }),
    );
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
    const before = server.filter((c) => c.method === "GET").length;
    await user.click(screen.getByRole("button", { name: p.approve.refresh }));
    await vi.waitFor(() =>
      expect(server.filter((c) => c.method === "GET").length).toBeGreaterThan(before),
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
    await renderRoute(detailPage, lastStubRoutes());
    const p = en.admin.extensions;
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("tab", { name: new RegExp(`^${p.detail.tabs.permissions}`) }),
    );
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
    await renderRoute(detailPage, lastStubRoutes(), { locale: "zh" });
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("tab", {
        name: new RegExp(`^${zh.admin.extensions.detail.tabs.permissions}`),
      }),
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
      await renderRoute(detailPage, lastStubRoutes());
      const p = en.admin.extensions;
      expect(await screen.findByText(p.detail.converging)).toBeTruthy();
      await vi.advanceTimersByTimeAsync(3100);
      await vi.waitFor(() => expect(polls).toBe(1));
      // 出错：仍显示上一次的数据（收敛中），没有变成错误页
      expect(screen.getByText(p.detail.converging)).toBeTruthy();
      expect(screen.getByRole("table", { name: p.detail.replicasTitle })).toBeTruthy();
      await vi.advanceTimersByTimeAsync(3100);
      await vi.waitFor(() => expect(screen.queryByText(p.detail.converging)).toBeNull());
      // the list is not read again: only this extension is polled
      expect(calls.filter((c) => c.url === "/api/v1/admin/extensions").length).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(LOCALES)(
    "配置：只读字段显示来源且不可改；密钥不回显，只能设置或清除；保存只发改动（补丁）（%s）",
    async (locale) => {
      const p = msgs[locale].admin.extensions;
      const sf = msgs[locale].configForm;
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
      await renderRoute(detailPage, lastStubRoutes(), { locale });
      const user = userEvent.setup();
      await user.click(await screen.findByRole("tab", { name: p.detail.tabs.config }));
      const region = (await screen.findByLabelText("region")) as HTMLInputElement;
      expect(region.disabled).toBe(true);
      expect(region.value).toBe("eu-1");
      expect(
        screen.getAllByText(locale === "zh" ? /来自配置文件/ : /From the config file/).length,
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
      await user.type(screen.getByLabelText("burst"), "5");
      await user.click(screen.getByRole("button", { name: p.config.save }));
      await vi.waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
      expect(bodyOf(calls.find((c) => c.method === "PUT"))).toEqual({
        values: { greeting: "hello", token: null, "limits.burst": 5 },
      });
    },
  );

  it("pending config without hints: opens on the form, lists what is missing; endpoints as a repeater, keys as a record", async () => {
    const p = msgs.en.admin.extensions;
    const calls = detailRoutes(plugin({ status: "pending_config", configValid: false }), {
      "GET /api/v1/admin/extensions/demo/config": () =>
        json(200, {
          plugin: "demo",
          displayName: null,
          version: "1.0.0",
          configurable: true,
          schema: {
            type: "object",
            properties: {
              endpoints: {
                type: "array",
                minItems: 1,
                items: {
                  type: "object",
                  properties: { name: { type: "string" }, baseUrl: { type: "string" } },
                  required: ["name", "baseUrl"],
                },
              },
              apiKeys: {
                type: "object",
                propertyNames: { type: "string" },
                additionalProperties: { type: "string" },
                "x-secret": true,
              },
            },
            required: ["endpoints"],
          },
          fields: [
            { path: "endpoints", secret: false, hot: false, source: "unset", readonly: false },
            {
              path: "apiKeys",
              secret: true,
              hot: false,
              source: "unset",
              readonly: false,
              set: false,
            },
          ],
          valid: false,
          validated: true,
          issues: [{ path: "endpoints", segments: ["endpoints"], message: "expected array" }],
        }),
      "PUT /api/v1/admin/extensions/demo/config": () =>
        json(200, {
          plugin: "demo",
          version: "1.0.0",
          configurable: true,
          schema: null,
          fields: [],
          valid: true,
          validated: true,
          issues: [],
        }),
    });
    await renderRoute(detailPage, lastStubRoutes(), { locale: "en" });
    expect(
      await screen.findByText(fill(p.config.pendingMissing, { fields: "endpoints" })),
    ).toBeTruthy();
    // the view's issue sits on the repeater
    expect(screen.getByText("expected array")).toBeTruthy();
    const user = userEvent.setup();
    const list = screen.getByRole("group", { name: "endpoints" });
    await user.click(within(list).getByRole("button", { name: /Add/ }));
    await user.type(within(list).getByLabelText(/^name/), "vllm");
    await user.type(within(list).getByLabelText(/^baseUrl/), "http://vllm.internal/v1");
    const keys = screen.getByRole("group", { name: "apiKeys" });
    await user.click(within(keys).getByRole("button", { name: /Add/ }));
    await user.type(within(keys).getByLabelText("Key 1"), "vllm");
    await user.type(within(keys).getByLabelText("Value 1"), "sk-1");
    await user.click(screen.getByRole("button", { name: p.config.save }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(bodyOf(calls.find((c) => c.method === "PUT"))).toEqual({
      values: {
        endpoints: [{ name: "vllm", baseUrl: "http://vllm.internal/v1" }],
        apiKeys: { vllm: "sk-1" },
      },
    });
  });
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
      await renderRoute(installPage, lastStubRoutes(), { locale });
      expect(template("WizardPage")).not.toBeNull();
      const user = userEvent.setup();
      await user.click(screen.getByRole("radio", { name: new RegExp(`^${p.wizard.sourceNpm}`) }));
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
      const marks = within(review).getAllByText(msgs[locale].extensions.sensitive);
      expect(marks.length).toBeGreaterThan(0);
      // One attention style: the word in warn; the group is a hairline card, never an accent box.
      for (const m of marks) expect(m.getAttribute("data-tone")).toBe("warn");
      expect(review.querySelector('.cb-card[data-tone="accent"]')).toBeNull();
      // Only the mark is yellow: reasons are secondary text, items the plain list colour.
      for (const el of review.querySelectorAll('[data-tone="warn"]')) {
        expect(el.textContent).toBe(msgs[locale].extensions.sensitive);
      }
      expect(
        within(review)
          .getByText(msgs[locale].extensions.review.reason.sandbox)
          .getAttribute("data-tone"),
      ).toBe("muted");
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
    await renderRoute(installPage, lastStubRoutes());
    const p = en.admin.extensions;
    const user = userEvent.setup();
    await user.click(screen.getByRole("radio", { name: new RegExp(`^${p.wizard.sourceNpm}`) }));
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
    query.current = { upgrade: "demo" };
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
    await renderRoute(installPage, lastStubRoutes());
    const p = en.admin.extensions;
    expect(await screen.findByText(fill(p.wizard.upgradeTitle, { name: "demo" }))).toBeTruthy();
    const user = userEvent.setup();
    await user.click(screen.getByRole("radio", { name: new RegExp(`^${p.wizard.sourceNpm}`) }));
    await user.type(screen.getByLabelText(p.wizard.npmPackage), "demo");
    await user.click(screen.getByRole("button", { name: p.wizard.fetch }));
    expect(
      await screen.findByText(fill(p.wizard.upgradeFrom, { from: "v1.0.0", to: "v2.0.0" })),
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

  it("the source step: card radios and the 选择文件 drop zone with the chosen file in it", async () => {
    stubApi({
      "GET /api/v1/admin/extensions": () => json(200, { extensions: [], drainSeconds: 30 }),
      "GET /api/v1/me": () => json(200, {}),
    });
    await renderRoute(installPage, { ...lastStubRoutes(), ...sessionRoutes() }, { locale: "zh" });
    const w = zh.admin.extensions.wizard;
    const group = await screen.findByRole("radiogroup", { name: w.sourceLabel });
    expect(group.getAttribute("data-variant")).toBe("card");
    expect(within(group).getByText(w.sourceNpmHint)).toBeTruthy();
    const zone = document.querySelector('[data-part="file-picker"]') as HTMLElement;
    expect(within(zone).getByRole("button", { name: w.choose })).toBeTruthy();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent
      .setup()
      .upload(
        input,
        new File([new Uint8Array([1])], "demo-1.0.0.tgz", { type: "application/gzip" }),
      );
    expect(within(zone).getByText("demo-1.0.0.tgz")).toBeTruthy();
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
    await renderRoute(installPage, { ...lastStubRoutes(), ...sessionRoutes() });
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
      // the browser's session checks (before and after the upload); the server's own read is
      // served by sessionRoutes below
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
    await renderRoute(installPage, { ...lastStubRoutes(), ...sessionRoutes() }, { locale: "zh" });
    const p = zh.admin.extensions;
    const user = userEvent.setup();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, new File([new Uint8Array([1])], "x.tgz"));
    await user.click(screen.getByRole("button", { name: p.wizard.upload }));
    expect(await screen.findByText(new RegExp(escapeRe(p.wizard.sessionExpired)))).toBeTruthy();
    expect(screen.queryByText(new RegExp(escapeRe(zh.errors.upstream_unavailable)))).toBeNull();
  });
});
