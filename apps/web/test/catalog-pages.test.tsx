import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { defaultSlug, slugOf } from "../src/components/CatalogInstallWizard";
import {
  MARKETPLACE_ERROR_KINDS,
  MARKETPLACE_SKIP_REASONS,
  marketplaceErrorKind,
  TRANSLATION_CODE_PLACEHOLDERS,
  TRANSLATION_CODES,
  TRANSLATION_DETAIL_KEYS,
  TRANSLATION_GROUPS,
} from "../src/lib/catalog";
import type { Me } from "../src/lib/session";
import { bodyOf, json, lastStubRoutes, stubApi } from "./support/api";
import { resetNavigation, router } from "./support/navigation";
import { renderRouteEmptyCache, renderRouteWithCache } from "./support/query";
import { ME } from "./support/render";
import { expectNoFirstPaintFetch, type Routes } from "./support/server";
import { NOT_READY } from "./support/shell";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
// The admin pages take their query and params from the address (a first load of that path)
/** `/admin/catalog/import` with the address's query (a first load). */
const importPath = () => `/admin/catalog/import${window.location.search}`;
/** `/admin/marketplaces/entries` with the address's query (a first load). */
const entriesPath = () => `/admin/marketplaces/entries${window.location.search}`;
/** `/admin/catalog/<id>` (a first load). */
const adminItemPath = () => `/admin/catalog/${encodeURIComponent(params.current.itemId ?? "")}`;
const params = { current: {} as Record<string, string> };
vi.mock("next/navigation", () => ({
  useParams: () => params.current,
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

type RenderOpts = Parameters<typeof renderRouteWithCache>[2];
/** `/catalog` as a first load: the layout prefetches from the latest `stubApi` routes. */
const renderCatalog = (opts: RenderOpts = {}) =>
  renderRouteWithCache("/catalog", lastStubRoutes(), opts);
/** `/catalog/<id>` as a first load: the layout prefetches from the latest `stubApi` routes. */
const renderItem = (opts: RenderOpts = {}) =>
  renderRouteWithCache(`/catalog/${params.current.itemId ?? ""}`, lastStubRoutes(), opts);
/** `/catalog/<id>/install` as a first load: the layout prefetches from the latest `stubApi` routes. */
const renderInstall = (opts: RenderOpts = {}) =>
  renderRouteWithCache(`/catalog/${params.current.itemId ?? ""}/install`, lastStubRoutes(), opts);

const msgs = { zh, en } as const;
/** The design ErrorDetail's toggle (design i18n `errorDetail.raw`). */
const RAW_ERROR = { zh: "原始错误", en: "Raw error" } as const;
const LOCALES = ["zh", "en"] as const;
const fill = (s: string, vars: Record<string, string | number>) =>
  s.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k]));
const template = (name: string) => document.querySelector(`[data-template="${name}"]`);
/** An accessible name that starts with `label` (optional fields append "(optional)"). */
const startsWith = (label: string) => (name: string) => name.startsWith(label);

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
    name: "pdf-tools",
    publisher: "Acme",
    displayName: null,
    description: "PDF helpers",
    scope: "optional",
    builtin: false,
    disabled: false,
    latestVersion: "1.0.0",
    versions: ["1.0.0"],
    source: "file",
    updatedAt: "2026-10-22T00:00:00.000Z",
    state: "off",
    switchable: true,
    notDeployed: false,
    installed: null,
    request: null,
    ...over,
  };
}

/** Lets pending reads and effects run (a read after mount would show up in the calls). */
const settle = () => act(() => new Promise((r) => setTimeout(r, 20)));

/**
 * A client navigation to `path` with an empty cache whose `held` read answers only on `release()`:
 * the template's loading state is drawn until then.
 */
async function renderHeld(path: string, routes: Routes, held: string) {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const answer = routes[held];
  if (answer === undefined) throw new Error(`no route ${held}`);
  await renderRouteEmptyCache(path, {
    ...routes,
    [held]: async (c) => {
      await gate;
      return answer(c);
    },
  });
  return { release: () => act(async () => release()) };
}

const escapeRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

describe("/catalog: actions follow the plugin state", () => {
  it.each(LOCALES)(
    "org admins: the row action and state follow the plugin state (%s)",
    async (locale) => {
      const a = msgs[locale].catalog.org.action;
      const st = msgs[locale].catalog.org.status;
      const items = [
        orgItem({ id: "a", name: "yes-skill" }),
        orgItem({ id: "b", name: "approval", state: "not_offered" }),
        orgItem({ id: "c", name: "granted-tpl", state: "off" }),
        orgItem({ id: "d", name: "off", state: "unavailable" }),
        orgItem({ id: "e", name: "missing", notDeployed: true }),
        orgItem({
          id: "f",
          name: "done",
          installed: { pluginInstallId: "i1", version: "1.0.0", upgradeAvailable: null },
        }),
        orgItem({
          id: "g",
          name: "asked",
          state: "not_offered",
          request: { id: "r1", kind: "access", createdAt: "2026-10-22T00:00:00.000Z" },
        }),
        orgItem({
          id: "h",
          name: "old",
          installed: { pluginInstallId: "i2", version: "1.0.0", upgradeAvailable: "1.1.0" },
        }),
      ];
      stubApi({ [`GET ${ORG}/catalog`]: () => json(200, { items }) });
      await renderCatalog({ locale });
      expect(template("ListPage")).not.toBeNull();
      const list = await screen.findByRole("list", { name: msgs[locale].catalog.org.title });
      const row = (name: string) =>
        within(list)
          .getAllByRole("listitem")
          .find((r) => within(r).queryByRole("link", { name }) !== null) as HTMLElement;
      const action = (name: string, label: string) =>
        within(row(name)).getByRole("link", { name: label }).getAttribute("href");
      // Installing goes through the wizard; requests and upgrades open the detail page.
      expect(action("yes-skill", a.install)).toBe("/catalog/a/install");
      expect(action("granted-tpl", a.install)).toBe("/catalog/c/install");
      expect(action("approval", a.requestApproval)).toBe("/catalog/b");
      expect(action("old", a.upgrade)).toBe("/catalog/h");
      for (const name of ["off", "missing", "done", "asked"]) {
        // Only the name link: no action button or link.
        expect(within(row(name)).getAllByRole("link")).toHaveLength(1);
      }
      expect(within(row("off")).getByText(st.disabled)).toBeTruthy();
      expect(within(row("missing")).getByText(st.not_deployed)).toBeTruthy();
      expect(within(row("done")).getByText(fill(st.installed, { version: "v1.0.0" }))).toBeTruthy();
      expect(within(row("asked")).getByText(st.requested)).toBeTruthy();
    },
  );

  it("tabs only when installed holds something different from all", async () => {
    stubApi({
      [`GET ${ORG}/catalog`]: () =>
        json(200, {
          items: [
            orgItem({ id: "a", name: "yes-skill" }),
            orgItem({
              id: "f",
              name: "done",
              installed: { pluginInstallId: "i1", version: "1.0.0", upgradeAvailable: null },
            }),
          ],
        }),
    });
    await renderCatalog();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: /Installed/ }));
    expect(screen.queryByText("yes-skill")).toBeNull();
    expect(screen.getByText("done")).toBeTruthy();
    expect(screen.getByRole("tab", { name: /All/ }).textContent).toContain("2");
  });

  it("members: an installable item offers a request that opens the detail page", async () => {
    const a = en.catalog.org.action;
    stubApi({ [`GET ${ORG}/catalog`]: () => json(200, { items: [orgItem()] }) });
    await renderCatalog({ me: MEMBER });
    const link = await screen.findByRole("link", { name: a.request });
    expect(link.getAttribute("href")).toBe(`/catalog/${ID}`);
    expect(screen.queryByRole("link", { name: a.install })).toBeNull();
  });
});

const extension = (over: Record<string, unknown> = {}) => ({
  name: "crm",
  version: "1.0.0",
  sha256: "a".repeat(64),
  action: "install",
  deployed: false,
  currentVersion: null,
  currentSha256: null,
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
  packageName: "@acme/plugin-crm",
  publisher: "Acme",
  description: "CRM plugin",
  extension: extension(),
  connectorTemplates: [
    {
      id: "gh",
      displayName: { zh: "GitHub", en: "GitHub" },
      description: "",
      plugin: "connector-mcp",
      connector: "mcp",
      endpoint: { url: "https://mcp.example.com" },
      auth: { type: "bearer", ownership: "org" },
      editableEndpoint: ["url"],
      endpointChecked: true,
    },
  ],
  skills: [
    {
      name: "pdf-tools",
      description: "PDF helpers",
      body: "# PDF",
      path: "skills/pdf-tools",
      files: 2,
    },
  ],
  dependencies: [
    { name: "crm-core", range: "^1.0.0", resolved: "1.2.0" },
    { name: "crm-extra", range: "^2.0.0", resolved: null },
  ],
  source: { kind: "npm", ref: "@acme/plugin-crm@1.0.0" },
  provenance: { checked: false, reason: "the registry has no provenance for this version" },
  contentDigest: "d".repeat(64),
  sensitive: true,
  reviewHash: "h1",
};

describe("/admin/catalog/import (WizardPage)", () => {
  it.each(LOCALES)("the review lists agent templates with tier and tools (%s)", async (locale) => {
    const c = msgs[locale].catalog.components;
    stubApi({
      "POST /api/v1/admin/catalog/import/npm": () =>
        json(200, {
          stagingId: "st1",
          review: {
            ...REVIEW,
            agentTemplates: [
              {
                name: "reviewer",
                path: "agents/reviewer.md",
                description: "Reviews work.",
                instructions: "Review it carefully.",
                model: "fast",
                tools: ["Read", "Bash"],
              },
              {
                name: "planner",
                path: "agents/planner.md",
                description: "Plans.",
                instructions: "Plan.",
                model: "inherit",
              },
            ],
          },
        }),
    });
    await renderRouteWithCache(importPath(), lastStubRoutes(), { locale });
    const user = userEvent.setup();
    const r = msgs[locale].catalog.admin.review;
    await user.click(await screen.findByRole("radio", { name: new RegExp(`^${r.sourceNpm}`) }));
    await user.type(
      screen.getByRole("textbox", { name: msgs[locale].admin.extensions.wizard.npmPackage }),
      "@acme/plugin-crm",
    );
    await user.click(screen.getByRole("button", { name: r.fetch }));
    const agents = await screen.findByRole("region", { name: c.agentTemplates });
    const tier = msgs[locale].agents.form.subagents.tier;
    expect(within(agents).getByText(`reviewer · ${tier.fast}`)).toBeTruthy();
    expect(within(agents).getByText(fill(c.agentTools, { tools: "Read, Bash" }))).toBeTruthy();
    expect(within(agents).getByText(`planner · ${tier.inherit}`)).toBeTruthy();
    expect(within(agents).getByText(c.agentToolsInherit)).toBeTruthy();
  });

  it.each(LOCALES)(
    "one review: extension action and sensitive items, skills, templates, resolved and unresolved dependencies; confirm needs the sensitive ack and posts { reviewHash } (%s)",
    async (locale) => {
      const r = msgs[locale].catalog.admin.review;
      const c = msgs[locale].catalog.components;
      const w = msgs[locale].admin.extensions.wizard;
      const calls = stubApi({
        "POST /api/v1/admin/catalog/import/npm": () =>
          json(200, { stagingId: "st1", review: REVIEW }),
        "POST /api/v1/admin/catalog/imports/st1/confirm": () =>
          json(201, { item: { id: ID, name: "crm" }, deploy: null }),
      });
      await renderRouteWithCache(importPath(), lastStubRoutes(), { locale });
      expect(template("WizardPage")).not.toBeNull();
      const user = userEvent.setup();
      await user.click(await screen.findByRole("radio", { name: new RegExp(`^${r.sourceNpm}`) }));
      await user.type(screen.getByRole("textbox", { name: w.npmPackage }), "@acme/plugin-crm");
      await user.click(screen.getByRole("button", { name: r.fetch }));
      const ext = await screen.findByRole("region", { name: c.extension });
      expect(within(ext).getByText(fill(r.action.install, { version: "v1.0.0" }))).toBeTruthy();
      expect(within(ext).getAllByText(msgs[locale].extensions.sensitive).length).toBeGreaterThan(0);
      const skills = screen.getByRole("region", { name: c.skills });
      expect(within(skills).getByText(`pdf-tools · ${fill(c.skillFiles, { n: 2 })}`)).toBeTruthy();
      const templates = screen.getByRole("region", { name: c.templates });
      expect(within(templates).getByText(fill(r.editable, { paths: "url" }))).toBeTruthy();
      const deps = screen.getByRole("region", { name: c.dependencies });
      expect(
        within(deps).getByText(
          fill(c.dependencyResolved, { name: "crm-core", range: "^1.0.0", version: "v1.2.0" }),
        ),
      ).toBeTruthy();
      expect(
        within(deps).getByText(
          fill(c.dependencyUnresolved, { name: "crm-extra", range: "^2.0.0" }),
        ),
      ).toBeTruthy();
      // The address names the staged import (a reload comes back to this review)
      expect(router.replace).toHaveBeenCalledWith("/admin/catalog/import?staging=st1");
      await user.click(screen.getByRole("button", { name: w.next }));

      const confirm = screen.getByRole("button", { name: r.confirm }) as HTMLButtonElement;
      expect(confirm.disabled).toBe(true);
      // Confirming always installs the extension on the deployment: no choice any more
      expect(screen.getByText(r.deployOn)).toBeTruthy();
      expect(confirm.disabled).toBe(true);
      await user.click(screen.getByRole("checkbox", { name: r.ack }));
      expect(confirm.disabled).toBe(false);
      await user.click(confirm);
      await waitFor(() => expect(router.push).toHaveBeenCalledWith(`/admin/catalog/${ID}`));
      expect(bodyOf(calls.find((x) => x.url.endsWith("/confirm")))).toEqual({
        reviewHash: "h1",
      });
    },
  );

  it("?staging=<id>: shows the review prepared on another page; a plugin without an extension confirms with the review hash only", async () => {
    const r = en.catalog.admin.review;
    const review = { ...REVIEW, extension: undefined, sensitive: false, dependencies: [] };
    window.history.replaceState(null, "", "/admin/catalog/import?staging=st2");
    const calls = stubApi({
      "GET /api/v1/admin/catalog/imports/st2": () =>
        json(200, {
          stagingId: "st2",
          review,
          permissionsMismatch: { missing: ["tools", "secrets"], extra: ["storage"] },
        }),
      "POST /api/v1/admin/catalog/imports/st2/confirm": () =>
        json(201, { item: { id: ID, name: "crm" }, deploy: null }),
    });
    await renderRouteWithCache(importPath(), lastStubRoutes());
    const ext = await screen.findByRole("region", { name: en.catalog.components.extension });
    expect(within(ext).getByText(en.catalog.components.extensionNone)).toBeTruthy();
    // The marketplace's permission mismatch comes with the staged review
    expect(screen.getByText(fill(r.mismatchMissing, { keys: "tools, secrets" }))).toBeTruthy();
    expect(screen.getByText(fill(r.mismatchExtra, { keys: "storage" }))).toBeTruthy();
    // Prepared elsewhere: no way back to the source step
    expect(screen.queryByRole("button", { name: en.admin.extensions.wizard.back })).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: en.admin.extensions.wizard.next }));
    expect(screen.getByText(r.noExtension)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: r.confirm }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith(`/admin/catalog/${ID}`));
    expect(bodyOf(calls.find((x) => x.url.endsWith("/confirm")))).toEqual({
      reviewHash: "h1",
    });
  });

  it("?staging=<id> expired or confirmed: says so; starting over shows the source step", async () => {
    const r = en.catalog.admin.review;
    window.history.replaceState(null, "", "/admin/catalog/import?staging=gone");
    stubApi({
      "GET /api/v1/admin/catalog/imports/gone": () =>
        json(404, { error: { code: "plugin.staging_not_found", message: "x" } }),
    });
    await renderRouteWithCache(importPath(), lastStubRoutes());
    expect(await screen.findByText(`${en.errors.plugin.staging_not_found}`)).toBeTruthy();
    expect(screen.getByText(r.gone)).toBeTruthy();
    expect(screen.queryByRole("radio", { name: new RegExp(`^${r.sourceNpm}`) })).toBeNull();
    await userEvent.setup().click(screen.getByRole("button", { name: r.restart }));
    expect(await screen.findByRole("radio", { name: new RegExp(`^${r.sourceNpm}`) })).toBeTruthy();
    expect(screen.queryByText(r.gone)).toBeNull();
    expect(router.replace).toHaveBeenCalledWith("/admin/catalog/import");
  });

  it("a failed deploy after confirm shows the code, the message and the note, with a link to the item", async () => {
    const r = en.catalog.admin.review;
    window.history.replaceState(null, "", "/admin/catalog/import?staging=st3");
    stubApi({
      "GET /api/v1/admin/catalog/imports/st3": () =>
        json(200, {
          stagingId: "st3",
          review: { ...REVIEW, sensitive: false, extension: extension({ sensitive: false }) },
        }),
      "POST /api/v1/admin/catalog/imports/st3/confirm": () =>
        json(201, {
          item: { id: ID, name: "crm" },
          deploy: {
            name: "crm",
            action: "install",
            version: "1.0.0",
            sha256: "a".repeat(64),
            result: "failed",
            code: "extension.migration_failed",
            message: "relation exists",
            note: "snapshot_not_restored: changed meanwhile",
          },
        }),
    });
    await renderRouteWithCache(importPath(), lastStubRoutes());
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: en.admin.extensions.wizard.next }));
    await user.click(screen.getByRole("button", { name: r.confirm }));
    expect(
      await screen.findByText(
        fill(r.deployFailed, {
          name: "crm",
          version: "v1.0.0",
          code: "extension.migration_failed",
        }),
      ),
    ).toBeTruthy();
    expect(screen.getByText("relation exists")).toBeTruthy();
    expect(screen.getByText("snapshot_not_restored: changed meanwhile")).toBeTruthy();
    expect(screen.getByRole("link", { name: r.openItem }).getAttribute("href")).toBe(
      `/admin/catalog/${ID}`,
    );
    expect(router.push).not.toHaveBeenCalled();
  });

  it("the source step: card radios and the 选择文件 drop zone with the chosen file in it", async () => {
    stubApi({ "GET /api/v1/me": () => json(200, ME) });
    await renderRouteWithCache(importPath(), lastStubRoutes(), { locale: "zh" });
    const r = zh.catalog.admin.review;
    const group = await screen.findByRole("radiogroup", { name: r.sourceLabel });
    expect(group.getAttribute("data-variant")).toBe("card");
    expect(within(group).getByText(r.sourceGitHint)).toBeTruthy();
    const zone = document.querySelector('[data-part="file-picker"]') as HTMLElement;
    expect(
      within(zone).getByRole("button", { name: zh.admin.extensions.wizard.choose }),
    ).toBeTruthy();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.setup().upload(input, new File([new Uint8Array([1, 2, 3])], "todo.tgz"));
    expect(within(zone).getByText("todo.tgz")).toBeTruthy();
  });

  it("a pre-0.1.0 upload shows the legacy-format error prominently", async () => {
    stubApi({
      "GET /api/v1/me": () => json(200, ME),
      "POST /api/v1/admin/catalog/import/file": () =>
        json(422, { error: { code: "catalog.legacy_format", message: "x" } }),
    });
    await renderRouteWithCache(importPath(), lastStubRoutes());
    const user = userEvent.setup();
    await screen.findByRole("radio", {
      name: new RegExp(`^${escapeRe(en.catalog.admin.review.sourceFile)}`),
    });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, new File([new Uint8Array([1, 2, 3])], "old.tgz"));
    await user.click(screen.getByRole("button", { name: en.catalog.admin.review.fetch }));
    expect(await screen.findByText(`${en.errors.catalog.legacy_format}`)).toBeTruthy();
  });
});

