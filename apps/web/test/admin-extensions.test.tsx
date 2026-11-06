import { describeNestedBox, findNestedBoxes } from "@capybara-hq/design/reference";
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { bodyOf, type Call, json, lastStubRoutes, stubApi } from "./support/api";
import { resetNavigation } from "./support/navigation";
import { renderRouteWithCache } from "./support/query";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
const params = { current: { name: "demo" } as Record<string, string> };
const detailPage = () => `/admin/extensions/${encodeURIComponent(params.current.name ?? "")}`;
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

beforeEach(() => {
  resetNavigation("/admin/extensions");
  // The tab is written to the URL (`?tab=`): every test starts on a clean one.
  window.history.replaceState(null, "", "/");
  params.current = { name: "demo" };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** The table's rows (the header row left out), as their first cell's name. */
const rowNames = () =>
  screen
    .getAllByRole("row")
    .slice(1)
    .map((r) => r.querySelector(".cb-cell-title-name")?.textContent);
const tableRow = (name: string) => screen.getByRole("row", { name: new RegExp(name) });

/** The extension list and, for a Sheet, the deployment config of each. */
function listRoutes(extensions: View[]) {
  return stubApi({
    "GET /api/v1/admin/extensions": () => json(200, { extensions, drainSeconds: 30 }),
    ...Object.fromEntries(
      extensions.map((v) => [
        `GET /api/v1/admin/extensions/${String(v.name)}/config`,
        () =>
          json(200, {
            plugin: v.name,
            version: "1.0.0",
            configurable: false,
            schema: null,
            fields: [],
            valid: true,
            validated: true,
            issues: [],
          }),
      ]),
    ),
  });
}

describe("/admin/extensions (ListPage + DataTable by capability, details in a Sheet)", () => {
  it.each(LOCALES)(
    "warn callout first; tabs by capability with counts; attention sorts first; rows with state, source, scope, replicas (%s)",
    async (locale) => {
      const p = msgs[locale].admin.extensions;
      const m = msgs[locale].extensions;
      const c = msgs[locale].catalog.scope;
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
      listRoutes([plugin({ scope: "optional", enabledOrgs: 3 }), diverged, S3, off]);
      await renderRouteWithCache("/admin/extensions", lastStubRoutes(), { locale });
      expect(template("ListPage")).not.toBeNull();
      expect(screen.getByRole("table", { name: p.title })).toBeTruthy();
      // The callout names the two extensions that need attention, above the tabs
      const callout = document.querySelector(".cb-callout") as HTMLElement;
      expect(callout.textContent).toContain("split");
      expect(callout.textContent).toContain("object-store-s3");
      expect(callout.textContent).not.toContain("quiet");
      // Needs attention first, then enabled, then disabled; by name within each
      expect(rowNames()).toEqual(["object-store-s3", "split", "demo", "quiet"]);
      const tabs = screen.getByRole("tablist");
      const tab = (id: keyof typeof m.tabs) =>
        within(tabs).getByRole("tab", { name: new RegExp(`^${m.tabs[id]}`) });
      for (const [id, n] of [
        ["all", 4],
        ["storage", 1],
        ["tools", 3],
        ["model", 0],
      ] as const) {
        expect(tab(id).textContent).toContain(String(n));
      }
      const s3 = tableRow("object-store-s3");
      expect(within(s3).getByText(p.status.pending_config)).toBeTruthy();
      expect(s3.textContent).toContain(m.capability.objectStore);
      expect(s3.textContent).toContain(`${p.source.bootstrap} · ${p.required}`);
      const demo = tableRow("demo");
      expect(within(demo).getByText(p.status.enabled)).toBeTruthy();
      expect(within(demo).getByText(p.sensitive).getAttribute("data-tone")).toBe("warn");
      expect(demo.textContent).toContain(m.capability.tools);
      expect(demo.textContent).toContain(p.source.install);
      expect(demo.textContent).not.toContain(p.required);
      expect(demo.textContent).toContain(`${c.optional} · ${fill(p.meta.orgs, { n: 3 })}`);
      expect(demo.textContent).toContain(fill(p.replicas.consistent, { ok: 2, n: 2 }));
      expect(tableRow("split").textContent).toContain(fill(p.replicas.diverged, { ok: 1, n: 2 }));
      const user = userEvent.setup();
      await user.click(tab("storage"));
      expect(rowNames()).toEqual(["object-store-s3"]);
      expect(window.location.search).toBe("?tab=storage");
    },
  );

  it.each(LOCALES)(
    "a row opens a Sheet: config, state, the actions and replicas, permissions folded (%s)",
    async (locale) => {
      const p = msgs[locale].admin.extensions;
      const m = msgs[locale].extensions;
      listRoutes([plugin(), plugin({ name: "core-ext", scope: "all", builtin: true })]);
      await renderRouteWithCache("/admin/extensions", lastStubRoutes(), { locale });
      expect(tableRow("core-ext").textContent).toContain(p.builtin);
      const user = userEvent.setup();
      await user.click(screen.getByText("demo", { selector: ".cb-cell-title-name" }));
      const sheet = await screen.findByRole("dialog", { name: "demo" });
      expect(tableRow("demo").getAttribute("aria-current")).toBe("true");
      // Its page opens from the Sheet's head
      expect(
        within(sheet)
          .getAllByRole("link")
          .some((l) => l.getAttribute("href") === "/admin/extensions/demo"),
      ).toBe(true);
      expect(within(sheet).getByText(m.stateTitle, { selector: "dt" })).toBeTruthy();
      expect(within(sheet).getAllByText(p.detail.replicasTitle).length).toBeGreaterThan(0);
      expect(within(sheet).getByRole("button", { name: p.detail.actions.disable })).toBeTruthy();
      expect(
        within(sheet).getByRole("link", { name: p.detail.actions.upgrade }).getAttribute("href"),
      ).toBe("/admin/plugins/import");
      // Folded until opened
      const summary = within(sheet).getByRole("button", { expanded: false });
      expect(summary.textContent).toContain(`${m.category.tools} 1`);
      expect(summary.textContent).toContain(m.sensitive);
      expect(within(sheet).queryByText(p.approve.notApproved)).toBeNull();
      await user.click(summary);
      expect(
        within(sheet).getByRole("region", { name: m.permissionsLabel.replace("{plugin}", "demo") }),
      ).toBeTruthy();
      // One box (acceptance item AB): the Sheet holds rows and lines, never a card
      expect(sheet.querySelector('[data-part="card"]')).toBeNull();
      expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
    },
  );

  it("in the Sheet the failed replicas are the fail line, not the tinted callout (spec §6.19)", async () => {
    const split = plugin({
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
    listRoutes([split]);
    await renderRouteWithCache("/admin/extensions", lastStubRoutes());
    const user = userEvent.setup();
    await user.click(screen.getByText("demo", { selector: ".cb-cell-title-name" }));
    const sheet = await screen.findByRole("dialog", { name: "demo" });
    const p = en.admin.extensions;
    const line = within(sheet).getByText(
      fill(p.detail.failedReplica, {
        replica: "web-2-222-bbbbbb",
        reason: p.detail.replicaReason.setup_failed,
      }),
    );
    const callout = line.closest('[data-part="callout"]') as HTMLElement;
    expect(callout.getAttribute("data-framed")).toBe("false");
    expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
  });

  it("the config in the Sheet: a nested object is a subsection, the Sheet the one box (acceptance item AB)", async () => {
    stubApi({
      "GET /api/v1/admin/extensions": () => json(200, { extensions: [plugin()], drainSeconds: 30 }),
      "GET /api/v1/admin/extensions/demo/config": () =>
        json(200, {
          plugin: "demo",
          version: "1.0.0",
          configurable: true,
          schema: {
            type: "object",
            properties: {
              region: { type: "string" },
              limits: { type: "object", properties: { burst: { type: "integer" } } },
            },
          },
          fields: [
            {
              path: "region",
              secret: false,
              hot: false,
              source: "db",
              readonly: false,
              value: "eu",
            },
            { path: "limits.burst", secret: false, hot: false, source: "unset", readonly: false },
          ],
          valid: true,
          validated: true,
          issues: [],
        }),
    });
    await renderRouteWithCache("/admin/extensions", lastStubRoutes());
    const user = userEvent.setup();
    await user.click(screen.getByText("demo", { selector: ".cb-cell-title-name" }));
    const sheet = await screen.findByRole("dialog", { name: "demo" });
    const limits = await within(sheet).findByRole("region", { name: "limits" });
    expect(limits.getAttribute("data-part")).toBe("subsection");
    expect(within(limits).getByLabelText(/^burst/)).toBeTruthy();
    expect(sheet.querySelector('[data-part="card"]')).toBeNull();
    expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
  });

  it("an approval waiting: the permissions open by themselves in the Sheet; approving POSTs", async () => {
    const pending = plugin({
      status: "pending_approval",
      snapshot: null,
      ...addedOf(["echo"], { echo: "tools" }),
    });
    const calls = stubApi({
      "GET /api/v1/admin/extensions": () => json(200, { extensions: [pending], drainSeconds: 30 }),
      "GET /api/v1/admin/extensions/demo/config": () =>
        json(200, {
          plugin: "demo",
          version: "1.0.0",
          configurable: false,
          schema: null,
          fields: [],
          valid: true,
          validated: true,
          issues: [],
        }),
      "POST /api/v1/admin/extensions/demo/approve": () => json(200, plugin({ status: "enabled" })),
    });
    await renderRouteWithCache("/admin/extensions", lastStubRoutes());
    const user = userEvent.setup();
    await user.click(screen.getByText("demo", { selector: ".cb-cell-title-name" }));
    const sheet = await screen.findByRole("dialog", { name: "demo" });
    expect(within(sheet).getByText(en.admin.extensions.approve.notApproved)).toBeTruthy();
    // the approval is a subsection in the Sheet, not an accent card
    const approval = within(sheet).getByRole("region", { name: en.admin.extensions.approve.title });
    expect(approval.getAttribute("data-part")).toBe("subsection");
    expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
    const submit = within(sheet).getByRole("button", { name: en.admin.extensions.approve.submit });
    expect(submit).toHaveProperty("disabled", true);
    await user.click(
      within(sheet).getByRole("checkbox", { name: en.admin.extensions.approve.ack }),
    );
    await user.click(submit);
    await vi.waitFor(() =>
      expect(bodyOf(calls.find((c) => c.method === "POST"))).toEqual({
        sha256: SHA,
        reviewHash: "0123456789abcdef",
      }),
    );
    // The answer replaces the row: it no longer needs attention
    expect(
      await within(tableRow("demo")).findByText(en.admin.extensions.status.enabled),
    ).toBeTruthy();
  });

  it("one extension needs attention: the callout's action opens its Sheet", async () => {
    listRoutes([plugin(), S3]);
    await renderRouteWithCache("/admin/extensions", lastStubRoutes(), { locale: "zh" });
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: zh.admin.extensions.calloutFix }));
    expect(await screen.findByRole("dialog", { name: "object-store-s3" })).toBeTruthy();
  });

  it("row menu: 升级 for an installed extension; no menu for one from the startup config", async () => {
    const p = msgs.zh.admin.extensions;
    listRoutes([plugin(), plugin({ name: "cfg", source: "config", installSource: null })]);
    await renderRouteWithCache("/admin/extensions", lastStubRoutes(), { locale: "zh" });
    const user = userEvent.setup();
    expect(within(tableRow("cfg")).queryByRole("button", { name: "行操作" })).toBeNull();
    await user.click(within(tableRow("demo")).getByRole("button", { name: "行操作" }));
    expect((await screen.findByRole("menuitem", { name: p.upgrade })).getAttribute("href")).toBe(
      "/admin/plugins/import",
    );
    // The menu does not open the Sheet
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("zh copy is exactly the accepted wording", () => {
    expect(zh.admin.extensions.description).toBe(
      "插件里在部署上运行的代码。部署级配置、权限和运行状态在这里。",
    );
    expect(zh.admin.extensions.meta.orgs.replace("{n}", "3")).toBe("3 个组织启用");
  });

  it("nothing needs attention: no callout; the description is shown", async () => {
    listRoutes([plugin(), plugin({ name: "other" })]);
    await renderRouteWithCache("/admin/extensions", lastStubRoutes());
    await screen.findByRole("table", { name: en.admin.extensions.title });
    expect(document.querySelector(".cb-callout")).toBeNull();
    expect(screen.getByText(en.admin.extensions.description)).toBeTruthy();
    expect(document.querySelector('a[href="/admin/extensions/install"]')).toBeNull();
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
      await renderRouteWithCache(detailPage(), lastStubRoutes(), { locale });
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
      expect(upgrade.getAttribute("href")).toBe("/admin/plugins/import");
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
    await renderRouteWithCache(detailPage(), lastStubRoutes());
    const p = en.admin.extensions;
    expect(await screen.findByText(p.source.bootstrap)).toBeTruthy();
    expect(screen.queryByText(p.detail.requiredNote)).toBeNull();
    expect(screen.getByRole("button", { name: p.detail.actions.enable })).toBeTruthy();
    expect(screen.getByRole("button", { name: p.detail.actions.uninstall })).toBeTruthy();
  });

  it("配置声明的插件：同样没有生命周期按钮，并说明要改启动配置", async () => {
    detailRoutes(plugin({ source: "config", sha256: null, desired: null, removable: false }));
    await renderRouteWithCache(detailPage(), lastStubRoutes());
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
      await renderRouteWithCache(detailPage(), lastStubRoutes(), { locale });
      const p = msgs[locale].admin.extensions;
      const reason = p.detail.replicaReason.setup_failed;
      const alert = await screen.findByText(
        fill(p.detail.failedReplica, { replica: "web-2-222-bbbbbb", reason }),
      );
      expect(alert).toBeTruthy();
      // On the extension's page (no box around it) the failures are the tinted fail callout
      const callout = alert.closest('[data-part="callout"]') as HTMLElement;
      expect(callout.getAttribute("data-tone")).toBe("fail");
      expect(callout.hasAttribute("data-framed")).toBe(false);
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
    await renderRouteWithCache(detailPage(), lastStubRoutes());
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
    await renderRouteWithCache(detailPage(), lastStubRoutes());
    const p = en.admin.extensions;
    await screen.findByText(p.detail.uninstallNeedsDisable);
    expect(screen.queryByRole("button", { name: p.detail.actions.uninstall })).toBeNull();
    expect(screen.getByRole("link", { name: p.detail.actions.upgrade }).getAttribute("href")).toBe(
      "/admin/plugins/import",
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
    await renderRouteWithCache(detailPage(), lastStubRoutes(), { locale: "zh" });
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
    // the refresh reads the list again (in the browser: the cache's entry is invalidated)
    const lists = () => calls.filter((c) => c.url === "/api/v1/admin/extensions").length;
    const before = lists();
    await user.click(screen.getByRole("button", { name: p.approve.refresh }));
    await vi.waitFor(() => expect(lists()).toBeGreaterThan(before));
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
    await renderRouteWithCache(detailPage(), lastStubRoutes());
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
    await renderRouteWithCache(detailPage(), lastStubRoutes(), { locale: "zh" });
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

  it("converging: the budget is 20 real polls, 3 s apart (the list entry it starts from is none)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let polls = 0;
      detailRoutes(plugin({ status: "converging" }), {
        "GET /api/v1/admin/extensions/demo": () => {
          polls++;
          return json(200, plugin({ status: "converging" }));
        },
      });
      await renderRouteWithCache(detailPage(), lastStubRoutes());
      expect(await screen.findByText(en.admin.extensions.detail.converging)).toBeTruthy();
      // nothing read before the first period
      await vi.advanceTimersByTimeAsync(2900);
      expect(polls).toBe(0);
      for (let i = 0; i < 25; i++) await vi.advanceTimersByTimeAsync(3000);
      expect(polls).toBe(20);
      await vi.advanceTimersByTimeAsync(9000);
      expect(polls).toBe(20);
    } finally {
      vi.useRealTimers();
    }
  });

  it("converging after an action: its answer is no poll, the budget is still 20 real reads", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let polls = 0;
      const converging = plugin({
        status: "converging",
        desired: { version: "1.0.0", sha256: SHA, state: "disabled" },
      });
      detailRoutes(plugin(), {
        "POST /api/v1/admin/extensions/demo/disable": () => json(200, converging),
        "GET /api/v1/admin/extensions/demo": () => {
          polls++;
          return json(200, converging);
        },
      });
      await renderRouteWithCache(detailPage(), lastStubRoutes());
      const p = en.admin.extensions;
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await user.click(await screen.findByRole("button", { name: p.detail.actions.disable }));
      const dialog = await screen.findByRole("dialog");
      await user.click(
        within(dialog).getByRole("button", { name: p.detail.disableConfirm.confirm }),
      );
      expect(await screen.findByText(p.detail.converging)).toBeTruthy();
      for (let i = 0; i < 26; i++) await vi.advanceTimersByTimeAsync(3000);
      expect(polls).toBe(20);
    } finally {
      vi.useRealTimers();
    }
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
      await renderRouteWithCache(detailPage(), lastStubRoutes());
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
      await renderRouteWithCache(detailPage(), lastStubRoutes(), { locale });
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

  it("replacing a set secret: the identical view back still resets the form (not dirty, input empty)", async () => {
    const p = en.admin.extensions;
    // a plain secret already set: saving a new value returns the same view as before
    const view = {
      plugin: "demo",
      version: "1.0.0",
      configurable: true,
      schema: { type: "object", properties: { token: { type: "string", "x-secret": true } } },
      fields: [
        { path: "token", secret: true, hot: false, source: "db", readonly: false, set: true },
      ],
      valid: true,
      validated: true,
      issues: [],
    };
    const calls = detailRoutes(plugin(), {
      "GET /api/v1/admin/extensions/demo/config": () => json(200, view),
      "PUT /api/v1/admin/extensions/demo/config": () => json(200, view),
    });
    await renderRouteWithCache(detailPage(), lastStubRoutes(), { locale: "en" });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: p.detail.tabs.config }));
    const sf = en.configForm;
    await user.click(
      await screen.findByRole("button", { name: fill(sf.replaceLabel, { field: "token" }) }),
    );
    await user.type(screen.getByLabelText("token"), "sk-new");
    const save = screen.getByRole("button", { name: p.config.save }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    await user.click(save);
    await vi.waitFor(() => expect(calls.filter((c) => c.method === "PUT").length).toBe(1));
    expect(bodyOf(calls.find((c) => c.method === "PUT"))).toEqual({ values: { token: "sk-new" } });
    await vi.waitFor(() =>
      expect((screen.getByLabelText("token") as HTMLInputElement).value).toBe(""),
    );
    expect(
      (screen.getByRole("button", { name: p.config.save }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText(p.config.noChanges)).toBeTruthy();
    // back to "set, keep": Replace is offered again
    expect(
      screen.getByRole("button", { name: fill(sf.replaceLabel, { field: "token" }) }),
    ).toBeTruthy();
  });

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
    await renderRouteWithCache(detailPage(), lastStubRoutes(), { locale: "en" });
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
