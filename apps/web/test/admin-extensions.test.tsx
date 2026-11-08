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
      // 状态's first line is the state itself, no 状态 key repeating the heading
      expect(within(sheet).queryByText(m.stateTitle, { selector: "dt" })).toBeNull();
      const stateRegion = within(sheet).getByRole("region", { name: p.detail.sections.status });
      expect(
        stateRegion.querySelector('[data-part="subsection-body"]')?.firstElementChild?.textContent,
      ).toContain(p.status.enabled);
      // The regions (spec §6.7): no deployment config here, so 状态, 副本, 权限
      expect(
        within(sheet)
          .getAllByRole("heading", { level: 3 })
          .map((h) => h.textContent),
      ).toEqual([
        p.detail.sections.status,
        p.detail.sections.replicas,
        p.detail.sections.permissions,
      ]);
      const replicas = within(sheet).getByRole("table", { name: p.detail.replicasTitle });
      // every replica runs the extension's version: no 版本 column; the heartbeat is relative
      expect(
        within(replicas)
          .getAllByRole("columnheader")
          .map((h) => h.textContent),
      ).toEqual([
        p.detail.replicaColumns.replica,
        p.detail.replicaColumns.state,
        p.detail.replicaColumns.reason,
        p.detail.replicaColumns.heartbeat,
      ]);
      expect(within(sheet).getByRole("button", { name: p.detail.actions.disable })).toBeTruthy();
      expect(
        within(sheet).getByRole("link", { name: p.detail.actions.upgrade }).getAttribute("href"),
      ).toBe("/admin/plugins/import");
      // Folded until opened
      const summary = within(sheet).getByRole("button", { expanded: false });
      expect(summary.textContent).toContain(`${m.category.tools} 1`);
      // under the 权限 heading the line does not say 权限 again
      expect(summary.textContent?.startsWith(m.permissions)).toBe(false);
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

  it.each(LOCALES)(
    "the Sheet of a pending required plugin: one notice, regions in order, one facts block, save in the footer (%s)",
    async (locale) => {
      const p = msgs[locale].admin.extensions;
      const m = msgs[locale].extensions;
      const cf = msgs[locale].configForm;
      const view = plugin({
        name: "openai-compatible",
        displayName: { zh: "OpenAI Compatible", en: "OpenAI Compatible" },
        installSource: "bootstrap",
        required: true,
        status: "pending_config",
        configValid: false,
        replicas: [
          {
            replicaId: "web-1-111-aaaaaa",
            version: "1.0.0",
            state: "pending",
            reason: "config",
            detail: null,
            heartbeatAt: HEARTBEAT,
          },
        ],
      });
      const calls = stubApi({
        "GET /api/v1/admin/extensions": () => json(200, { extensions: [view], drainSeconds: 30 }),
        "GET /api/v1/admin/extensions/openai-compatible/config": () =>
          json(200, {
            plugin: "openai-compatible",
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
              },
              required: ["endpoints"],
            },
            fields: [
              { path: "endpoints", secret: false, hot: false, source: "unset", readonly: false },
            ],
            valid: false,
            validated: true,
            issues: [{ path: "endpoints", segments: ["endpoints"], message: "expected array" }],
          }),
        "PUT /api/v1/admin/extensions/openai-compatible/config": () =>
          json(400, {
            error: {
              code: "extension.config_invalid",
              message: "invalid",
              details: [
                {
                  path: "endpoints.0.baseUrl",
                  segments: ["endpoints", 0, "baseUrl"],
                  message: "invalid url",
                },
              ],
            },
          }),
      });
      await renderRouteWithCache("/admin/extensions", lastStubRoutes(), { locale });
      const user = userEvent.setup();
      await user.click(
        await screen.findByText("OpenAI Compatible", { selector: ".cb-cell-title-name" }),
      );
      const sheet = await screen.findByRole("dialog", { name: "OpenAI Compatible" });
      await within(sheet).findByRole("group", { name: "endpoints" });
      // 1. one warn line naming what is missing; no red line, no field error on the pristine form
      const notice = within(sheet).getByText(
        fill(p.config.pendingMissing, { fields: "endpoints" }),
      );
      expect(notice.closest('[data-part="callout"]')?.getAttribute("data-tone")).toBe("warn");
      expect(sheet.querySelectorAll('[data-part="callout"]')).toHaveLength(1);
      expect(within(sheet).queryByText(p.config.invalid)).toBeNull();
      expect(within(sheet).queryByText("expected array")).toBeNull();
      expect(within(sheet).queryByText(cf.errors.addOne)).toBeNull();
      // 3. no read-only field: no read-only hint
      expect(within(sheet).queryByText(p.config.hint)).toBeNull();
      // the regions in order
      expect(
        within(sheet)
          .getAllByRole("heading", { level: 3 })
          .map((h) => h.textContent),
      ).toEqual([
        p.detail.sections.config,
        p.detail.sections.status,
        p.detail.sections.replicas,
        p.detail.sections.permissions,
      ]);
      // 5. one facts block in one key column: no 标识 (the meta), 期望状态 only when it differs
      const keys = [...sheet.querySelectorAll("dt")].map((d) => d.textContent);
      expect(keys).toEqual([
        m.capabilitiesTitle,
        p.detail.fields.source,
        p.detail.fields.version,
        p.detail.fields.sha,
      ]);
      expect(within(sheet).getByText(SHA.slice(0, 16))).toBeTruthy();
      // 6. the required note is one line; 7. 升级 is neutral
      expect(within(sheet).getByText(p.detail.requiredNote)).toBeTruthy();
      expect(
        within(sheet)
          .getByRole("link", { name: p.detail.actions.upgrade })
          .getAttribute("data-variant"),
      ).toBe("default");
      // 8. the replica's state in the list's words, its reason whole (a wrap cell)
      const replicas = within(sheet).getByRole("table", { name: p.detail.replicasTitle });
      expect(within(replicas).getByText(p.status.pending_config)).toBeTruthy();
      const reason = within(replicas).getByText(p.detail.replicaReason.config);
      expect(reason.closest("[data-wrap]")?.getAttribute("data-wrap")).toBe("true");
      // 4. the save is in the footer, enabled only with changes; no "no changes" text
      const foot = sheet.querySelector(".cb-sheet-foot") as HTMLElement;
      const save = within(foot).getByRole("button", { name: p.config.save }) as HTMLButtonElement;
      expect(save.getAttribute("data-variant")).toBe("primary");
      expect(save.disabled).toBe(true);
      expect(within(sheet).queryAllByRole("button", { name: p.config.save })).toHaveLength(1);
      // nothing stored here: nothing to clear
      expect(within(sheet).queryByRole("button", { name: p.config.clear })).toBeNull();
      const list = within(sheet).getByRole("group", { name: "endpoints" });
      await user.click(within(list).getByRole("button", { name: new RegExp(cf.add) }));
      await user.type(within(list).getByLabelText(/^name/), "vllm");
      await user.type(within(list).getByLabelText(/^baseUrl/), "nope");
      expect(save.disabled).toBe(false);
      // what saving does is one quiet line beside the save, not a sentence in the form
      const note = [p.config.appliesNow, p.config.willReload.split("{")[0] as string];
      expect(note.some((n) => foot.textContent?.includes(n))).toBe(true);
      // 2. a failed save: the field says it in the page's words, never the kernel's text
      await user.click(save);
      await vi.waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
      expect(await within(sheet).findByText(cf.errors.invalid)).toBeTruthy();
      expect(within(sheet).queryByText("invalid url")).toBeNull();
      expect(within(sheet).getByText(p.config.saveInvalid)).toBeTruthy();
    },
  );

  it.each(LOCALES)(
    "the Sheet's 清空配置: only with a stored config; asks with the name, DELETEs, the view replaced (%s)",
    async (locale) => {
      const p = msgs[locale].admin.extensions;
      const view = plugin({ name: "openai-compatible", displayName: null });
      const schema = {
        type: "object",
        properties: { baseUrl: { type: "string" }, region: { type: "string" } },
        required: ["baseUrl"],
      };
      const configView = (stored: boolean) => ({
        plugin: "openai-compatible",
        version: "1.0.0",
        configurable: true,
        schema,
        fields: [
          stored
            ? {
                path: "baseUrl",
                secret: false,
                hot: false,
                source: "db",
                readonly: false,
                value: "https://a.example",
              }
            : { path: "baseUrl", secret: false, hot: false, source: "unset", readonly: false },
          {
            path: "region",
            secret: false,
            hot: false,
            source: "env",
            readonly: true,
            value: "eu",
          },
        ],
        valid: stored,
        validated: true,
        issues: stored
          ? []
          : [{ path: "baseUrl", segments: ["baseUrl"], message: "expected string" }],
        orgMustConfigure: [],
      });
      const calls = stubApi({
        "GET /api/v1/admin/extensions": () => json(200, { extensions: [view], drainSeconds: 30 }),
        "GET /api/v1/admin/extensions/openai-compatible/config": () =>
          json(200, configView(!calls.some((c) => c.method === "DELETE"))),
        "DELETE /api/v1/admin/extensions/openai-compatible/config": () =>
          json(200, configView(false)),
      });
      await renderRouteWithCache("/admin/extensions", lastStubRoutes(), { locale });
      const user = userEvent.setup();
      await user.click(
        await screen.findByText("openai-compatible", { selector: ".cb-cell-title-name" }),
      );
      const sheet = await screen.findByRole("dialog", { name: "openai-compatible" });
      const foot = sheet.querySelector(".cb-sheet-foot") as HTMLElement;
      const clear = await within(foot).findByRole("button", { name: p.config.clear });
      // a secondary action beside the save, never the primary
      expect(clear.getAttribute("data-variant")).toBe("default");
      await user.click(clear);
      const dialog = await screen.findByRole("dialog", {
        name: fill(p.config.clearConfirm.title, { name: "openai-compatible" }),
      });
      expect(within(dialog).getByText(p.config.clearConfirm.hint)).toBeTruthy();
      const confirm = within(dialog).getByRole("button", { name: p.config.clearConfirm.confirm });
      expect(confirm).toHaveProperty("disabled", true);
      await user.type(within(dialog).getByRole("textbox"), "openai-compatible");
      await user.click(confirm);
      await vi.waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
      expect(await screen.findByText(p.config.cleared)).toBeTruthy();
      // the answer replaces the cached view: nothing stored, so no clear action any more
      await vi.waitFor(() =>
        expect(within(foot).queryByRole("button", { name: p.config.clear })).toBeNull(),
      );
      expect(screen.queryByRole("dialog", { name: /openai-compatible.*/ })).toBeTruthy();
      // the list is read again after the clear (the page's prefetch read it before)
      await vi.waitFor(() => {
        const after = calls.slice(calls.findIndex((c) => c.method === "DELETE"));
        expect(
          after.some(
            (c) => c.method === "GET" && c.url.split("?")[0] === "/api/v1/admin/extensions",
          ),
        ).toBe(true);
      });
    },
  );

  it.each(LOCALES)(
    "a single-provider conflict reads 冲突 (not 依赖缺失) and the Sheet names the provider to disable (%s)",
    async (locale) => {
      const p = msgs[locale].admin.extensions;
      const docker = plugin({
        name: "sandbox-docker",
        displayName: { zh: "Docker 沙箱", en: "Docker sandbox" },
        permissions: [group("provides", ["sandbox@2"])],
      });
      const e2b = plugin({
        name: "sandbox-e2b",
        displayName: { zh: "E2B 沙箱", en: "E2B sandbox" },
        status: "conflict",
        permissions: [group("provides", ["sandbox@2"])],
        replicas: [
          {
            replicaId: "web-1-111-aaaaaa",
            version: "1.0.0",
            state: "pending",
            reason: "conflict",
            detail:
              "extension point sandbox@2 is single-provider but provided by: sandbox-docker, sandbox-e2b",
            heartbeatAt: HEARTBEAT,
          },
        ],
        conflict: {
          extensionPoint: "sandbox@2",
          providers: [
            { name: "sandbox-docker", displayName: { zh: "Docker 沙箱", en: "Docker sandbox" } },
          ],
        },
      });
      listRoutes([docker, e2b]);
      await renderRouteWithCache("/admin/extensions", lastStubRoutes(), { locale });
      const row = tableRow(locale === "zh" ? "E2B 沙箱" : "E2B sandbox");
      expect(within(row).getByText(p.status.conflict)).toBeTruthy();
      expect(within(row).queryByText(p.status.dependency)).toBeNull();
      const user = userEvent.setup();
      await user.click(
        screen.getByText(locale === "zh" ? "E2B 沙箱" : "E2B sandbox", {
          selector: ".cb-cell-title-name",
        }),
      );
      const sheet = await screen.findByRole("dialog");
      const line = fill(p.detail.conflictLine, {
        point: msgs[locale].extensions.capability.sandbox,
        others: locale === "zh" ? "Docker 沙箱" : "Docker sandbox",
        name: locale === "zh" ? "E2B 沙箱" : "E2B sandbox",
      });
      expect(within(sheet).getByText(line)).toBeTruthy();
      if (locale === "zh") {
        expect(p.status.conflict).toBe("冲突");
        expect(line).toBe(
          "沙箱只能启用一个提供方：Docker 沙箱已启用，先停用它，E2B 沙箱就会加载。",
        );
      }
      expect(within(sheet).getAllByText(p.detail.replicaReason.conflict).length).toBeGreaterThan(0);
      expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
    },
  );

  it.each(LOCALES)(
    "a second sandbox while another is enabled: 启用 is off, the line names the one to disable first and links to it (%s)",
    async (locale) => {
      const p = msgs[locale].admin.extensions;
      const docker = plugin({
        name: "sandbox-docker",
        displayName: { zh: "Docker 沙箱", en: "Docker sandbox" },
        permissions: [group("provides", ["sandbox@2"])],
      });
      const e2b = plugin({
        name: "sandbox-e2b",
        displayName: { zh: "E2B 沙箱", en: "E2B sandbox" },
        status: "disabled",
        desired: { version: "1.0.0", sha256: SHA, state: "disabled" },
        replicas: [],
        permissions: [group("provides", ["sandbox@2"])],
        enableBlocked: {
          extensionPoint: "sandbox@2",
          enabled: {
            name: "sandbox-docker",
            displayName: { zh: "Docker 沙箱", en: "Docker sandbox" },
          },
        },
      });
      const calls = listRoutes([docker, e2b]);
      await renderRouteWithCache("/admin/extensions", lastStubRoutes(), { locale });
      const user = userEvent.setup();
      await user.click(
        screen.getByText(locale === "zh" ? "E2B 沙箱" : "E2B sandbox", {
          selector: ".cb-cell-title-name",
        }),
      );
      const sheet = await screen.findByRole("dialog");
      const line = fill(p.detail.enableBlocked, {
        point: msgs[locale].extensions.capability.sandbox,
        other: locale === "zh" ? "Docker 沙箱" : "Docker sandbox",
        name: locale === "zh" ? "E2B 沙箱" : "E2B sandbox",
      });
      if (locale === "zh") {
        expect(line).toBe("沙箱只能启用一个提供方：请先停用 Docker 沙箱，再启用 E2B 沙箱。");
      }
      expect(within(sheet).getByText(line)).toBeTruthy();
      const enable = within(sheet).getByRole("button", { name: p.detail.actions.enable });
      expect((enable as HTMLButtonElement).disabled).toBe(true);
      await user.click(enable);
      expect(calls.some((c) => c.method === "POST")).toBe(false);
      const link = within(sheet).getByRole("link", {
        name: fill(p.detail.openOther, {
          name: locale === "zh" ? "Docker 沙箱" : "Docker sandbox",
        }),
      });
      expect(link.getAttribute("href")).toBe("/admin/extensions/sandbox-docker");
      expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
    },
  );

  it("an enable the kernel refuses for a single-provider point shows the actionable line, not a raw error", async () => {
    const disabled = plugin({
      status: "disabled",
      desired: { version: "1.0.0", sha256: SHA, state: "disabled" },
      replicas: [],
      permissions: [group("provides", ["sandbox@2"])],
    });
    detailRoutes(disabled, {
      "POST /api/v1/admin/extensions/demo/enable": () =>
        json(409, {
          error: {
            code: "extension.single_provider_enabled",
            message:
              "Only one extension may provide sandbox@2; disable Other sandbox first, then enable demo",
            details: [
              {
                extensionPoint: "sandbox@2",
                enabled: {
                  name: "other-sbx",
                  displayName: { zh: "别的沙箱", en: "Other sandbox" },
                },
              },
            ],
          },
        }),
    });
    await renderRouteWithCache(detailPage(), lastStubRoutes());
    const p = en.admin.extensions;
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: p.detail.actions.enable }));
    const line = fill(p.detail.enableBlocked, {
      point: en.extensions.capability.sandbox,
      other: "Other sandbox",
      name: "demo",
    });
    expect(await screen.findByText(line)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: p.detail.actions.enable }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      screen
        .getByRole("link", { name: fill(p.detail.openOther, { name: "Other sandbox" }) })
        .getAttribute("href"),
    ).toBe("/admin/extensions/other-sbx");
  });

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
      // 升级 is a neutral button (the accent is the save's), never a browser-default blue link
      expect(upgrade.getAttribute("data-variant")).toBe("default");
      expect(upgrade.className).toContain("cb-btn");
      // One quiet line, no trailing period
      expect(p.detail.requiredNote).toBe(
        locale === "zh"
          ? "必需插件 · 不能停用或卸载"
          : "Required plugin · cannot be disabled or uninstalled",
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
      // the raw text is one click away, never inline
      expect(screen.queryByText(/connect ECONNREFUSED/)).toBeNull();
      await userEvent.setup().click(screen.getByRole("button", { name: p.detail.rawDetail }));
      expect(screen.getByText("connect ECONNREFUSED")).toBeTruthy();
      const serving = fill(p.detail.stillServing, { version: "v1.0.0" });
      expect(screen.getAllByText(serving).length).toBeGreaterThan(0);
      const replicas = screen.getByRole("table", { name: p.detail.replicasTitle });
      expect(within(replicas).getByText("web-1-111-aaaaaa")).toBeTruthy();
      expect(within(replicas).getByText("web-2-222-bbbbbb")).toBeTruthy();
      // the reason column: the localized reason only; 副本 / 版本 / 状态 / 心跳 fit their content
      expect(within(replicas).getByText(reason)).toBeTruthy();
      expect(within(replicas).queryByText(/ECONNREFUSED/)).toBeNull();
      expect(within(replicas).queryByText(/setup_failed/)).toBeNull();
      const heads = within(replicas).getAllByRole("columnheader");
      expect(heads.map((h) => h.getAttribute("data-fit"))).toEqual([
        "true",
        "true",
        "true",
        null,
        "true",
      ]);
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
    // pristine and merely pending: the notice only, no red line and no field error (never the
    // kernel's raw text)
    expect(screen.queryByText("expected array")).toBeNull();
    expect(screen.queryByText(p.config.invalid)).toBeNull();
    expect(screen.queryByText(msgs.en.configForm.errors.addOne)).toBeNull();
    // no startup-config field: no read-only hint
    expect(screen.queryByText(p.config.hint)).toBeNull();
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

describe("two-level extension config on the admin side", () => {
  const LAYERED = {
    plugin: "demo",
    version: "1.0.0",
    configurable: true,
    schema: {
      type: "object",
      properties: {
        region: { type: "string" },
        baseUrl: { type: "string" },
        internal: { type: "string" },
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
        org: "readonly",
      },
      {
        path: "baseUrl",
        secret: false,
        hot: false,
        source: "db",
        readonly: false,
        value: "https://p",
        org: "override",
      },
      { path: "internal", secret: false, hot: false, source: "db", readonly: false, value: "x" },
    ],
    valid: true,
    validated: true,
    issues: [],
    orgMustConfigure: [],
  };
  const COPIES = {
    overrides: [
      {
        orgId: "o2",
        orgName: "Globex",
        createdAt: "2026-11-05T08:00:00.000Z",
        differing: ["baseUrl"],
        secrets: [{ path: "apiKey", set: true }],
      },
    ],
  };

  it.each(LOCALES)("the config tab tags each field with the org level (%s)", async (locale) => {
    const m = msgs[locale];
    detailRoutes(plugin(), {
      "GET /api/v1/admin/extensions/demo/config": () => json(200, LAYERED),
      "GET /api/v1/admin/extensions/demo/org-overrides": () => json(200, { overrides: [] }),
    });
    await renderRouteWithCache(detailPage(), lastStubRoutes(), { locale });
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("tab", { name: m.admin.extensions.detail.tabs.config }),
    );
    await screen.findByLabelText("region");
    for (const level of ["readonly", "override", "hidden"] as const)
      expect(screen.getByText(m.configForm.level[level], { exact: false })).toBeTruthy();
  });

  it("the config tab lists the orgs that hold a copy: when, what differs, secrets by state, nothing to edit", async () => {
    const m = en.admin.extensions.orgCopies;
    detailRoutes(plugin(), {
      "GET /api/v1/admin/extensions/demo/config": () => json(200, LAYERED),
      "GET /api/v1/admin/extensions/demo/org-overrides": () => json(200, COPIES),
    });
    await renderRouteWithCache(detailPage(), lastStubRoutes(), { locale: "en" });
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("tab", { name: en.admin.extensions.detail.tabs.config }),
    );
    const list = await screen.findByRole("list", { name: m.title });
    expect(within(list).getByText("Globex")).toBeTruthy();
    expect(within(list).getByText(fill(m.differing, { fields: "baseUrl" }))).toBeTruthy();
    expect(within(list).getByText(fill(m.set, { path: "apiKey" }))).toBeTruthy();
    expect(within(list).queryByRole("button")).toBeNull();
    expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
  });

  it("no org has a copy: says so", async () => {
    detailRoutes(plugin(), {
      "GET /api/v1/admin/extensions/demo/config": () => json(200, LAYERED),
      "GET /api/v1/admin/extensions/demo/org-overrides": () => json(200, { overrides: [] }),
    });
    await renderRouteWithCache(detailPage(), lastStubRoutes(), { locale: "en" });
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("tab", { name: en.admin.extensions.detail.tabs.config }),
    );
    expect(await screen.findByText(en.admin.extensions.orgCopies.empty)).toBeTruthy();
  });

  it.each(LOCALES)(
    "an enabled extension whose orgs must configure their own reads 运行中 · 组织需各自配置 with the count; one that is off does not (%s)",
    async (locale) => {
      const p = msgs[locale].admin.extensions;
      listRoutes([
        plugin({ name: "demo", orgsNeedingConfig: 3 }),
        plugin({
          name: "quiet",
          status: "disabled",
          orgsNeedingConfig: 2,
          desired: { version: "1.0.0", sha256: SHA, state: "disabled" },
        }),
      ]);
      await renderRouteWithCache("/admin/extensions", lastStubRoutes(), { locale });
      const text = fill(p.status.runningOrgsConfigure, { count: 3 });
      expect(within(tableRow("demo")).getByText(text)).toBeTruthy();
      expect(within(tableRow("quiet")).queryByText(/\(2\)|（2）/)).toBeNull();
      expect(within(tableRow("quiet")).getByText(p.status.disabled)).toBeTruthy();
    },
  );
});