describe("/catalog/[itemId]/install (WizardPage)", () => {
  it("read-only endpoint fields stay read-only, editable ones change; the body has only the changed editable fields and credentials; a dependency failure names it and says it was rolled back", async () => {
    params.current = { itemId: ID };
    const t = en.catalog.org.install;
    const detail = {
      item: orgItem({ name: "crm" }),
      hasIcon: false,
      extension: "crm",
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
      dependencies: [{ name: "crm-core", range: "^1.0.0" }],
      skills: ["skills/pdf-tools"],
    };
    const calls = stubApi({
      [`GET ${ORG}/catalog/${ID}`]: () => json(200, detail),
      [`GET ${ORG}/extensions`]: () => json(200, { extensions: [] }),
      [`POST ${ORG}/catalog/${ID}/install`]: () =>
        json(502, {
          error: {
            code: "plugin.install_failed",
            message: "x",
            details: [
              { step: "skills", code: "internal", dependency: "crm-core", rolledBack: true },
            ],
          },
        }),
    });
    await renderInstall();
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
    // The extension step: nothing to fill in (the extension has no org config here)
    expect(screen.getByText(t.extensionNone)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: t.next }));
    // Confirm lists the dependencies installed with it
    expect(screen.getByText(t.summaryDependencies)).toBeTruthy();
    expect(screen.getByText("· crm-core ^1.0.0")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: t.submit }));
    expect(
      await screen.findByText(
        `${fill(t.failed, { step: t.step.skills, code: "internal" })} ${fill(t.failedIn, { dependency: "crm-core" })}`,
      ),
    ).toBeTruthy();
    expect(bodyOf(calls.find((c) => c.method === "POST"))).toEqual({
      version: "1.0.0",
      connectors: {
        gh: {
          name: "GitHub",
          slug: "gh",
          endpoint: { url: "https://mcp.acme.internal" },
          credential: { token: "tok" },
        },
      },
    });
  });

  it("a personal static-auth template asks the installer for their own credential (required, posted) with the hint about other members (final review I2)", async () => {
    params.current = { itemId: ID };
    for (const locale of LOCALES) {
      const t = msgs[locale].catalog.org.install;
      const calls = stubApi({
        [`GET ${ORG}/catalog/${ID}`]: () =>
          json(200, {
            item: orgItem({ name: "docs" }),
            hasIcon: false,
            extension: null,
            templates: [
              {
                id: "docs",
                displayName: null,
                description: "",
                plugin: "connector-mcp",
                connector: "mcp",
                endpoint: { url: "https://mcp.example.com" },
                editableEndpoint: [],
                auth: { type: "bearer", ownership: "personal" },
                ownership: "personal",
              },
            ],
            dependencies: [],
            skills: [],
          }),
        [`GET ${ORG}/extensions`]: () => json(200, { extensions: [] }),
        [`POST ${ORG}/catalog/${ID}/install`]: () =>
          json(201, {
            installed: { itemId: ID, version: "1.0.0", pluginInstallId: "i1" },
            install: { id: "i1" },
          }),
      });
      await renderInstall({ locale });
      expect(await screen.findByText(t.personalHint)).toBeTruthy();
      const next = screen.getByRole("button", { name: t.next }) as HTMLButtonElement;
      expect(next.disabled).toBe(true);
      const user = userEvent.setup();
      await user.type(screen.getByLabelText(msgs[locale].connectors.form.tokenLabel), "mine");
      expect(next.disabled).toBe(false);
      await user.click(next);
      await user.click(screen.getByRole("button", { name: t.submit }));
      await waitFor(() => expect(router.push).toHaveBeenCalledWith("/settings/plugins"));
      expect(bodyOf(calls.find((c) => c.method === "POST"))).toEqual({
        version: "1.0.0",
        connectors: { docs: { slug: "docs", credential: { token: "mine" } } },
      });
      cleanup();
      vi.unstubAllGlobals();
    }
  });

  it("a 409 catalog.dependency_unresolved names the dependency and its range", async () => {
    params.current = { itemId: ID };
    const t = en.catalog.org.install;
    stubApi({
      [`GET ${ORG}/catalog/${ID}`]: () =>
        json(200, {
          item: orgItem({ name: "crm" }),
          hasIcon: false,
          extension: null,
          templates: [],
          dependencies: [{ name: "crm-core", range: "^1.0.0" }],
          skills: ["skills/notes"],
        }),
      [`GET ${ORG}/extensions`]: () => json(200, { extensions: [] }),
      [`POST ${ORG}/catalog/${ID}/install`]: () =>
        json(409, {
          error: {
            code: "catalog.dependency_unresolved",
            message: "x",
            details: [{ dependency: "crm-core", range: "^1.0.0" }],
          },
        }),
    });
    await renderInstall();
    expect(screen.getByText(t.summaryDependencies)).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: t.submit }));
    expect(await screen.findByText(`${en.errors.catalog.dependency_unresolved}`)).toBeTruthy();
    expect(
      screen.getByText(
        `${fill(en.catalog.components.errorDependency, { dependency: "crm-core ^1.0.0" })}`,
      ),
    ).toBeTruthy();
  });

  it("the extension's org config is sent as extensionConfig when this install enables it; success goes to the installed plugins", async () => {
    params.current = { itemId: ID };
    const t = en.catalog.org.install;
    const calls = stubApi({
      [`GET ${ORG}/readiness`]: () => json(200, { modelProvider: "ready", agents: 1 }),
      [`GET ${ORG}/catalog/${ID}`]: () =>
        json(200, {
          item: orgItem({ name: "crm" }),
          hasIcon: false,
          extension: "crm",
          templates: [],
          dependencies: [],
          skills: [],
        }),
      [`GET ${ORG}/extensions`]: () =>
        json(200, {
          extensions: [
            {
              plugin: "crm",
              displayName: { zh: "客户系统", en: "CRM Suite" },
              version: "1.0.0",
              enabled: false,
              configurable: true,
              config: null,
              secrets: [],
              permissions: [],
              orgConfigSchema: {
                type: "object",
                properties: { region: { type: "string", title: "Region" } },
                required: ["region"],
              },
            },
          ],
        }),
      [`POST ${ORG}/catalog/${ID}/install`]: () =>
        json(201, {
          installed: { itemId: ID, version: "1.0.0", pluginInstallId: "i1" },
          install: { id: "i1" },
        }),
    });
    const { client } = await renderInstall();
    // the list is cached (as after a visit to /catalog)
    client.setQueryData(["org", "o1", "catalog"], { items: [] });
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Region", { exact: false }), "eu");
    // the config card is titled with the extension's display name, not its id
    expect(screen.getByText("CRM Suite")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: t.next }));
    await user.click(screen.getByRole("button", { name: t.submit }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/settings/plugins"));
    // the install invalidates pluginChangeKeys: the cached catalog is marked stale, the shown
    // item, the org's extensions and its readiness are read again
    expect(client.getQueryState(["org", "o1", "catalog"])?.isInvalidated).toBe(true);
    await waitFor(() =>
      expect(new Set(calls.filter((c) => c.method === "GET").map((c) => c.url))).toEqual(
        new Set([`${ORG}/catalog/${ID}`, `${ORG}/extensions`, `${ORG}/readiness`]),
      ),
    );
    expect(bodyOf(calls.find((c) => c.method === "POST"))).toEqual({
      version: "1.0.0",
      extensionConfig: { region: "eu" },
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
    { kind: "extension", ref: "todo", created: false, skillVersion: null, dropped: false },
    { kind: "connector", ref: "c1", created: true, skillVersion: null, dropped: false },
    { kind: "skill", ref: "s1", created: true, skillVersion: null, dropped: false },
    { kind: "plugin", ref: "i2", created: true, skillVersion: null, dropped: false },
  ],
  upgradeAvailable: null,
  deploymentPending: false,
};
/** A dependency install `INSTALL` brought in (its `plugin` component). */
const DEP_INSTALL = { ...INSTALL, id: "i2", name: "crm-core", components: [] };

describe("/settings/plugins: installed plugins and uninstall", () => {
  it.each(LOCALES)(
    "dependency installs by plugin name; the uninstall report lists removed and kept components with reasons (%s)",
    async (locale) => {
      const a = msgs[locale].catalog.plugins;
      let gone = false;
      const calls = stubApi({
        [`GET ${ORG}/readiness`]: () => json(200, { modelProvider: "ready", agents: 1 }),
        [`GET ${ORG}/plugin-installs`]: () =>
          json(200, { installs: gone ? [] : [INSTALL, DEP_INSTALL] }),
        [`DELETE ${ORG}/plugin-installs/i1`]: () => {
          gone = true;
          return json(200, {
            removed: [
              { kind: "connector", ref: "c1" },
              { kind: "plugin", ref: "i2" },
            ],
            kept: [
              { kind: "extension", ref: "todo", reason: "pre_existing" },
              { kind: "skill", ref: "s1", reason: "used_by_agents" },
            ],
          });
        },
      });
      await renderRouteWithCache("/settings/plugins", lastStubRoutes(), { locale });
      expect(template("SettingsPage")).not.toBeNull();
      expect(
        await screen.findByText(`· ${a.componentKind.plugin} crm-core — ${a.created}`),
      ).toBeTruthy();
      expect(screen.getByText(fill(a.dependencyOf, { names: "crm" }))).toBeTruthy();
      const user = userEvent.setup();
      await user.click(
        (await screen.findAllByRole("button", { name: a.uninstall }))[0] as HTMLElement,
      );
      const dialog = await screen.findByRole("dialog");
      await user.click(within(dialog).getByRole("button", { name: a.confirm.confirm }));
      const report = await screen.findByRole("region", {
        name: fill(a.report.title, { name: "crm" }),
      });
      expect(within(report).getByText(`− ${a.componentKind.connector} c1`)).toBeTruthy();
      expect(within(report).getByText(`− ${a.componentKind.plugin} crm-core`)).toBeTruthy();
      expect(
        within(report).getByText(
          `· ${a.componentKind.extension} todo — ${a.report.reason.pre_existing}`,
        ),
      ).toBeTruthy();
      expect(
        within(report).getByText(
          `· ${a.componentKind.skill} s1 — ${a.report.reason.used_by_agents}`,
        ),
      ).toBeTruthy();
      // the uninstall invalidates what a plugin change touches: the installs and the org's
      // readiness (an extension it brought may have been a model provider) are read again
      expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
        `DELETE ${ORG}/plugin-installs/i1`,
        `GET ${ORG}/plugin-installs`,
        `GET ${ORG}/readiness`,
      ]);
      expect(await screen.findByText(a.empty)).toBeTruthy();
    },
  );

  it("仍在安装中：409 app.install_in_progress 给出友好说明", async () => {
    stubApi({
      [`GET ${ORG}/plugin-installs`]: () =>
        json(200, { installs: [{ ...INSTALL, status: "installing" }] }),
      [`DELETE ${ORG}/plugin-installs/i1`]: () =>
        json(409, { error: { code: "plugin.install_in_progress", message: "x" } }),
    });
    await renderRouteWithCache("/settings/plugins", lastStubRoutes());
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: en.catalog.plugins.cleanup }));
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: en.catalog.plugins.confirm.confirm,
      }),
    );
    expect(await screen.findByText(`${en.catalog.plugins.inProgress}`)).toBeTruthy();
  });
});

const SOURCES = {
  offline: true,
  items: [
    {
      id: "official",
      name: "Capybara official marketplace",
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

describe("/admin/marketplaces (ListPage)", () => {
  it.each(LOCALES)(
    "官方地址只读、离线模式说明；企业清单可改，显示状态与刷新（%s）",
    async (locale) => {
      const s = msgs[locale].catalog.admin.marketplaces;
      stubApi({
        "GET /api/v1/admin/marketplaces": () => json(200, SOURCES),
        "POST /api/v1/admin/marketplaces/s2/refresh": () =>
          json(200, { ...SOURCES.items[1], lastStatus: "ok", lastError: null }),
      });
      await renderRouteWithCache("/admin/marketplaces", lastStubRoutes(), { locale });
      expect(template("ListPage")).not.toBeNull();
      const tab = msgs[locale].catalog.admin.tabs;
      expect(
        screen.getByRole("link", { name: new RegExp(`^${tab.browse}`) }).getAttribute("href"),
      ).toBe("/admin/marketplaces/entries");
      expect(
        screen.getByRole("link", { name: new RegExp(`^${tab.sources}`) }).getAttribute("href"),
      ).toBe("/admin/marketplaces");
      expect(await screen.findByText(s.offline)).toBeTruthy();
      const official = screen.getByDisplayValue(
        SOURCES.items[0]?.url as string,
      ) as HTMLInputElement;
      expect(official.readOnly).toBe(true);
      const acme = screen.getByDisplayValue(SOURCES.items[1]?.url as string) as HTMLInputElement;
      expect(acme.readOnly).toBe(false);
      // A refresh error is one sentence in the reader's language; the raw text is behind a toggle
      expect(screen.getByText(s.statusValue.errors.http_status)).toBeTruthy();
      expect(screen.queryByText("HTTP 500", { exact: false })).toBeNull();
      const raw = screen.getByRole("button", { name: RAW_ERROR[locale] });
      await userEvent.setup().click(raw);
      expect(screen.getByText("HTTP 500")).toBeTruthy();
      // The status label sits above its value (no 「状态:」 squeezed beside a long line)
      expect(screen.getAllByText(s.status).length).toBeGreaterThan(0);
      expect(screen.queryByText(`${s.status}:`)).toBeNull();
      // Every marketplace's switch is labelled on screen, the official one too
      const switches = screen.getAllByRole("switch");
      expect(switches.map((x) => x.getAttribute("aria-label"))).toEqual([
        fill(s.enabledLabel, { name: s.official }),
        fill(s.enabledLabel, { name: "Acme" }),
      ]);
      expect(screen.getByText(fill(s.enabledLabel, { name: s.official }))).toBeTruthy();
      const refresh = screen.getAllByRole("button", { name: s.refresh });
      // 官方清单被配置关闭：不能刷新
      expect((refresh[0] as HTMLButtonElement).disabled).toBe(true);
      await userEvent.setup().click(refresh[1] as HTMLElement);
      expect(await screen.findByText(fill(s.refreshed, { name: "Acme" }))).toBeTruthy();
    },
  );
});

describe("marketplaces: the two tabs share one head", () => {
  const ENTRY = {
    sourceId: "s2",
    sourceName: "Acme",
    name: "cat-a",
    version: "1.0.0",
    summary: { en: "Cat A" },
    minKernel: null,
    homepage: null,
    permissions: null,
    source: { npm: { package: "@acme/cat-a", version: "1.0.0", integrity: "sha512-x" } },
    compatible: true,
    importable: true,
    adopted: null,
    newerAvailable: false,
    contentChanged: false,
  };
  const head = () => document.querySelector('[data-part="page-header"]') as HTMLElement;

  it.each(LOCALES)(
    "sources and entries: the same description, tab counts and a search (%s)",
    async (locale) => {
      const m = msgs[locale].catalog.admin;
      stubApi({
        "GET /api/v1/admin/marketplaces": () => json(200, SOURCES),
        "GET /api/v1/admin/marketplaces/entries": () => json(200, { items: [ENTRY] }),
      });
      await renderRouteWithCache("/admin/marketplaces", lastStubRoutes(), { locale });
      const sourcesHead = head();
      expect(within(sourcesHead).getByText(m.marketplaces.description)).toBeTruthy();
      // browse counts the entries of the marketplaces that are listed (the official one is off)
      const tabs = (el: HTMLElement) =>
        within(el.querySelector('[data-part="page-header-tabs"]') as HTMLElement)
          .getAllByRole("link")
          .map((a) => a.textContent);
      const counted = [`${m.tabs.browse}3`, `${m.tabs.sources}2`];
      expect(tabs(sourcesHead)).toEqual(counted);
      expect(
        within(sourcesHead).getByRole("searchbox", { name: m.marketplaces.search }),
      ).toBeTruthy();
      cleanup();

      resetNavigation("/admin/marketplaces/entries");
      await renderRouteWithCache(entriesPath(), lastStubRoutes(), { locale });
      const entriesHead = head();
      expect(within(entriesHead).getByText(m.marketplaces.description)).toBeTruthy();
      expect(tabs(entriesHead)).toEqual(counted);
      expect(within(entriesHead).getByRole("searchbox", { name: m.entries.search })).toBeTruthy();
    },
  );

  it("the sources search filters the marketplaces by name or address", async () => {
    const m = en.catalog.admin.marketplaces;
    stubApi({ "GET /api/v1/admin/marketplaces": () => json(200, SOURCES) });
    await renderRouteWithCache("/admin/marketplaces", lastStubRoutes());
    const user = userEvent.setup();
    await user.type(screen.getByRole("searchbox", { name: m.search }), "acme.com");
    expect(screen.queryByDisplayValue(SOURCES.items[0]?.url as string)).toBeNull();
    expect(screen.getByDisplayValue(SOURCES.items[1]?.url as string)).toBeTruthy();
    await user.clear(screen.getByRole("searchbox", { name: m.search }));
    await user.type(screen.getByRole("searchbox", { name: m.search }), "nothing-here");
    expect(screen.getByText(m.noMatch)).toBeTruthy();
  });

  it.each(LOCALES)("the empty entries list points to the sources tab (%s)", (locale) => {
    const m = msgs[locale].catalog.admin;
    expect(m.entries.empty).toContain(locale === "zh" ? `「${m.tabs.sources}」` : m.tabs.sources);
  });
});

describe("marketplaceErrorKind", () => {
  it("maps the kernel's refresh errors to a kind; anything else is unknown", () => {
    const git = "https://github.com/capybara-hq/plugins.git: cannot list the refs of x";
    expect(
      marketplaceErrorKind(
        `${git}: Access to github.com is refused: it resolves to a private or reserved address (add the hostname to marketplaces.allowPrivateHosts to allow an internal host).`,
      ),
    ).toBe("private_address");
    expect(marketplaceErrorKind("https://x.com/m.json: Cannot resolve x.com.")).toBe("dns");
    expect(marketplaceErrorKind(`${git}: timed out after 30 s`)).toBe("timeout");
    expect(marketplaceErrorKind("https://x/m.json: the marketplace responded with HTTP 404")).toBe(
      "http_status",
    );
    expect(
      marketplaceErrorKind("https://x/m.json: the marketplace manifest is not valid JSON"),
    ).toBe("invalid");
    expect(marketplaceErrorKind("refresh aborted")).toBe("unknown");
  });

  it.each(LOCALES)("every kind has a sentence ending with a full stop (%s)", (locale) => {
    const errors = msgs[locale].catalog.admin.marketplaces.statusValue.errors;
    for (const k of MARKETPLACE_ERROR_KINDS) {
      expect(errors[k]).toMatch(locale === "zh" ? /。$/ : /\.$/);
    }
  });
});

describe("/admin/catalog and marketplace entries", () => {
  const item = (over: Record<string, unknown>) => ({
    id: ID,
    name: "cat-a",
    publisher: "Acme",
    displayName: null,
    description: "",
    scope: "optional",
    scopeOrgs: [],
    builtin: false,
    disabled: false,
    shownToOthers: true,
    enabledOrgs: 0,
    pending: false,
    permissionsHash: null,
    latestVersion: "1.0.0",
    versions: ["1.0.0"],
    installs: 2,
    source: "marketplace",
    marketplaceId: "official",
    latestMarketplaceVersion: "2.0.0",
    newerInMarketplace: true,
    contentChanged: false,
    updatedAt: "2026-10-22T00:00:00.000Z",
    ...over,
  });
  const entry = (over: Record<string, unknown> = {}) => ({
    sourceId: "official",
    sourceName: "Official",
    name: "cat-a",
    version: "2.0.0",
    summary: { en: "Cat A" },
    minKernel: null,
    homepage: null,
    permissions: { keys: ["tools"], sensitive: ["tools"] },
    source: {
      npm: {
        package: "@acme/plugin-cat-a",
        version: "2.0.0",
        integrity: `sha512-${"a".repeat(86)}==`,
      },
    },
    compatible: true,
    importable: true,
    adopted: { itemId: ID, versions: ["1.0.0"] },
    newerAvailable: true,
    contentChanged: false,
    ...over,
  });
  const version = (v: string, manifest: Record<string, unknown> = {}) => ({
    version: v,
    source: "file",
    sourceRef: "upload",
    integrity: null,
    contentDigest: null,
    sourceDetail: null,
    manifest: {
      name: "crm",
      version: v,
      publisher: "Acme",
      description: "CRM plugin",
      ...manifest,
    },
    size: 1024,
    extensionSha256: null,
    importedAt: "2026-10-22T00:00:00.000Z",
  });

  it("list: source and “new version”, filtered by source; no kind column or filter", async () => {
    const t = en.catalog;
    stubApi({
      "GET /api/v1/admin/catalog/items": () =>
        json(200, {
          items: [
            item({}),
            item({
              id: "m",
              name: "manual-skill",
              marketplaceId: null,
              latestMarketplaceVersion: null,
              newerInMarketplace: false,
            }),
          ],
          nextOffset: null,
        }),
      "GET /api/v1/admin/marketplaces": () => json(200, SOURCES),
    });
    await renderRouteWithCache("/admin/catalog", lastStubRoutes());
    const list = await screen.findByRole("list", { name: t.admin.title });
    const row = (name: string) =>
      within(list)
        .getAllByText(new RegExp(name))
        .map((n) => n.closest("li") as HTMLElement)[0] as HTMLElement;
    expect(within(row("cat-a")).getByText(new RegExp(t.source.official))).toBeTruthy();
    expect(await within(row("cat-a")).findByText(t.newer)).toBeTruthy();
    expect(within(row("manual-skill")).getByText(new RegExp(t.source.manual))).toBeTruthy();
    expect(within(row("manual-skill")).queryByText(t.newer)).toBeNull();
    expect(screen.getByRole("link", { name: t.admin.actions.import }).getAttribute("href")).toBe(
      "/admin/catalog/import",
    );
    // No overflow menu: browsing the marketplaces is one link; the sources are the sidebar's 市场
    const head = document.querySelector('[data-part="page-header"]') as HTMLElement;
    expect(within(head).queryByRole("button", { name: "More" })).toBeNull();
    expect(
      within(head).getByRole("link", { name: t.admin.actions.entries }).getAttribute("href"),
    ).toBe("/admin/marketplaces/entries");
    expect(within(head).queryByRole("link", { name: "Marketplaces" })).toBeNull();
    // Tabs: plugins (with the count) and deployment requests, linking the two routes
    expect(template("ListPage")).not.toBeNull();
    expect(
      screen
        .getByRole("link", { name: new RegExp(`^${t.admin.tabs.requests}`) })
        .getAttribute("href"),
    ).toBe("/admin/catalog/requests");
    expect(
      screen
        .getByRole("link", { name: new RegExp(`^${t.admin.tabs.plugins}`) })
        .getAttribute("href"),
    ).toBe("/admin/catalog");
    // The search narrows by name
    await userEvent.setup().type(screen.getByRole("searchbox", { name: t.admin.search }), "manual");
    expect(within(list).queryByText(/cat-a/)).toBeNull();
  });

  it("entries: incompatible marked; a git entry on a host outside allowedHosts names the host and cannot be imported; truncation hint", async () => {
    const c = en.catalog.admin.entries;
    stubApi({
      "GET /api/v1/admin/marketplaces": () => json(200, SOURCES),
      "GET /api/v1/admin/marketplaces/entries": () =>
        json(200, {
          items: [
            entry(),
            entry({ name: "old-a", version: "3.0.0", compatible: false, adopted: null }),
            entry({
              name: "git-a",
              version: "1.0.0",
              source: { git: { url: "https://github.com/acme/git-a.git" } },
              importable: false,
              reason: "host_not_allowed",
              adopted: null,
              newerAvailable: false,
            }),
          ],
          truncated: true,
        }),
    });
    await renderRouteWithCache(entriesPath(), lastStubRoutes());
    expect(await screen.findByText(c.truncated)).toBeTruthy();
    // One title 市场/Marketplaces with the tabs Browse (active) and Sources
    expect(
      screen
        .getByRole("link", { name: new RegExp(`^${en.catalog.admin.tabs.browse}`) })
        .getAttribute("aria-current"),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: new RegExp(`^${en.catalog.admin.tabs.sources}`) })
        .getAttribute("href"),
    ).toBe("/admin/marketplaces");
    // object rows, not a table; no filter rail
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("radiogroup")).toBeNull();
    const list = screen.getByRole("list", { name: c.title });
    const row = (name: string) => within(list).getByText(name).closest("li") as HTMLElement;
    expect(
      within(row("old-a")).getByText(
        new RegExp(escapeRe(fill(c.incompatible, { version: "v3.0.0" }))),
      ),
    ).toBeTruthy();
    const git = row("git-a");
    const notAllowed = fill(c.reason.host_not_allowed, { host: "github.com" });
    expect(within(git).getByText(notAllowed)).toBeTruthy();
    expect(within(git).getByText(/https:\/\/github\.com\/acme\/git-a\.git/)).toBeTruthy();
    // nothing to import: no row action
    expect(within(git).queryByRole("button", { name: c.import })).toBeNull();
    // the reason is the row's state; a menu holding only that disabled line is not drawn
    expect(within(git).queryByRole("button", { name: "More actions" })).toBeNull();
  });

  it("entries: importing stages the plugin and opens the import review; an integrity mismatch is a prominent error", async () => {
    const c = en.catalog.admin.entries;
    let fail = true;
    const calls = stubApi({
      "GET /api/v1/admin/marketplaces": () => json(200, SOURCES),
      "GET /api/v1/admin/marketplaces/entries": () =>
        json(200, { items: [entry()], truncated: false }),
      "POST /api/v1/admin/marketplaces/official/entries/cat-a/import": () =>
        fail
          ? json(502, { error: { code: "marketplace.integrity_mismatch", message: "x" } })
          : json(200, {
              stagingId: "st9",
              review: REVIEW,
              permissionsMismatch: { missing: ["tools"], extra: [] },
            }),
    });
    await renderRouteWithCache(entriesPath(), lastStubRoutes());
    const list = await screen.findByRole("list", { name: c.title });
    const user = userEvent.setup();
    const importIt = async () => {
      await user.click(
        await within(list).findByRole("button", {
          name: fill(c.importVersion, { version: "v2.0.0" }),
        }),
      );
    };
    await importIt();
    expect(await screen.findByText(`${en.errors.marketplace.integrity_mismatch}`)).toBeTruthy();
    fail = false;
    await importIt();
    await waitFor(() =>
      expect(router.push).toHaveBeenCalledWith("/admin/catalog/import?staging=st9"),
    );
    expect(bodyOf(calls.filter((x) => x.method === "POST").at(-1))).toEqual({ version: "2.0.0" });
  });

  it("item detail: the agent templates of the latest version", async () => {
    params.current = { itemId: ID };
    const c = en.catalog.components;
    stubApi({
      [`GET /api/v1/admin/catalog/items/${ID}`]: () =>
        json(200, {
          item: { ...item({ name: "crm" }), packageName: null, deletedAt: null },
          versions: [version("1.0.0", { agents: [{ path: "./agents/reviewer.md" }] })],
          hasIcon: false,
        }),
      "GET /api/v1/admin/marketplaces": () => json(200, SOURCES),
      "GET /api/v1/admin/catalog/items": () => json(200, { items: [], nextOffset: null }),
    });
    await renderRouteWithCache(adminItemPath(), lastStubRoutes());
    const agents = await screen.findByRole("region", { name: c.agentTemplates });
    expect(within(agents).getByText("· reviewer")).toBeTruthy();
  });

  it("item detail: the four component sections of the latest version (extension with its declared permissions, skills, templates, dependencies with catalog resolution)", async () => {
    params.current = { itemId: ID };
    const c = en.catalog.components;
    stubApi({
      [`GET /api/v1/admin/catalog/items/${ID}`]: () =>
        json(200, {
          item: {
            ...item({ name: "crm", versions: ["1.0.0"], latestVersion: "1.0.0" }),
            packageName: "@acme/plugin-crm",
            deletedAt: null,
          },
          versions: [
            version("1.0.0", {
              skills: [{ path: "./skills/crm-notes" }],
              connectorTemplates: [{ path: "./connectors/docs.json" }],
              dependencies: [
                { name: "crm-core", version: "^1.0.0" },
                { name: "crm-extra", version: "^2.0.0" },
              ],
              extension: {
                entry: "./dist/index.mjs",
                manifest: {
                  name: "crm",
                  version: "1.0.0",
                  sdk: "^0.1.0-rc.0",
                  provides: [],
                  requires: [],
                  optional: [],
                  permissions: { tools: ["crm_search"], storage: true },
                  config: { deployment: [], org: [] },
                },
              },
            }),
          ],
          hasIcon: false,
        }),
      "GET /api/v1/admin/marketplaces": () => json(200, SOURCES),
      "GET /api/v1/admin/catalog/items": () =>
        json(200, {
          items: [item({ id: "core-id", name: "crm-core", versions: ["1.2.0", "1.0.0"] })],
          nextOffset: null,
        }),
    });
    await renderRouteWithCache(adminItemPath(), lastStubRoutes());
    const ext = await screen.findByRole("region", { name: c.extension });
    expect(
      within(ext).getByText(fill(c.extensionVersion, { name: "crm", version: "v1.0.0" })),
    ).toBeTruthy();
    expect(within(ext).getByText("crm_search")).toBeTruthy();
    expect(within(ext).getByText(en.extensions.category.storage)).toBeTruthy();
    expect(
      within(screen.getByRole("region", { name: c.skills })).getByText("· crm-notes"),
    ).toBeTruthy();
    expect(
      within(screen.getByRole("region", { name: c.templates })).getByText("· docs"),
    ).toBeTruthy();
    const deps = screen.getByRole("region", { name: c.dependencies });
    const found = await within(deps).findByRole("link", {
      name: fill(c.dependencyInCatalog, {
        name: "crm-core",
        range: "^1.0.0",
        versions: "1.2.0, 1.0.0",
      }),
    });
    expect(found.getAttribute("href")).toBe("/admin/catalog/core-id");
    expect(
      within(deps).getByText(
        fill(c.dependencyNotInCatalog, { name: "crm-extra", range: "^2.0.0" }),
      ),
    ).toBeTruthy();
    // A plugin with an extension can install it on the deployment
    // (the deployment install control is gone: confirming the import installs the extension)
    expect(screen.queryByRole("button", { name: en.catalog.admin.detail.deploy })).toBeNull();
  });

  it("item detail: the icon is only an <img> pointing at the kernel route, never inline", async () => {
    params.current = { itemId: ID };
    stubApi({
      [`GET /api/v1/admin/catalog/items/${ID}`]: () =>
        json(200, {
          item: { ...item({ name: "gh" }), packageName: "@acme/gh", deletedAt: null },
          versions: [version("1.0.0", { name: "gh" })],
          hasIcon: true,
        }),
      "GET /api/v1/admin/marketplaces": () => json(200, SOURCES),
      "GET /api/v1/admin/catalog/items": () => json(200, { items: [], nextOffset: null }),
    });
    await renderRouteWithCache(adminItemPath(), lastStubRoutes());
    const img = (await screen.findByRole("img", {
      name: fill(en.catalog.iconAlt, { name: "gh" }),
    })) as HTMLImageElement;
    expect(img.src).toMatch(new RegExp(`/api/v1/admin/catalog/items/${ID}/icon$`));
    expect(document.querySelector("svg[data-directory-icon]")).toBeNull();
  });

  it("item detail: no icon (hasIcon false) renders no image; a plugin without an extension has no deployment install", async () => {
    params.current = { itemId: ID };
    stubApi({
      [`GET /api/v1/admin/catalog/items/${ID}`]: () =>
        json(200, {
          item: { ...item({ name: "crm" }), packageName: "@acme/crm", deletedAt: null },
          versions: [version("1.0.0")],
          hasIcon: false,
        }),
      "GET /api/v1/admin/marketplaces": () => json(200, SOURCES),
      "GET /api/v1/admin/catalog/items": () => json(200, { items: [], nextOffset: null }),
    });
    await renderRouteWithCache(adminItemPath(), lastStubRoutes());
    expect(await screen.findByText("@acme/crm")).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText(en.catalog.components.extensionNone)).toBeTruthy();
    expect(screen.queryByRole("button", { name: en.catalog.admin.detail.deploy })).toBeNull();
  });

  it("entries: the marketplaces are tabs above the list only when there is more than one", async () => {
    const calls = stubApi({
      "GET /api/v1/admin/marketplaces": () => json(200, SOURCES),
      "GET /api/v1/admin/marketplaces/entries": () =>
        json(200, { items: [entry()], truncated: false }),
    });
    await renderRouteWithCache(entriesPath(), lastStubRoutes());
    const tabs = await screen.findByRole("tablist", { name: en.catalog.admin.filters.source });
    expect(within(tabs).getAllByRole("tab")).toHaveLength(3);
    await userEvent.setup().click(within(tabs).getAllByRole("tab")[2] as HTMLElement);
    await waitFor(() => expect(calls.some((c) => c.url.includes("sourceId=s2"))).toBe(true));
    cleanup();
    stubApi({
      "GET /api/v1/admin/marketplaces": () =>
        json(200, { ...SOURCES, items: SOURCES.items.slice(0, 1) }),
      "GET /api/v1/admin/marketplaces/entries": () =>
        json(200, { items: [entry()], truncated: false }),
    });
    await renderRouteWithCache(entriesPath(), lastStubRoutes());
    await screen.findByText(/@acme\/plugin-cat-a/);
    expect(screen.queryByRole("tablist", { name: en.catalog.admin.filters.source })).toBeNull();
  });

  it("entries search is debounced: typing sends one request with the keyword", async () => {
    const calls = stubApi({
      "GET /api/v1/admin/marketplaces": () => json(200, SOURCES),
      "GET /api/v1/admin/marketplaces/entries": () =>
        json(200, { items: [entry()], truncated: false }),
    });
    await renderRouteWithCache(entriesPath(), lastStubRoutes());
    await screen.findByText(/@acme\/plugin-cat-a/);
    await userEvent
      .setup()
      .type(screen.getByRole("searchbox", { name: en.catalog.admin.entries.search }), "cat-a");
    await waitFor(() => expect(calls.some((c) => c.url.includes("q=cat-a"))).toBe(true));
    expect(calls.filter((c) => c.url.includes("q=")).map((c) => c.url)).toEqual([
      "/api/v1/admin/marketplaces/entries?q=cat-a",
    ]);
  });
});

describe("inbox: catalog_request", () => {
  it("组织管理员批准成员的目录申请", async () => {
    const d = en.catalog.inbox;
    const request = {
      id: "r1",
      orgId: "o1",
      orgName: "Acme",
      kind: "enable",
      item: { id: ID, name: "pdf-tools", displayName: null },
      entry: null,
      status: "pending",
      note: "please",
      reason: null,
      requestedBy: "a2",
      requestedByName: "Mia",
      decidedBy: null,
      decidedAt: null,
      stagingId: null,
      createdAt: "2026-10-22T00:00:00.000Z",
    };
    let done = false;
    const routes = {
      [`GET ${ORG}/inbox`]: () =>
        json(200, {
          items: done
            ? []
            : [{ type: "catalog_request", id: "r1", createdAt: request.createdAt, request }],
          truncated: false,
        }),
      [`POST ${ORG}/catalog-requests/r1/decide`]: () => {
        done = true;
        return json(200, { request: { ...request, status: "approved" } });
      },
    };
    const calls = stubApi(routes);
    await renderRouteWithCache("/inbox", routes);
    expect(
      (await screen.findAllByText(fill(d.title, { name: "pdf-tools" }))).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText("please")).toBeTruthy();
    expect(screen.getByText("Mia")).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: d.approve }));
    expect(await screen.findByText(d.approved)).toBeTruthy();
    expect(bodyOf(calls.find((c) => c.method === "POST"))).toEqual({ approve: true });
  });
});

describe("组织插件：启用被目录条目拒绝", () => {
  it.each(LOCALES)("approval_required 显示翻译后的原因与去目录的入口（%s）", async (locale) => {
    const m = msgs[locale];
    stubApi({
      [`GET ${ORG}/file-previewers`]: () => json(200, { items: [] }),
      [`GET ${ORG}/extension-points`]: () => json(200, { points: [] }),
      [`GET ${ORG}/extensions`]: () =>
        json(200, {
          extensions: [
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
      [`PUT ${ORG}/extensions/crm-core`]: () =>
        json(403, { error: { code: "catalog.approval_required", message: "x" } }),
    });
    await renderRouteWithCache("/settings/extensions", lastStubRoutes(), { locale });
    await userEvent.setup().click(
      await screen.findByRole("switch", {
        name: fill(m.extensions.enableLabel, { plugin: "crm-core" }),
      }),
    );
    expect(await screen.findByText(`${m.errors.catalog.approval_required}`)).toBeTruthy();
    expect(screen.getByRole("link", { name: m.extensions.openCatalog }).getAttribute("href")).toBe(
      "/catalog",
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
      [`GET ${ORG}/catalog/${ID}`]: () =>
        json(200, {
          item: orgItem({ name: "github-mcp" }),
          hasIcon: false,
          extension: null,
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
          dependencies: [],
          skills: [],
        }),
      [`GET ${ORG}/extensions`]: () => json(200, { extensions: [] }),
    });
    await renderInstall();
    const slug = (await screen.findByLabelText(en.catalog.org.install.slug, {
      exact: false,
    })) as HTMLInputElement;
    expect(slug.value).toBe("github_mcp");
  });
});

describe("deployment requests with none pending", () => {
  it("one full-width empty state, not a narrow empty table beside an empty detail", async () => {
    stubApi({ "GET /api/v1/admin/catalog/requests": () => json(200, { requests: [] }) });
    await renderRouteWithCache("/admin/catalog/requests", lastStubRoutes());
    expect(await screen.findByText(en.catalog.admin.requests.empty)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(document.querySelector(".cb-body-rail")).toBeNull();
  });
});

describe("部署申请页显示申请人", () => {
  it("Inspector 里有申请人的显示名", async () => {
    stubApi({
      "GET /api/v1/admin/catalog/requests": () =>
        json(200, {
          requests: [
            {
              id: "r1",
              orgId: "o1",
              orgName: "Acme",
              item: { id: ID, name: "crm", displayName: null },
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
    await renderRouteWithCache("/admin/catalog/requests", lastStubRoutes());
    expect(await screen.findByText("Mia")).toBeTruthy();
    expect(screen.getByText(en.catalog.admin.requests.fields.requester)).toBeTruthy();
    // One title with the catalog tabs; this page is the active "requests" tab
    const tab = en.catalog.admin.tabs;
    expect(
      screen.getByRole("link", { name: new RegExp(`^${tab.plugins}`) }).getAttribute("href"),
    ).toBe("/admin/catalog");
    expect(
      screen
        .getByRole("link", { name: new RegExp(`^${tab.requests}`) })
        .getAttribute("aria-current"),
    ).toBeTruthy();
  });
});

describe("phase A1: git marketplaces, source detail and provenance", () => {
  const GIT_SOURCE = {
    id: "g1",
    name: "Acme git",
    url: "https://git.acme.com/acme/marketplace.git",
    form: "git",
    ref: "release",
    lastCommit: "0123456789abcdef0123456789abcdef01234567",
    mirrors: [],
    builtin: false,
    enabled: true,
    disabledByConfig: false,
    hasToken: false,
    lastRefreshedAt: "2026-10-22T00:00:00.000Z",
    lastStatus: "ok",
    lastError: null,
    entryCount: 2,
  };

  it.each(LOCALES)(
    "adding a git repository sends form git and the ref; a git marketplace shows its ref and last commit (%s)",
    async (locale) => {
      const s = msgs[locale].catalog.admin.marketplaces;
      const calls = stubApi({
        "GET /api/v1/admin/marketplaces": () =>
          json(200, { offline: false, items: [SOURCES.items[0], GIT_SOURCE] }),
        "POST /api/v1/admin/marketplaces": () => json(201, { ...GIT_SOURCE, id: "g2" }),
      });
      await renderRouteWithCache("/admin/marketplaces", lastStubRoutes(), { locale });
      expect(await screen.findByText(fill(s.gitInfo, { ref: "release" }))).toBeTruthy();
      expect(screen.getByText(fill(s.lastCommit, { commit: "0123456" }))).toBeTruthy();
      const user = userEvent.setup();
      const add = screen.getByRole("region", { name: s.add });
      await user.click(within(add).getByRole("radio", { name: s.formGit }));
      await user.type(within(add).getByRole("textbox", { name: s.name }), "Team");
      await user.type(within(add).getByRole("textbox", { name: s.url }), "acme/plugins");
      await user.type(within(add).getByRole("textbox", { name: startsWith(s.ref) }), "main");
      await user.click(within(add).getByRole("button", { name: s.add }));
      await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
      expect(bodyOf(calls.find((c) => c.method === "POST"))).toEqual({
        name: "Team",
        url: "acme/plugins",
        form: "git",
        ref: "main",
      });
    },
  );

  it("an http marketplace sends no form or ref", async () => {
    const s = en.catalog.admin.marketplaces;
    const calls = stubApi({
      "GET /api/v1/admin/marketplaces": () => json(200, { offline: false, items: [] }),
      "POST /api/v1/admin/marketplaces": () => json(201, { ...GIT_SOURCE, form: "http" }),
    });
    await renderRouteWithCache("/admin/marketplaces", lastStubRoutes());
    const add = await screen.findByRole("region", { name: s.add });
    const user = userEvent.setup();
    expect(within(add).queryByRole("textbox", { name: startsWith(s.ref) })).toBeNull();
    await user.type(within(add).getByRole("textbox", { name: s.name }), "Http");
    await user.type(within(add).getByRole("textbox", { name: s.url }), "https://x.com/m.json");
    await user.click(within(add).getByRole("button", { name: s.add }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(bodyOf(calls.find((c) => c.method === "POST"))).toEqual({
      name: "Http",
      url: "https://x.com/m.json",
    });
  });

  const gitEntry = (over: Record<string, unknown>) => ({
    sourceId: "g1",
    sourceName: "Acme git",
    name: "x",
    version: "1.0.0",
    summary: { en: "X" },
    minKernel: null,
    homepage: null,
    permissions: null,
    source: { path: "./plugins/x" },
    compatible: true,
    importable: true,
    adopted: null,
    newerAvailable: false,
    contentChanged: false,
    ...over,
  });

  it("entries: git sources pinned or following a branch, a path entry, an http marketplace's path entry; content changed at the same version can be imported again", async () => {
    const c = en.catalog.admin.entries;
    const sha = "89abcdef0123456789abcdef0123456789abcdef";
    const calls = stubApi({
      "GET /api/v1/admin/marketplaces": () => json(200, { offline: false, items: [GIT_SOURCE] }),
      "GET /api/v1/admin/marketplaces/entries": () =>
        json(200, {
          items: [
            gitEntry({
              name: "pinned",
              source: { git: { url: "https://git.acme.com/a/pinned.git", commit: sha } },
            }),
            gitEntry({
              name: "follows",
              source: { git: { url: "https://git.acme.com/a/follows.git", ref: "main" } },
            }),
            gitEntry({
              name: "in-repo",
              adopted: { itemId: ID, versions: ["1.0.0"] },
              contentChanged: true,
            }),
            gitEntry({
              name: "http-path",
              sourceId: "s2",
              importable: false,
              reason: "path_needs_git_marketplace",
            }),
          ],
          truncated: false,
        }),
      "POST /api/v1/admin/marketplaces/g1/entries/in-repo/import": () =>
        json(200, { stagingId: "st7", review: REVIEW }),
    });
    await renderRouteWithCache(entriesPath(), lastStubRoutes());
    const list = await screen.findByRole("list", { name: c.title });
    const row = (name: string) => within(list).getByText(name).closest("li") as HTMLElement;
    const meta = (name: string) => row(name).querySelector(".cb-object-meta")?.textContent ?? "";
    expect(meta("pinned")).toContain(fill(c.gitPinned, { commit: "89abcde" }));
    expect(meta("follows")).toContain(fill(c.gitFollows, { ref: "main" }));
    expect(meta("in-repo")).toContain(fill(c.pathSource, { path: "./plugins/x" }));
    expect(within(row("in-repo")).getByText(en.catalog.contentChanged)).toBeTruthy();
    expect(within(row("http-path")).getByText(c.reason.path_needs_git_marketplace)).toBeTruthy();
    const user = userEvent.setup();
    await user.click(
      within(row("in-repo")).getByRole("button", {
        name: fill(c.importChanged, { version: "v1.0.0" }),
      }),
    );
    await waitFor(() =>
      expect(router.push).toHaveBeenCalledWith("/admin/catalog/import?staging=st7"),
    );
    expect(bodyOf(calls.find((x) => x.method === "POST"))).toEqual({ version: "1.0.0" });
  });

  it("an entry import refused by the network rules shows the copy and a localized line naming the host", async () => {
    const message =
      "Access to git.internal is refused: it resolves to a private or reserved address (add the hostname to marketplaces.allowPrivateHosts to allow an internal host).";
    stubApi({
      "GET /api/v1/admin/marketplaces": () => json(200, { offline: false, items: [GIT_SOURCE] }),
      "GET /api/v1/admin/marketplaces/entries": () =>
        json(200, { items: [gitEntry({})], truncated: false }),
      "POST /api/v1/admin/marketplaces/g1/entries/x/import": () =>
        json(422, {
          error: {
            code: "marketplace.private_address",
            message,
            details: [{ host: "git.internal" }],
          },
        }),
    });
    await renderRouteWithCache(entriesPath(), lastStubRoutes());
    const list = await screen.findByRole("list", { name: en.catalog.admin.entries.title });
    const user = userEvent.setup();
    await user.click(
      within(list).getByRole("button", {
        name: fill(en.catalog.admin.entries.importVersion, { version: "v1.0.0" }),
      }),
    );
    expect(await screen.findByText(`${en.errors.marketplace.private_address}`)).toBeTruthy();
    expect(
      screen.getByText(`${fill(en.catalog.errorDetail.host, { host: "git.internal" })}`),
    ).toBeTruthy();
    // The kernel's English message is for logs and API users, not shown
    expect(screen.queryByText(`${message}`)).toBeNull();
  });

  it("a git redirect from a URL without .git adds a localized line saying to use the .git URL", async () => {
    stubApi({
      "GET /api/v1/admin/marketplaces": () => json(200, { offline: false, items: [GIT_SOURCE] }),
      "GET /api/v1/admin/marketplaces/entries": () =>
        json(200, { items: [gitEntry({})], truncated: false }),
      "POST /api/v1/admin/marketplaces/g1/entries/x/import": () =>
        json(422, {
          error: {
            code: "marketplace.redirect",
            message: "gitlab.com responded with a redirect (301); redirects are not followed.",
            details: [{ host: "gitlab.com", repo: "acme/tools", hint: "git_suffix" }],
          },
        }),
    });
    await renderRouteWithCache(entriesPath(), lastStubRoutes());
    const list = await screen.findByRole("list", { name: en.catalog.admin.entries.title });
    const user = userEvent.setup();
    await user.click(
      within(list).getByRole("button", {
        name: fill(en.catalog.admin.entries.importVersion, { version: "v1.0.0" }),
      }),
    );
    expect(await screen.findByText(`${en.errors.marketplace.redirect}`)).toBeTruthy();
    expect(screen.getByText(`${en.catalog.errorDetail.gitSuffix}`)).toBeTruthy();
  });

  it.each(LOCALES)(
    "the review shows npm provenance and the git source; a build version and a repository mismatch are explained (%s)",
    async (locale) => {
      const r = msgs[locale].catalog.admin.review;
      const o = msgs[locale].catalog.origin;
      window.history.replaceState(null, "", "/admin/catalog/import?staging=st3");
      const commit = "fedcba9876543210fedcba9876543210fedcba98";
      stubApi({
        "GET /api/v1/admin/catalog/imports/st3": () =>
          json(200, {
            stagingId: "st3",
            review: {
              ...REVIEW,
              version: "1.0.0+git.fedcba987654",
              pluginVersion: "1.0.0",
              source: {
                kind: "marketplace",
                ref: "g1/crm",
                detail: {
                  host: "git.acme.com",
                  repo: "acme/marketplace",
                  path: "plugins/crm",
                  ref: "main",
                  commit,
                  followsBranch: true,
                },
              },
              provenance: {
                checked: true,
                repository: "https://github.com/acme/crm",
                commit,
                workflow: ".github/workflows/release.yml",
                buildType: "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
              },
              provenanceWarning: "repository_mismatch",
            },
          }),
      });
      await renderRouteWithCache(importPath(), lastStubRoutes(), { locale });
      expect(
        await screen.findByText(
          fill(r.provenance, {
            repository: "https://github.com/acme/crm",
            commit: "fedcba9",
            workflow: ".github/workflows/release.yml",
          }),
        ),
      ).toBeTruthy();
      expect(screen.getByText(r.provenanceMismatch)).toBeTruthy();
      const origin = `${fill(o.git, { location: "git.acme.com/acme/marketplace (plugins/crm)", commit: "fedcba9" })} · ${fill(o.followsBranch, { ref: "main" })}`;
      expect(screen.getByText(fill(r.origin, { origin }))).toBeTruthy();
      expect(
        screen.getByText(
          fill(r.buildVersion, { version: "v1.0.0+git.fedcba987654", pluginVersion: "v1.0.0" }),
        ),
      ).toBeTruthy();
    },
  );

  it("provenance not checked is shown only for npm sources", async () => {
    const r = en.catalog.admin.review;
    window.history.replaceState(null, "", "/admin/catalog/import?staging=st6");
    stubApi({
      "GET /api/v1/admin/catalog/imports/st6": () =>
        json(200, {
          stagingId: "st6",
          review: {
            ...REVIEW,
            source: { kind: "git", ref: "acme/crm" },
            provenance: { checked: false, reason: "not an npm package" },
          },
        }),
    });
    await renderRouteWithCache(importPath(), lastStubRoutes());
    await screen.findByRole("region", { name: en.catalog.components.extension });
    expect(
      screen.queryByText(fill(r.provenanceNotChecked, { reason: "not an npm package" })),
    ).toBeNull();
  });

  it("provenance not checked says why", async () => {
    const r = en.catalog.admin.review;
    window.history.replaceState(null, "", "/admin/catalog/import?staging=st4");
    stubApi({
      "GET /api/v1/admin/catalog/imports/st4": () =>
        json(200, { stagingId: "st4", review: REVIEW }),
    });
    await renderRouteWithCache(importPath(), lastStubRoutes());
    expect(
      await screen.findByText(
        fill(r.provenanceNotChecked, { reason: "the registry has no provenance for this version" }),
      ),
    ).toBeTruthy();
  });

  it.each(LOCALES)(
    "import from git: url, ref and path go to import/git; a git failure names the repository and ref in localized copy (%s)",
    async (locale) => {
      const r = msgs[locale].catalog.admin.review;
      const ed = msgs[locale].catalog.errorDetail;
      let fail = true;
      const calls = stubApi({
        "POST /api/v1/admin/catalog/import/git": () =>
          fail
            ? json(502, {
                error: {
                  code: "marketplace.git_failed",
                  message: "the server refused to serve commit abc; pin a branch or tag tip",
                  details: [{ host: "github.com", repo: "acme/crm", ref: "v1.0.0" }],
                },
              })
            : json(200, { stagingId: "st5", review: REVIEW }),
      });
      await renderRouteWithCache(importPath(), lastStubRoutes(), { locale });
      const user = userEvent.setup();
      await user.click(await screen.findByRole("radio", { name: new RegExp(`^${r.sourceGit}`) }));
      await user.type(screen.getByRole("textbox", { name: r.gitUrl }), "acme/crm");
      await user.type(screen.getByRole("textbox", { name: startsWith(r.gitRef) }), "v1.0.0");
      await user.type(screen.getByRole("textbox", { name: startsWith(r.gitPath) }), "plugins/crm");
      await user.click(screen.getByRole("button", { name: r.fetch }));
      expect(await screen.findByText(`${msgs[locale].errors.marketplace.git_failed}`)).toBeTruthy();
      expect(
        screen.getByText(
          `${fill(ed.repo, { location: "github.com/acme/crm" })} · ${fill(ed.ref, { ref: "v1.0.0" })}`,
        ),
      ).toBeTruthy();
      expect(screen.queryByText(/the server refused to serve commit/)).toBeNull();
      fail = false;
      await user.click(screen.getByRole("button", { name: r.fetch }));
      await waitFor(() =>
        expect(router.replace).toHaveBeenCalledWith("/admin/catalog/import?staging=st5"),
      );
      expect(bodyOf(calls.at(-1))).toEqual({ url: "acme/crm", ref: "v1.0.0", path: "plugins/crm" });
    },
  );

  it("item detail: content changed at the same version, and each version's origin", async () => {
    params.current = { itemId: ID };
    const d = en.catalog.admin.detail;
    const o = en.catalog.origin;
    const v = (version: string, over: Record<string, unknown>) => ({
      version,
      source: "git",
      sourceRef: "acme/crm",
      integrity: null,
      contentDigest: "e".repeat(64),
      sourceDetail: null,
      manifest: { name: "crm", version, publisher: "Acme", description: "" },
      size: 10,
      extensionSha256: null,
      importedAt: "2026-10-22T00:00:00.000Z",
      ...over,
    });
    stubApi({
      [`GET /api/v1/admin/catalog/items/${ID}`]: () =>
        json(200, {
          item: {
            id: ID,
            name: "crm",
            publisher: "Acme",
            displayName: null,
            description: "",
            scope: "optional",
            scopeOrgs: [],
            builtin: false,
            disabled: false,
            shownToOthers: true,
            enabledOrgs: 0,
            pending: false,
            permissionsHash: null,
            latestVersion: "1.0.0",
            versions: ["1.0.0", "0.9.0"],
            installs: 0,
            source: "git",
            marketplaceId: "g1",
            latestMarketplaceVersion: "1.0.0",
            newerInMarketplace: false,
            contentChanged: true,
            updatedAt: "2026-10-22T00:00:00.000Z",
            packageName: null,
            deletedAt: null,
          },
          versions: [
            v("1.0.0", {
              sourceDetail: {
                host: "github.com",
                repo: "acme/crm",
                path: ".",
                commit: "1111111222222233333334444444555555566666",
                followsBranch: false,
              },
            }),
            v("0.9.0", {
              source: "npm",
              sourceDetail: { registry: "https://registry.npmjs.org" },
            }),
          ],
          hasIcon: false,
        }),
      "GET /api/v1/admin/marketplaces": () => json(200, { offline: false, items: [GIT_SOURCE] }),
      "GET /api/v1/admin/catalog/items": () => json(200, { items: [], nextOffset: null }),
    });
    await renderRouteWithCache(adminItemPath(), lastStubRoutes());
    expect(await screen.findByText(d.contentChanged)).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("tab", { name: d.tabs.versions }));
    const table = screen.getByRole("table");
    expect(
      within(table).getByText(
        `${fill(o.git, { location: "github.com/acme/crm", commit: "1111111" })} · ${o.pinned}`,
      ),
    ).toBeTruthy();
    expect(
      within(table).getByText(fill(o.registry, { registry: "https://registry.npmjs.org" })),
    ).toBeTruthy();
    expect(within(table).getAllByText(en.catalog.versionSource.git).length).toBe(1);
  });

  it("catalog list: content changed is marked", async () => {
    stubApi({
      "GET /api/v1/admin/catalog/items": () =>
        json(200, {
          items: [
            {
              id: ID,
              name: "crm",
              publisher: "Acme",
              displayName: null,
              description: "",
              scope: "optional",
              scopeOrgs: [],
              builtin: false,
              disabled: false,
              shownToOthers: true,
              enabledOrgs: 0,
              pending: false,
              permissionsHash: null,
              latestVersion: "1.0.0",
              versions: ["1.0.0"],
              installs: 0,
              source: "git",
              marketplaceId: "g1",
              latestMarketplaceVersion: "1.0.0",
              newerInMarketplace: false,
              contentChanged: true,
              updatedAt: "2026-10-22T00:00:00.000Z",
            },
          ],
          nextOffset: null,
        }),
      "GET /api/v1/admin/marketplaces": () => json(200, { offline: false, items: [GIT_SOURCE] }),
    });
    await renderRouteWithCache("/admin/catalog", lastStubRoutes());
    const list = await screen.findByRole("list", { name: en.catalog.admin.title });
    expect(within(list).getByText(en.catalog.contentChanged)).toBeTruthy();
  });
});

describe("phase A1: plugin upgrades and skill conflicts", () => {
  const PREVIEW = {
    from: "1.0.0",
    to: "1.1.0",
    diffHash: "f".repeat(64),
    components: [
      { kind: "skill", ref: "notes", change: "changed" },
      { kind: "skill", ref: "extra", change: "added" },
      { kind: "connector", ref: "gh", change: "changed", detail: "credentials change" },
      { kind: "agent_template", ref: "reviewer", change: "changed" },
    ],
    inputs: { connectors: [], credentialsChanged: ["gh"], extensionConfig: false },
    // The target version's template (not in the latest version's detail below)
    templates: [
      {
        id: "gh",
        displayName: { zh: "GitHub", en: "GitHub" },
        description: "",
        plugin: "connector-mcp",
        connector: "mcp",
        endpoint: { url: "https://mcp.example.com" },
        editableEndpoint: ["url"],
        auth: { type: "bearer", ownership: "org" },
        ownership: "org",
      },
    ],
  };
  const DETAIL = {
    item: orgItem({
      name: "crm",
      latestVersion: "1.1.0",
      installed: { pluginInstallId: "i1", version: "1.0.0", upgradeAvailable: "1.1.0" },
    }),
    hasIcon: false,
    extension: null,
    templates: [],
    dependencies: [],
    skills: ["skills/notes", "skills/extra"],
  };
  const UPGRADABLE = {
    ...INSTALL,
    components: [
      { kind: "skill", ref: "s1", created: true, skillVersion: 1, dropped: false },
      { kind: "skill", ref: "old-notes", created: true, skillVersion: 1, dropped: true },
    ],
    upgradeAvailable: "1.1.0",
    deploymentPending: false,
  };

  it.each(LOCALES)(
    "settings/plugins: upgrade available opens the dialog; preview -> changes and inputs -> confirm posts { version, diffHash, connectors } (%s)",
    async (locale) => {
      const m = msgs[locale].catalog;
      let upgraded = false;
      const calls = stubApi({
        [`GET ${ORG}/plugin-installs`]: () =>
          json(200, {
            installs: [
              upgraded ? { ...UPGRADABLE, version: "1.1.0", upgradeAvailable: null } : UPGRADABLE,
            ],
          }),
        [`GET ${ORG}/catalog/${ID}`]: () => json(200, DETAIL),
        [`GET ${ORG}/extensions`]: () => json(200, { extensions: [] }),
        [`POST ${ORG}/plugin-installs/i1/upgrade/preview`]: () => json(200, PREVIEW),
        [`POST ${ORG}/plugin-installs/i1/upgrade`]: () => {
          upgraded = true;
          return json(200, { install: { ...UPGRADABLE, version: "1.1.0" } });
        },
      });
      await renderRouteWithCache("/settings/plugins", lastStubRoutes(), { locale });
      expect(
        await screen.findByText(fill(m.plugins.upgradeAvailable, { version: "v1.1.0" })),
      ).toBeTruthy();
      expect(
        screen.getByText(`· ${m.plugins.componentKind.skill} old-notes — ${m.plugins.dropped}`),
      ).toBeTruthy();
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: m.plugins.upgrade }));
      const dialog = await screen.findByRole("dialog");
      const line = (change: keyof typeof m.upgrade.change, kind: string, ref: string) =>
        fill(m.upgrade.line, { change: m.upgrade.change[change], kind, ref });
      expect(
        await within(dialog).findByText(line("changed", m.plugins.componentKind.skill, "notes")),
      ).toBeTruthy();
      expect(
        within(dialog).getByText(line("added", m.plugins.componentKind.skill, "extra")),
      ).toBeTruthy();
      expect(
        within(dialog).getByText(
          line("changed", m.plugins.componentKind.agent_template, "reviewer"),
        ),
      ).toBeTruthy();
      expect(
        within(dialog).getByText(fill(m.upgrade.credentialsInput, { name: "GitHub" })),
      ).toBeTruthy();
      expect(bodyOf(calls.find((c) => c.url.endsWith("/upgrade/preview")))).toEqual({
        version: "1.1.0",
      });
      // The changed connector keeps its name, slug and endpoint: only credentials are asked, and
      // they are required before confirming
      expect(within(dialog).queryByLabelText("url")).toBeNull();
      expect(
        (within(dialog).getByRole("button", { name: m.upgrade.confirm }) as HTMLButtonElement)
          .disabled,
      ).toBe(true);
      await user.type(
        within(dialog).getByLabelText(msgs[locale].connectors.form.tokenLabel),
        "new-tok",
      );
      await user.click(within(dialog).getByRole("button", { name: m.upgrade.confirm }));
      expect(
        await screen.findByText(fill(m.upgrade.done, { name: "crm", version: "v1.1.0" })),
      ).toBeTruthy();
      expect(bodyOf(calls.find((c) => c.url.endsWith("/upgrade")))).toEqual({
        version: "1.1.0",
        diffHash: "f".repeat(64),
        connectors: { gh: { credential: { token: "new-tok" } } },
      });
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    },
  );

  it("settings/plugins: the deployment's extension moved on -> the org is told to upgrade; upgrading status; a stale preview is fetched again", async () => {
    const m = en.catalog;
    let previews = 0;
    const calls = stubApi({
      [`GET ${ORG}/plugin-installs`]: () =>
        json(200, {
          installs: [
            { ...UPGRADABLE, deploymentPending: true },
            { ...INSTALL, id: "i3", name: "busy", status: "upgrading", components: [] },
          ],
        }),
      [`GET ${ORG}/catalog/${ID}`]: () => json(200, DETAIL),
      [`GET ${ORG}/extensions`]: () => json(200, { extensions: [] }),
      [`POST ${ORG}/plugin-installs/i1/upgrade/preview`]: () => {
        previews += 1;
        return json(200, {
          ...PREVIEW,
          diffHash: String(previews).repeat(64),
          components: [],
          inputs: { connectors: [], credentialsChanged: [], extensionConfig: false },
          templates: [],
        });
      },
      [`POST ${ORG}/plugin-installs/i1/upgrade`]: () =>
        json(409, { error: { code: "plugin.upgrade_stale", message: "x" } }),
    });
    await renderRouteWithCache("/settings/plugins", lastStubRoutes());
    expect(await screen.findByText(m.plugins.deploymentPending)).toBeTruthy();
    expect(screen.getByText(new RegExp(`^${m.plugins.status.upgrading}`))).toBeTruthy();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: m.plugins.upgrade }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText(m.upgrade.noChanges)).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: m.upgrade.confirm }));
    expect(await within(dialog).findByText(`${en.errors.plugin.upgrade_stale}`)).toBeTruthy();
    await waitFor(() => expect(previews).toBe(2));
    await user.click(within(dialog).getByRole("button", { name: m.upgrade.confirm }));
    await waitFor(() =>
      expect(calls.filter((c) => c.url.endsWith("/upgrade")).map((c) => bodyOf(c))).toEqual([
        { version: "1.1.0", diffHash: "1".repeat(64) },
        { version: "1.1.0", diffHash: "2".repeat(64) },
      ]),
    );
  });

  it("catalog item: installed with an upgrade available offers the upgrade to org admins; needs approval -> request submitted", async () => {
    params.current = { itemId: ID };
    const m = en.catalog;
    stubApi({
      [`GET ${ORG}/catalog/${ID}`]: () => json(200, DETAIL),
      [`GET ${ORG}/extensions`]: () => json(200, { extensions: [] }),
      [`POST ${ORG}/plugin-installs/i1/upgrade/preview`]: () =>
        json(200, {
          ...PREVIEW,
          inputs: { connectors: [], credentialsChanged: [], extensionConfig: false },
          templates: [],
        }),
      [`POST ${ORG}/plugin-installs/i1/upgrade`]: () =>
        json(202, { request: { id: "r1", stage: "deployment", status: "pending" } }),
    });
    await renderItem();
    expect(
      await screen.findByText(fill(m.org.action.upgradeAvailable, { version: "v1.1.0" })),
    ).toBeTruthy();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: m.org.action.upgrade }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText(fill(m.upgrade.versions, { from: "v1.0.0", to: "v1.1.0" }));
    await user.click(within(dialog).getByRole("button", { name: m.upgrade.confirm }));
    expect(await screen.findByText(m.upgrade.requested)).toBeTruthy();
  });

  const NO_INPUTS = {
    ...PREVIEW,
    components: [],
    inputs: { connectors: [], credentialsChanged: [], extensionConfig: false },
    templates: [],
  };

  it("the upgrade dialog's extension config card is titled with the display name", async () => {
    const m = en.catalog;
    stubApi({
      [`GET ${ORG}/plugin-installs`]: () => json(200, { installs: [UPGRADABLE] }),
      [`POST ${ORG}/plugin-installs/i1/upgrade/preview`]: () =>
        json(200, {
          ...NO_INPUTS,
          inputs: { connectors: [], credentialsChanged: [], extensionConfig: true },
        }),
      [`GET ${ORG}/extensions`]: () =>
        json(200, {
          extensions: [
            {
              plugin: "crm",
              displayName: { zh: "客户系统", en: "CRM Suite" },
              version: "1.0.0",
              enabled: true,
              configurable: true,
              config: null,
              secrets: [],
              permissions: [],
              orgConfigSchema: {
                type: "object",
                properties: { region: { type: "string", title: "Region" } },
              },
            },
          ],
        }),
    });
    await renderRouteWithCache("/settings/plugins", lastStubRoutes(), { locale: "en" });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: m.plugins.upgrade }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("CRM Suite")).toBeTruthy();
    expect(within(dialog).queryByText("crm", { exact: true })).toBeNull();
  });

  it("upgrading from the catalog item invalidates the catalog, the items and what the plugin brings", async () => {
    params.current = { itemId: ID };
    const calls = stubApi({
      [`GET ${ORG}/catalog/${ID}`]: () =>
        json(200, {
          item: orgItem({
            name: "crm",
            installed: { pluginInstallId: "i1", version: "1.0.0", upgradeAvailable: "1.1.0" },
          }),
          hasIcon: false,
          extension: null,
          templates: [],
          dependencies: [],
          skills: [],
        }),
      [`POST ${ORG}/plugin-installs/i1/upgrade/preview`]: () => json(200, NO_INPUTS),
      [`POST ${ORG}/plugin-installs/i1/upgrade`]: () =>
        json(200, { install: { ...UPGRADABLE, version: "1.1.0" } }),
    });
    const { client } = await renderItem();
    client.setQueryData(["org", "o1", "connectors"], { connectors: [] });
    client.setQueryData(["org", "o1", "skills"], { skills: [] });
    const m = en.catalog;
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: m.org.action.upgrade }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText(m.upgrade.noChanges);
    await user.click(within(dialog).getByRole("button", { name: m.upgrade.confirm }));
    // the item (shown) is read again; the cached lists are marked stale
    await vi.waitFor(() =>
      expect(
        calls.filter((c) => c.method === "GET" && c.url === `${ORG}/catalog/${ID}`),
      ).toHaveLength(1),
    );
    expect(client.getQueryState(["org", "o1", "connectors"])?.isInvalidated).toBe(true);
    expect(client.getQueryState(["org", "o1", "skills"])?.isInvalidated).toBe(true);
  });

  it.each(LOCALES)(
    "a failed upgrade names the step, the dependency and whether the components were put back (%s)",
    async (locale) => {
      const m = msgs[locale].catalog;
      let rolledBack = true;
      stubApi({
        [`GET ${ORG}/plugin-installs`]: () => json(200, { installs: [UPGRADABLE] }),
        [`POST ${ORG}/plugin-installs/i1/upgrade/preview`]: () => json(200, NO_INPUTS),
        [`POST ${ORG}/plugin-installs/i1/upgrade`]: () =>
          json(502, {
            error: {
              code: "plugin.upgrade_failed",
              message: "x",
              details: [
                {
                  step: "skills",
                  code: "internal",
                  dependency: "crm-core",
                  message: "English cause",
                  causeDetails: [{ path: "skills.notes", message: "bad file" }],
                  rolledBack,
                },
              ],
            },
          }),
      });
      await renderRouteWithCache("/settings/plugins", lastStubRoutes(), { locale });
      const user = userEvent.setup();
      await user.click(await screen.findByRole("button", { name: m.plugins.upgrade }));
      const dialog = await screen.findByRole("dialog");
      await within(dialog).findByText(m.upgrade.noChanges);
      await user.click(within(dialog).getByRole("button", { name: m.upgrade.confirm }));
      const inDep = fill(m.org.install.failedIn, { dependency: "crm-core" });
      expect(
        await within(dialog).findByText(
          `${fill(m.upgrade.failed, { step: m.org.install.step.skills, code: "internal", version: "v1.0.0" })} ${inDep}`,
        ),
      ).toBeTruthy();
      expect(within(dialog).getByText("skills.notes: bad file")).toBeTruthy();
      expect(within(dialog).queryByText(/English cause/)).toBeNull();
      rolledBack = false;
      await user.click(within(dialog).getByRole("button", { name: m.upgrade.confirm }));
      expect(
        await within(dialog).findByText(
          `${fill(m.upgrade.failedNoRollback, { step: m.org.install.step.skills, code: "internal" })} ${inDep}`,
        ),
      ).toBeTruthy();
    },
  );

  it.each(LOCALES)(
    "an invalid target says why in localized copy (deployment version, dependent range) (%s)",
    async (locale) => {
      const m = msgs[locale];
      let details: unknown[] = [
        { reason: "deployment_version", deploymentVersion: "0.1.0", allowedVersion: "0.1.0" },
      ];
      stubApi({
        [`GET ${ORG}/plugin-installs`]: () => json(200, { installs: [UPGRADABLE] }),
        [`POST ${ORG}/plugin-installs/i1/upgrade/preview`]: () =>
          json(409, {
            error: { code: "plugin.upgrade_target_invalid", message: "English", details },
          }),
      });
      await renderRouteWithCache("/settings/plugins", lastStubRoutes(), { locale });
      const user = userEvent.setup();
      await user.click(await screen.findByRole("button", { name: m.catalog.plugins.upgrade }));
      const dialog = await screen.findByRole("dialog");
      expect(
        await within(dialog).findByText(
          `${fill(m.catalog.errorDetail.deploymentVersion, { deploymentVersion: "0.1.0", allowedVersion: "0.1.0" })}`,
        ),
      ).toBeTruthy();
      expect(within(dialog).queryByText(/English/)).toBeNull();
      await user.click(within(dialog).getByRole("button", { name: m.catalog.upgrade.cancel }));
      details = [
        { reason: "dependent_range", dependent: "app", range: "^1.0.0", version: "2.0.0" },
      ];
      await user.click(screen.getByRole("button", { name: m.catalog.plugins.upgrade }));
      expect(
        await within(await screen.findByRole("dialog")).findByText(
          `${fill(m.catalog.errorDetail.dependentRange, { dependent: "app", range: "^1.0.0", version: "v2.0.0" })}`,
        ),
      ).toBeTruthy();
    },
  );

  it("after a stale confirm, confirm waits for the new preview", async () => {
    const m = en.catalog;
    let release: () => void = () => {};
    let previews = 0;
    stubApi({
      [`GET ${ORG}/plugin-installs`]: () => json(200, { installs: [UPGRADABLE] }),
      [`POST ${ORG}/plugin-installs/i1/upgrade/preview`]: async () => {
        previews += 1;
        if (previews > 1) await new Promise<void>((r) => (release = r));
        return json(200, NO_INPUTS);
      },
      [`POST ${ORG}/plugin-installs/i1/upgrade`]: () =>
        json(409, { error: { code: "plugin.upgrade_stale", message: "x" } }),
    });
    await renderRouteWithCache("/settings/plugins", lastStubRoutes());
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: m.plugins.upgrade }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText(m.upgrade.noChanges);
    const confirm = () =>
      within(dialog).getByRole("button", { name: m.upgrade.confirm }) as HTMLButtonElement;
    await user.click(confirm());
    await within(dialog).findByText(`${en.errors.plugin.upgrade_stale}`);
    await waitFor(() => expect(previews).toBe(2));
    expect(confirm().disabled).toBe(true);
    release();
    await waitFor(() => expect(confirm().disabled).toBe(false));
  });

  it("catalog item: members see the upgrade but no button", async () => {
    params.current = { itemId: ID };
    stubApi({ [`GET ${ORG}/catalog/${ID}`]: () => json(200, DETAIL) });
    await renderItem({ me: MEMBER });
    expect(
      await screen.findByText(fill(en.catalog.org.action.upgradeAvailable, { version: "v1.1.0" })),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: en.catalog.org.action.upgrade })).toBeNull();
  });

  it("catalog item: the plugin's agent templates are listed", async () => {
    params.current = { itemId: ID };
    stubApi({
      [`GET ${ORG}/catalog/${ID}`]: () =>
        json(200, { ...DETAIL, agents: ["agents/reviewer.md", "agents/tester.md"] }),
    });
    await renderItem({ me: MEMBER });
    expect(await screen.findByText("· reviewer")).toBeTruthy();
    expect(screen.getByText("· tester")).toBeTruthy();
    expect(screen.getByText(en.catalog.components.agentTemplates)).toBeTruthy();
  });

  it.each(LOCALES)(
    "install wizard: a skill conflict names each skill and where it comes from (%s)",
    async (locale) => {
      params.current = { itemId: ID };
      const m = msgs[locale];
      stubApi({
        [`GET ${ORG}/catalog/${ID}`]: () =>
          json(200, { ...DETAIL, item: orgItem({ name: "crm" }), templates: [] }),
        [`GET ${ORG}/extensions`]: () => json(200, { extensions: [] }),
        [`POST ${ORG}/catalog/${ID}/install`]: () =>
          json(409, {
            error: {
              code: "plugin.skill_conflict",
              message: "x",
              details: [
                { skill: "notes", source: { kind: "org" } },
                { skill: "extra", source: { kind: "plugin", name: "other", version: "2.0.0" } },
                { skill: "more", source: { kind: "plugin", name: "legacy", version: "" } },
              ],
            },
          }),
      });
      await renderInstall({ locale });
      await screen.findByText(m.catalog.org.install.summary);
      await userEvent
        .setup()
        .click(screen.getByRole("button", { name: m.catalog.org.install.submit }));
      expect(await screen.findByText(`${m.errors.plugin.skill_conflict}`)).toBeTruthy();
      expect(
        screen.getByText(`${fill(m.catalog.components.skillConflictOrg, { skill: "notes" })}`),
      ).toBeTruthy();
      expect(
        screen.getByText(
          `${fill(m.catalog.components.skillConflictPlugin, { skill: "extra", plugin: "other v2.0.0" })}`,
        ),
      ).toBeTruthy();
      expect(
        screen.getByText(
          `${fill(m.catalog.components.skillConflictPlugin, { skill: "more", plugin: "legacy" })}`,
        ),
      ).toBeTruthy();
    },
  );
});

const CLAUDE_REVIEW = {
  ...REVIEW,
  name: "superpowers",
  version: "7.0.1",
  packageName: null,
  publisher: "Jesse Vincent",
  description: "Skills for coding agents",
  license: "MIT",
  extension: undefined,
  sensitive: false,
  connectorTemplates: [],
  dependencies: [],
  source: { kind: "git", ref: "https://github.com/obra/superpowers.git" },
  provenance: { checked: false, reason: "not an npm package" },
  format: "claude-code",
  repository: "https://github.com/obra/superpowers",
  licenseText: "MIT License\n\nCopyright (c) 2025 Jesse Vincent",
  skills: [
    {
      name: "using-superpowers",
      description: "Use at the start of every conversation",
      body: "# Using superpowers",
      path: "skills/using-superpowers",
      files: 3,
      suggestPinned: true,
    },
    {
      name: "brainstorming",
      description: "Use before creative work",
      body: "# Brainstorming\n\nAsk questions first.",
      path: "skills/brainstorming",
      files: 1,
      suggestPinned: false,
    },
  ],
  translation: {
    format: "claude-code",
    manifestPath: ".claude-plugin/plugin.json",
    sessionStart: false,
    items: [
      {
        group: "imported",
        component: "skill",
        name: "brainstorming",
        path: "skills/brainstorming",
        code: "skill_imported",
      },
      {
        group: "converted",
        component: "mcpServer",
        name: "docs",
        code: "mcp_template",
        detail: { template: "docs", auth: "none" },
      },
      {
        group: "needsInput",
        component: "mcpServer",
        name: "github",
        code: "mcp_header_variable",
        detail: { header: "Authorization", variable: "GITHUB_TOKEN" },
      },
      {
        group: "ignored",
        component: "hook",
        name: "SessionStart",
        path: "hooks/hooks.json",
        code: "hooks_not_run",
        detail: { handlers: "command" },
      },
      {
        group: "ignored",
        component: "skill",
        name: "broken",
        path: "skills/broken",
        code: "skill_invalid",
        detail: { problem: "description is required" },
      },
      {
        group: "warnings",
        component: "skill",
        name: "brainstorming",
        path: "skills/brainstorming",
        code: "skill_ignored_restrictions",
        detail: { keys: "allowed-tools" },
      },
    ],
  },
};

/** The text of a report item line. */
const itemLine = (
  locale: (typeof LOCALES)[number],
  item: { component: string; name: string; code: string; detail?: Record<string, string> },
) => {
  const tr = msgs[locale].catalog.admin.review.translation;
  return fill(tr.item, {
    component: tr.components[item.component as keyof typeof tr.components],
    name: item.name,
    reason: fill(tr.codes[item.code as keyof typeof tr.codes], item.detail ?? {}),
  });
};

describe("phase B: Claude Code plugins on the import review", () => {
  const stage = (review: Record<string, unknown>) => {
    window.history.replaceState(null, "", "/admin/catalog/import?staging=st9");
    return stubApi({
      "GET /api/v1/admin/catalog/imports/st9": () => json(200, { stagingId: "st9", review }),
      "POST /api/v1/admin/catalog/imports/st9/confirm": () =>
        json(201, { item: { id: ID, name: "superpowers" }, deploy: null }),
    });
  };

  it.each(LOCALES)(
    "the review lists the five groups with localized reasons, the format and the repository (%s)",
    async (locale) => {
      const tr = msgs[locale].catalog.admin.review.translation;
      stage(CLAUDE_REVIEW);
      await renderRouteWithCache(importPath(), lastStubRoutes(), { locale });
      const report = await screen.findByRole("region", { name: tr.title });
      expect(screen.getByText(tr.formatClaude)).toBeTruthy();
      expect(
        screen.getByText(
          fill(tr.repository, { repository: "https://github.com/obra/superpowers" }),
        ),
      ).toBeTruthy();
      const count = (g: string) =>
        CLAUDE_REVIEW.translation.items.filter((i) => i.group === g).length;
      for (const g of TRANSLATION_GROUPS) {
        const region = within(report).getByRole("region", {
          name: fill(tr.groupTitle, { group: tr.groups[g], n: count(g) }),
        });
        for (const i of CLAUDE_REVIEW.translation.items.filter((x) => x.group === g)) {
          expect(within(region).getByText(itemLine(locale, i))).toBeTruthy();
        }
      }
      // detail the message does not name is an extra line
      expect(within(report).getByText(fill(tr.detail.handlers, { value: "command" }))).toBeTruthy();
      expect(
        within(report).getByText(fill(tr.detail.problem, { value: "description is required" })),
      ).toBeTruthy();
    },
  );

  it("an item in a group this web does not know (a newer kernel) is listed under Other, not dropped (batch-3 m7)", async () => {
    const tr = en.catalog.admin.review.translation;
    stage({
      ...CLAUDE_REVIEW,
      translation: {
        ...CLAUDE_REVIEW.translation,
        items: [
          ...CLAUDE_REVIEW.translation.items,
          { group: "future", component: "skill", name: "later", code: "future_code" },
        ],
      },
    });
    await renderRouteWithCache(importPath(), lastStubRoutes());
    const other = await screen.findByRole("region", {
      name: fill(tr.groupTitle, { group: tr.groups.other, n: 1 }),
    });
    expect(
      within(other).getByText(
        fill(tr.item, { component: tr.components.skill, name: "later", reason: "future_code" }),
      ),
    ).toBeTruthy();
  });

  it("a SKILL.md body, description or LICENSE with bidi or control characters carries a warning line (batch-3 m9)", async () => {
    const tr = en.catalog.admin.review.translation;
    const [using, brainstorming] = CLAUDE_REVIEW.skills;
    stage({
      ...CLAUDE_REVIEW,
      licenseText: "MIT License\u202e",
      skills: [
        { ...using, body: "# Using\u2066 superpowers" },
        { ...brainstorming, description: "Use\u0007 before" },
      ],
    });
    await renderRouteWithCache(importPath(), lastStubRoutes());
    await screen.findByRole("button", { name: tr.license });
    expect(screen.getAllByText(tr.bidiWarning)).toHaveLength(3);
    cleanup();
    vi.unstubAllGlobals();
    stage(CLAUDE_REVIEW);
    await renderRouteWithCache(importPath(), lastStubRoutes());
    await screen.findByRole("button", { name: tr.license });
    expect(screen.queryByText(tr.bidiWarning)).toBeNull();
  });

  it("an empty group says so", async () => {
    const tr = en.catalog.admin.review.translation;
    stage({
      ...CLAUDE_REVIEW,
      translation: {
        ...CLAUDE_REVIEW.translation,
        items: CLAUDE_REVIEW.translation.items.slice(0, 1),
      },
    });
    await renderRouteWithCache(importPath(), lastStubRoutes());
    const warnings = await screen.findByRole("region", {
      name: fill(tr.groupTitle, { group: tr.groups.warnings, n: 0 }),
    });
    expect(within(warnings).getByText(tr.groupNone)).toBeTruthy();
  });

  it("suggest pinned checkboxes are sent as pinnedSuggestions on confirm", async () => {
    const tr = en.catalog.admin.review.translation;
    const calls = stage(CLAUDE_REVIEW);
    await renderRouteWithCache(importPath(), lastStubRoutes());
    const user = userEvent.setup();
    // no SessionStart hook: the suggestion is collapsed
    const toggle = await screen.findByRole("button", {
      name: fill(tr.pinnedTitle, { n: 1, total: 2 }),
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await user.click(toggle);
    const using = screen.getByRole("checkbox", {
      name: fill(tr.suggestPinned, { name: "using-superpowers" }),
    }) as HTMLInputElement;
    expect(using.checked).toBe(true);
    await user.click(using);
    await user.click(
      screen.getByRole("checkbox", { name: fill(tr.suggestPinned, { name: "brainstorming" }) }),
    );
    await user.click(screen.getByRole("button", { name: en.admin.extensions.wizard.next }));
    await user.click(screen.getByRole("button", { name: en.catalog.admin.review.confirm }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith(`/admin/catalog/${ID}`));
    expect(bodyOf(calls.find((x) => x.url.endsWith("/confirm")))).toEqual({
      reviewHash: "h1",
      pinnedSuggestions: ["brainstorming"],
    });
  });

  it("confirming the plugin's own suggestion unchanged omits pinnedSuggestions; unticking every suggested skill sends [] (batch-3 m1)", async () => {
    const tr = en.catalog.admin.review.translation;
    const confirmWith = async (untick: boolean) => {
      const calls = stage(CLAUDE_REVIEW);
      await renderRouteWithCache(importPath(), lastStubRoutes());
      const user = userEvent.setup();
      const toggle = await screen.findByRole("button", {
        name: fill(tr.pinnedTitle, { n: 1, total: 2 }),
      });
      if (untick) {
        await user.click(toggle);
        await user.click(
          screen.getByRole("checkbox", {
            name: fill(tr.suggestPinned, { name: "using-superpowers" }),
          }),
        );
      }
      await user.click(screen.getByRole("button", { name: en.admin.extensions.wizard.next }));
      await user.click(screen.getByRole("button", { name: en.catalog.admin.review.confirm }));
      await waitFor(() => expect(router.push).toHaveBeenCalledWith(`/admin/catalog/${ID}`));
      const body = bodyOf(calls.find((x) => x.url.endsWith("/confirm")));
      cleanup();
      vi.unstubAllGlobals();
      resetNavigation("/");
      return body;
    };
    expect(await confirmWith(false)).toEqual({ reviewHash: "h1" });
    expect(await confirmWith(true)).toEqual({
      reviewHash: "h1",
      pinnedSuggestions: [],
    });
  });

  it("with a SessionStart hook the pinned suggestion is open and shows the hint", async () => {
    const tr = en.catalog.admin.review.translation;
    stage({
      ...CLAUDE_REVIEW,
      translation: { ...CLAUDE_REVIEW.translation, sessionStart: true },
    });
    await renderRouteWithCache(importPath(), lastStubRoutes());
    const toggle = await screen.findByRole("button", {
      name: fill(tr.pinnedTitle, { n: 1, total: 2 }),
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText(tr.sessionStartHint)).toBeTruthy();
    expect(
      screen.getByRole("checkbox", { name: fill(tr.suggestPinned, { name: "brainstorming" }) }),
    ).toBeTruthy();
  });

  it("each skill's SKILL.md and the license are collapsed and expandable", async () => {
    const tr = en.catalog.admin.review.translation;
    stage(CLAUDE_REVIEW);
    await renderRouteWithCache(importPath(), lastStubRoutes());
    const user = userEvent.setup();
    const license = await screen.findByRole("button", { name: tr.license });
    expect(license.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText(/Copyright \(c\) 2025/)).toBeNull();
    await user.click(license);
    expect(screen.getByText(/Copyright \(c\) 2025/)).toBeTruthy();
    const body = screen.getByRole("button", {
      name: fill(tr.skillBody, { name: "brainstorming" }),
    });
    expect(screen.queryByText(/Ask questions first/)).toBeNull();
    await user.click(body);
    expect(screen.getByText(/Ask questions first/)).toBeTruthy();
  });

  it("a truncated license says so; both manifests say the Claude one was ignored", async () => {
    const tr = en.catalog.admin.review.translation;
    stage({
      ...REVIEW,
      extension: undefined,
      sensitive: false,
      format: "capybara",
      licenseTruncated: true,
      claudeManifestIgnored: true,
    });
    await renderRouteWithCache(importPath(), lastStubRoutes());
    expect(await screen.findByText(tr.licenseTruncated)).toBeTruthy();
    expect(screen.getByText(tr.claudeManifestIgnored)).toBeTruthy();
    expect(screen.queryByRole("button", { name: tr.license })).toBeNull();
  });

  it("a native plugin review shows no translation section but still offers the pinned suggestion", async () => {
    const tr = en.catalog.admin.review.translation;
    stage({ ...REVIEW, extension: undefined, sensitive: false, format: "capybara" });
    await renderRouteWithCache(importPath(), lastStubRoutes());
    await screen.findByRole("region", { name: en.catalog.components.skills });
    expect(screen.queryByRole("region", { name: tr.title })).toBeNull();
    expect(screen.queryByText(tr.formatClaude)).toBeNull();
    expect(
      screen.getByRole("button", { name: fill(tr.pinnedTitle, { n: 0, total: 1 }) }),
    ).toBeTruthy();
  });

  it("every TranslationCode, detail key and MarketplaceSkipReason has zh and en text with its placeholders", () => {
    const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const locale of LOCALES) {
      const tr = msgs[locale].catalog.admin.review.translation as unknown as {
        codes: Record<string, string>;
        detail: Record<string, string>;
        groups: Record<string, string>;
      };
      expect(Object.keys(tr.codes).sort()).toEqual([...TRANSLATION_CODES].sort());
      for (const code of TRANSLATION_CODES) {
        expect(vars(tr.codes[code] as string), `${locale} ${code}`).toEqual(
          [...TRANSLATION_CODE_PLACEHOLDERS[code]].sort(),
        );
      }
      for (const k of TRANSLATION_DETAIL_KEYS)
        expect(vars(tr.detail[k] as string)).toEqual(["value"]);
      for (const g of TRANSLATION_GROUPS) expect(tr.groups[g]).toBeTruthy();
      const reasons = msgs[locale].catalog.admin.marketplaces.skipped.reasons as Record<
        string,
        string
      >;
      expect(Object.keys(reasons).sort()).toEqual([...MARKETPLACE_SKIP_REASONS].sort());
    }
  });
});

describe("phase B: Claude Code plugins in the catalog and marketplaces", () => {
  const claudeItemDetail = (version: Record<string, unknown> = {}) =>
    json(200, {
      item: {
        id: ID,
        name: "superpowers",
        publisher: "Jesse Vincent",
        displayName: null,
        description: "",
        scope: "optional",
        scopeOrgs: [],
        builtin: false,
        disabled: false,
        shownToOthers: true,
        enabledOrgs: 0,
        pending: false,
        permissionsHash: null,
        latestVersion: "7.0.1",
        versions: ["7.0.1"],
        installs: 0,
        source: "git",
        marketplaceId: null,
        latestMarketplaceVersion: null,
        newerInMarketplace: false,
        contentChanged: false,
        updatedAt: "2026-10-22T00:00:00.000Z",
        packageName: null,
        deletedAt: null,
      },
      versions: [
        {
          version: "7.0.1",
          source: "git",
          sourceRef: "obra/superpowers",
          integrity: null,
          contentDigest: "e".repeat(64),
          sourceDetail: null,
          manifest: {
            name: "superpowers",
            version: "7.0.1",
            publisher: "Jesse Vincent",
            description: "",
            skills: [{ path: "./skills/brainstorming" }],
          },
          size: 10,
          extensionSha256: null,
          importedAt: "2026-10-22T00:00:00.000Z",
          sourceFormat: "claude-code",
          translation: CLAUDE_REVIEW.translation,
          licenseText: "MIT License",
          ...version,
        },
      ],
      hasIcon: false,
    });

  it("item detail: a Claude Code version shows its format, report and license; the versions table has a format column", async () => {
    params.current = { itemId: ID };
    const tr = en.catalog.admin.review.translation;
    const d = en.catalog.admin.detail;
    stubApi({
      [`GET /api/v1/admin/catalog/items/${ID}`]: () => claudeItemDetail(),
      "GET /api/v1/admin/marketplaces": () => json(200, SOURCES),
      "GET /api/v1/admin/catalog/items": () => json(200, { items: [], nextOffset: null }),
    });
    await renderRouteWithCache(adminItemPath(), lastStubRoutes());
    const report = await screen.findByRole("region", { name: tr.title });
    expect(
      within(report).getByText(itemLine("en", CLAUDE_REVIEW.translation.items[0] as never)),
    ).toBeTruthy();
    expect(screen.getByText(tr.formatClaude)).toBeTruthy();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: tr.license }));
    expect(screen.getByText("MIT License")).toBeTruthy();
    await user.click(screen.getByRole("tab", { name: d.tabs.versions }));
    const table = screen.getByRole("table");
    expect(within(table).getByText(d.versionColumns.format)).toBeTruthy();
    expect(within(table).getByText(d.format.claudeCode)).toBeTruthy();
  });

  it("item detail: a version whose LICENSE was too long to store says so (batch-3 m6)", async () => {
    params.current = { itemId: ID };
    const tr = en.catalog.admin.review.translation;
    stubApi({
      [`GET /api/v1/admin/catalog/items/${ID}`]: () =>
        claudeItemDetail({ licenseText: null, licenseTruncated: true }),
      "GET /api/v1/admin/marketplaces": () => json(200, SOURCES),
      "GET /api/v1/admin/catalog/items": () => json(200, { items: [], nextOffset: null }),
    });
    await renderRouteWithCache(adminItemPath(), lastStubRoutes());
    expect(await screen.findByText(tr.licenseTruncated)).toBeTruthy();
    expect(screen.queryByRole("button", { name: tr.license })).toBeNull();
  });

  it.each(LOCALES)(
    "marketplaces: entries the last refresh skipped are listed with the reason (%s)",
    async (locale) => {
      const s = msgs[locale].catalog.admin.marketplaces;
      const acme = SOURCES.items[1] as (typeof SOURCES.items)[number];
      stubApi({
        "GET /api/v1/admin/marketplaces": () =>
          json(200, {
            offline: false,
            items: [
              {
                ...acme,
                lastStatus: "ok",
                lastError: null,
                skipped: [
                  { name: "npm-thing", reason: "claude_npm_unpinned" },
                  { name: "Bad Name", reason: "invalid_name" },
                ],
              },
            ],
          }),
      });
      await renderRouteWithCache("/admin/marketplaces", lastStubRoutes(), { locale });
      const title = {
        en: "2 entries were skipped by the last refresh",
        zh: fill(s.skipped.title, { n: 2 }),
      };
      expect(await screen.findByText(title[locale])).toBeTruthy();
      expect(
        screen.getByText(
          fill(s.skipped.line, {
            name: "npm-thing",
            reason: s.skipped.reasons.claude_npm_unpinned,
          }),
        ),
      ).toBeTruthy();
      expect(
        screen.getByText(
          fill(s.skipped.line, { name: "Bad Name", reason: s.skipped.reasons.invalid_name }),
        ),
      ).toBeTruthy();
    },
  );
  it("marketplaces: one skipped entry reads in the singular; a long list shows 20 and how many more, duplicate names included (batch-3 m2, m3)", async () => {
    const s = en.catalog.admin.marketplaces;
    const acme = SOURCES.items[1] as (typeof SOURCES.items)[number];
    const routes = (skipped: { name: string; reason: string }[]) => ({
      "GET /api/v1/admin/marketplaces": () =>
        json(200, {
          offline: false,
          items: [{ ...acme, lastStatus: "ok", lastError: null, skipped }],
        }),
    });
    stubApi(routes([{ name: "npm-thing", reason: "claude_npm_unpinned" }]));
    await renderRouteWithCache("/admin/marketplaces", lastStubRoutes());
    expect(await screen.findByText("1 entry was skipped by the last refresh")).toBeTruthy();
    cleanup();
    vi.unstubAllGlobals();

    const many = Array.from({ length: 25 }, () => ({ name: "dup", reason: "invalid_entry" }));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    stubApi(routes(many));
    await renderRouteWithCache("/admin/marketplaces", lastStubRoutes());
    expect(await screen.findByText("25 entries were skipped by the last refresh")).toBeTruthy();
    const line = fill(s.skipped.line, { name: "dup", reason: s.skipped.reasons.invalid_entry });
    expect(screen.getAllByText(line)).toHaveLength(20);
    expect(screen.getByText(fill(s.skipped.more, { n: 5 }))).toBeTruthy();
    // no duplicate React keys
    expect(errors.mock.calls.some((c) => String(c[0]).includes("same key"))).toBe(false);
  });
});

describe("/catalog/[itemId]/install renders on the server (web-SSR spec §6)", () => {
  const detail = {
    item: orgItem({ name: "crm" }),
    hasIcon: false,
    extension: null,
    templates: [],
    dependencies: [],
    skills: ["skills/notes"],
  };
  const routes = {
    [`GET ${ORG}/catalog/${ID}`]: () => json(200, detail),
    [`GET ${ORG}/extensions`]: () => json(200, { extensions: [] }),
  };
  const as = (role: "member" | "admin"): Me => ({
    ...ME,
    account: { ...ME.account, isEnterpriseAdmin: false },
    memberships: [{ ...ME.memberships[0], role } as Me["memberships"][number]],
  });

  const path = `/catalog/${ID}/install`;

  it("a first render from the hydrated cache makes no browser read; it is a setup step", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRouteWithCache(path, routes, { readiness: NOT_READY });
    expect(screen.getByText(en.catalog.org.install.summarySkills.replace("{n}", "1"))).toBeTruthy();
    await settle();
    expect(browser).toEqual([]);
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("an empty cache shows the template's loading state, then the data", async () => {
    const { release } = await renderHeld(path, routes, `GET ${ORG}/catalog/${ID}`);
    await vi.waitFor(() => {
      if (template("WizardPage") === null) throw new Error("no page");
    });
    expect(document.querySelector("[aria-busy='true']")).not.toBeNull();
    await release();
    expect(
      await screen.findByText(en.catalog.org.install.summarySkills.replace("{n}", "1")),
    ).toBeTruthy();
    await vi.waitFor(() => expect(document.querySelector("[aria-busy='true']")).toBeNull());
  });

  it("the org extensions failing still renders the wizard; a missing item is the not-found state", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRouteWithCache(path, {
      ...routes,
      [`GET ${ORG}/extensions`]: () => json(503, { error: { code: "internal" } }),
    });
    expect(template("WizardPage")).not.toBeNull();
    await settle();
    // a section that failed on the first load is not read again on mount
    expect(browser).toEqual([]);
    cleanup();
    await renderRouteWithCache(path, {
      [`GET ${ORG}/catalog/${ID}`]: () => json(404, { error: { code: "catalog.not_found" } }),
      [`GET ${ORG}/extensions`]: () => json(200, { extensions: [] }),
    });
    expect(screen.getByRole("heading", { level: 1, name: en.notFound.title })).toBeTruthy();
  });

  it("a member gets no access and nothing is read; no org renders nothing", async () => {
    const member = await renderRouteWithCache(path, routes, { me: as("member") });
    expect(new Set(member.calls.map((c) => c.url))).toEqual(
      new Set(["/api/v1/me", `${ORG}/readiness`]),
    );
    expect(template("StatusPage")?.getAttribute("data-kind")).toBe("no-access");
    cleanup();
    const none = await renderRouteWithCache(path, routes, { me: { ...ME, currentOrgId: null } });
    expect(none.calls.map((c) => c.url)).toEqual(["/api/v1/me"]);
  });
});

describe("/catalog and /catalog/[itemId] render on the server (web-SSR spec §6)", () => {
  const detail = {
    item: orgItem({ name: "crm" }),
    hasIcon: false,
    extension: "crm",
    templates: [],
    dependencies: [],
    skills: [],
  };
  const routes = {
    [`GET ${ORG}/catalog`]: () => json(200, { items: [orgItem()] }),
    [`GET ${ORG}/catalog/${ID}`]: () => json(200, detail),
  };
  const GUEST: Me = {
    ...ME,
    account: { ...ME.account, isEnterpriseAdmin: false },
    memberships: [{ ...ME.memberships[0], role: "guest" } as Me["memberships"][number]],
  };

  it("/catalog: a first render from the hydrated cache makes no browser read; it is a setup step", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRouteWithCache("/catalog", routes, { readiness: NOT_READY });
    expect(within(screen.getByRole("list", { name: en.catalog.org.title })).getByText("pdf-tools"));
    await settle();
    expect(browser).toEqual([]);
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("/catalog: an empty cache shows the template's loading state, then the data", async () => {
    const { release } = await renderHeld("/catalog", routes, `GET ${ORG}/catalog`);
    await vi.waitFor(() => {
      if (template("ListPage") === null) throw new Error("no page");
    });
    expect(document.querySelector("[aria-busy='true']")).not.toBeNull();
    expect(screen.queryByText("pdf-tools")).toBeNull();
    await release();
    expect(await screen.findByText("pdf-tools")).toBeTruthy();
    await vi.waitFor(() => expect(document.querySelector("[aria-busy='true']")).toBeNull());
  });

  it("/catalog: a guest gets no access and nothing is read; no org renders nothing", async () => {
    const guest = await renderRouteWithCache("/catalog", routes, { me: GUEST });
    expect(new Set(guest.calls.map((c) => c.url))).toEqual(
      new Set(["/api/v1/me", `${ORG}/readiness`]),
    );
    expect(template("StatusPage")?.getAttribute("data-kind")).toBe("no-access");
    cleanup();
    const none = await renderRouteWithCache("/catalog", routes, {
      me: { ...ME, currentOrgId: null },
    });
    expect(none.calls.map((c) => c.url)).toEqual(["/api/v1/me"]);
    expect(document.body.textContent).toBe("");
  });

  it("/catalog/<id>: a first render from the hydrated cache makes no browser read; it is a setup step", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRouteWithCache(`/catalog/${ID}`, routes, { readiness: NOT_READY });
    expect(screen.getByRole("heading", { level: 1, name: "crm" })).toBeTruthy();
    expect(screen.getByText("· crm")).toBeTruthy();
    await settle();
    expect(browser).toEqual([]);
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("/catalog/<id>: an empty cache shows the template's loading state, then the data", async () => {
    const { release } = await renderHeld(`/catalog/${ID}`, routes, `GET ${ORG}/catalog/${ID}`);
    await vi.waitFor(() => {
      if (template("DetailPage") === null) throw new Error("no page");
    });
    expect(document.querySelector("[aria-busy='true']")).not.toBeNull();
    expect(screen.queryByRole("heading", { level: 1, name: "crm" })).toBeNull();
    // the overview's static parts: the install action's button and the five component sections;
    // the inspector's three facts; no generic cards
    const page = template("DetailPage") as HTMLElement;
    expect(page.querySelectorAll('[data-part="loading-card"]')).toHaveLength(0);
    expect(page.querySelectorAll('[data-part="loading-buttons"]')).toHaveLength(1);
    const stack = page.querySelector('[data-part="loading-buttons"]')?.closest(".cb-stack")
      ?.parentElement as HTMLElement;
    expect(stack.children).toHaveLength(7);
    expect(page.querySelectorAll('[data-part="loading-inspector-row"]')).toHaveLength(3);
    await release();
    expect(await screen.findByRole("heading", { level: 1, name: "crm" })).toBeTruthy();
    await vi.waitFor(() => expect(document.querySelector("[aria-busy='true']")).toBeNull());
  });

  it("/catalog/<id>: an item the kernel does not find is the not-found state in the shell", async () => {
    expectNoFirstPaintFetch();
    await renderRouteWithCache(`/catalog/${ID}`, {
      [`GET ${ORG}/catalog/${ID}`]: () =>
        json(404, { error: { code: "catalog.item_not_found", message: "x" } }),
    });
    expect(screen.getByRole("heading", { level: 1, name: en.notFound.title })).toBeTruthy();
  });

  it("/catalog/<id>: a guest gets no access and nothing is read; no org renders nothing", async () => {
    const guest = await renderRouteWithCache(`/catalog/${ID}`, routes, { me: GUEST });
    expect(new Set(guest.calls.map((c) => c.url))).toEqual(
      new Set(["/api/v1/me", `${ORG}/readiness`]),
    );
    expect(template("StatusPage")?.getAttribute("data-kind")).toBe("no-access");
    cleanup();
    const none = await renderRouteWithCache(`/catalog/${ID}`, routes, {
      me: { ...ME, currentOrgId: null },
    });
    expect(none.calls.map((c) => c.url)).toEqual(["/api/v1/me"]);
    expect(document.body.textContent).toBe("");
  });

  it("requesting an install invalidates the catalog and the item: the item is read again", async () => {
    params.current = { itemId: ID };
    const calls = stubApi({
      [`GET ${ORG}/catalog/${ID}`]: () =>
        json(200, { ...detail, extension: null, item: orgItem({ name: "crm" }) }),
      [`POST ${ORG}/catalog/${ID}/requests`]: () =>
        json(201, { request: { id: "r1" }, created: true }),
    });
    const { client } = await renderItem({ me: MEMBER });
    client.setQueryData(["org", "o1", "catalog"], { items: [orgItem()] });
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: en.catalog.org.action.request }));
    await vi.waitFor(() =>
      expect(calls.filter((c) => c.method === "GET").map((c) => c.url)).toEqual([
        `${ORG}/catalog/${ID}`,
      ]),
    );
    expect(client.getQueryState(["org", "o1", "catalog"])?.isInvalidated).toBe(true);
  });
});
