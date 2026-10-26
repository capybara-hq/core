import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import AdminCatalogItemPage from "../src/app/[locale]/(app)/admin/catalog/[itemId]/page";
import PluginImportPage from "../src/app/[locale]/(app)/admin/catalog/import/page";
import AdminCatalogPage from "../src/app/[locale]/(app)/admin/catalog/page";
import CatalogRequestsPage from "../src/app/[locale]/(app)/admin/catalog/requests/page";
import MarketplaceEntriesPage from "../src/app/[locale]/(app)/admin/marketplaces/entries/page";
import MarketplacesPage from "../src/app/[locale]/(app)/admin/marketplaces/page";
import InstallPage from "../src/app/[locale]/(app)/catalog/[itemId]/install/page";
import OrgCatalogItemPage from "../src/app/[locale]/(app)/catalog/[itemId]/page";
import CatalogPage from "../src/app/[locale]/(app)/catalog/page";
import InboxRoute from "../src/app/[locale]/(app)/inbox/page";
import ExtensionsPage from "../src/app/[locale]/(app)/settings/extensions/page";
import PluginsPage from "../src/app/[locale]/(app)/settings/plugins/page";
import { defaultSlug, slugOf } from "../src/components/CatalogInstallWizard";
import {
  MARKETPLACE_SKIP_REASONS,
  TRANSLATION_CODE_PLACEHOLDERS,
  TRANSLATION_CODES,
  TRANSLATION_DETAIL_KEYS,
  TRANSLATION_GROUPS,
} from "../src/lib/catalog";
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

describe("/catalog: actions follow installable", () => {
  it.each(LOCALES)(
    "org admins: available / needs approval / approved / disabled / not deployed / installed / requested (%s)",
    async (locale) => {
      const a = msgs[locale].catalog.org.action;
      const items = [
        orgItem({ id: "a", name: "yes-skill" }),
        orgItem({ id: "b", name: "approval", installable: "needs_approval" }),
        orgItem({ id: "c", name: "granted-tpl", installable: "granted" }),
        orgItem({ id: "d", name: "off", installable: "disabled" }),
        orgItem({ id: "e", name: "missing", installable: "not_deployed" }),
        orgItem({
          id: "f",
          name: "done",
          installed: { pluginInstallId: "i1", version: "1.0.0", upgradeAvailable: null },
        }),
        orgItem({
          id: "g",
          name: "asked",
          installable: "needs_approval",
          request: { id: "r1", stage: "deployment", status: "pending" },
        }),
      ];
      const calls = stubApi({
        [`GET ${ORG}/catalog`]: () => json(200, { items }),
        [`POST ${ORG}/catalog/b/install`]: () =>
          json(202, { request: { id: "r2", stage: "deployment", status: "pending" } }),
      });
      renderPage(<CatalogPage />, { locale });
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
      expect(
        within(row("done")).getByRole("link", { name: a.openPlugins }).getAttribute("href"),
      ).toBe("/settings/plugins");
      expect(within(row("asked")).queryByRole("button")).toBeNull();
      expect(
        within(row("asked")).getByText(fill(a.pendingHint, { stage: a.stage.deployment })),
      ).toBeTruthy();

      const user = userEvent.setup();
      // Every install goes through the wizard (it lists the components and dependencies)
      await user.click(within(row("granted-tpl")).getByRole("button", { name: a.install }));
      expect(router.push).toHaveBeenCalledWith("/catalog/c/install");
      await user.click(within(row("yes-skill")).getByRole("button", { name: a.install }));
      expect(router.push).toHaveBeenCalledWith("/catalog/a/install");
      // needs_approval asks an enterprise admin directly (202, a request is created)
      await user.click(within(row("approval")).getByRole("button", { name: a.requestApproval }));
      await waitFor(() =>
        expect(calls.some((c) => c.url === `${ORG}/catalog/b/install`)).toBe(true),
      );
      expect(bodyOf(calls.find((c) => c.url === `${ORG}/catalog/b/install`))).toEqual({});
    },
  );

  it("成员：可装的条目只能申请（进组织管理员收件箱）", async () => {
    const a = en.catalog.org.action;
    const calls = stubApi({
      [`GET ${ORG}/catalog`]: () =>
        json(200, {
          items: [
            orgItem(),
            orgItem({
              id: "f",
              name: "done",
              installed: { pluginInstallId: "i1", version: "1.0.0", upgradeAvailable: null },
            }),
          ],
        }),
      [`POST ${ORG}/catalog/${ID}/requests`]: () =>
        json(201, { request: { id: "r" }, created: true }),
    });
    renderPage(<CatalogPage />, { me: MEMBER });
    const btn = await screen.findByRole("button", { name: a.request });
    expect(screen.queryByRole("button", { name: a.install })).toBeNull();
    // Installed plugins are an org admin page: members get no link to it
    expect(screen.queryByRole("link", { name: a.openPlugins })).toBeNull();
    await userEvent.setup().click(btn);
    await waitFor(() =>
      expect(calls.find((c) => c.url.endsWith("/requests"))?.method).toBe("POST"),
    );
  });
});

describe("/catalog: dependency errors", () => {
  it("asking for approval when a dependency cannot be resolved names it (409 catalog.dependency_unresolved)", async () => {
    stubApi({
      [`GET ${ORG}/catalog`]: () =>
        json(200, { items: [orgItem({ id: "b", installable: "needs_approval" })] }),
      [`POST ${ORG}/catalog/b/install`]: () =>
        json(409, {
          error: {
            code: "catalog.dependency_unresolved",
            message: "x",
            details: [{ dependency: "crm-core", range: "^1.0.0" }],
          },
        }),
    });
    renderPage(<CatalogPage />);
    await userEvent
      .setup()
      .click(await screen.findByRole("button", { name: en.catalog.org.action.requestApproval }));
    expect(await screen.findByText(`✗ ${en.errors.catalog.dependency_unresolved}`)).toBeTruthy();
    expect(
      screen.getByText(
        `✗ ${fill(en.catalog.components.errorDependency, { dependency: "crm-core ^1.0.0" })}`,
      ),
    ).toBeTruthy();
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
  it.each(LOCALES)(
    "one review: extension action and sensitive items, skills, templates, resolved and unresolved dependencies; confirm needs the sensitive ack and posts { reviewHash, deployExtension } (%s)",
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
      renderPage(<PluginImportPage />, { locale });
      expect(template("WizardPage")).not.toBeNull();
      const user = userEvent.setup();
      await user.click(await screen.findByRole("radio", { name: r.sourceNpm }));
      await user.type(screen.getByRole("textbox", { name: w.npmPackage }), "@acme/plugin-crm");
      await user.click(screen.getByRole("button", { name: r.fetch }));
      const ext = await screen.findByRole("region", { name: c.extension });
      expect(within(ext).getByText(fill(r.action.install, { version: "1.0.0" }))).toBeTruthy();
      expect(within(ext).getAllByText(msgs[locale].extensions.sensitive).length).toBeGreaterThan(0);
      const skills = screen.getByRole("region", { name: c.skills });
      expect(within(skills).getByText(`pdf-tools · ${fill(c.skillFiles, { n: 2 })}`)).toBeTruthy();
      const templates = screen.getByRole("region", { name: c.templates });
      expect(within(templates).getByText(fill(r.editable, { paths: "url" }))).toBeTruthy();
      const deps = screen.getByRole("region", { name: c.dependencies });
      expect(
        within(deps).getByText(
          fill(c.dependencyResolved, { name: "crm-core", range: "^1.0.0", version: "1.2.0" }),
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
      // Not deployed by default: says the extension is only recorded in the catalog
      expect(screen.getByText(r.deployOff)).toBeTruthy();
      await user.click(screen.getByRole("checkbox", { name: r.deployExtension }));
      expect(screen.getByText(r.deployOn)).toBeTruthy();
      expect(confirm.disabled).toBe(true);
      await user.click(screen.getByRole("checkbox", { name: r.ack }));
      expect(confirm.disabled).toBe(false);
      await user.click(confirm);
      await waitFor(() => expect(router.push).toHaveBeenCalledWith(`/admin/catalog/${ID}`));
      expect(bodyOf(calls.find((x) => x.url.endsWith("/confirm")))).toEqual({
        reviewHash: "h1",
        deployExtension: true,
      });
    },
  );

  it("?staging=<id>: shows the review prepared on another page; a plugin without an extension confirms with deployExtension false", async () => {
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
    renderPage(<PluginImportPage />);
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
    expect(screen.queryByRole("checkbox", { name: r.deployExtension })).toBeNull();
    await user.click(screen.getByRole("button", { name: r.confirm }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith(`/admin/catalog/${ID}`));
    expect(bodyOf(calls.find((x) => x.url.endsWith("/confirm")))).toEqual({
      reviewHash: "h1",
      deployExtension: false,
    });
  });

  it("?staging=<id> expired or confirmed: says so; starting over shows the source step", async () => {
    const r = en.catalog.admin.review;
    window.history.replaceState(null, "", "/admin/catalog/import?staging=gone");
    stubApi({
      "GET /api/v1/admin/catalog/imports/gone": () =>
        json(404, { error: { code: "plugin.staging_not_found", message: "x" } }),
    });
    renderPage(<PluginImportPage />);
    expect(await screen.findByText(`✗ ${en.errors.plugin.staging_not_found}`)).toBeTruthy();
    expect(screen.getByText(r.gone)).toBeTruthy();
    expect(screen.queryByRole("radio", { name: r.sourceNpm })).toBeNull();
    await userEvent.setup().click(screen.getByRole("button", { name: r.restart }));
    expect(await screen.findByRole("radio", { name: r.sourceNpm })).toBeTruthy();
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
    renderPage(<PluginImportPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: en.admin.extensions.wizard.next }));
    await user.click(screen.getByRole("checkbox", { name: r.deployExtension }));
    await user.click(screen.getByRole("button", { name: r.confirm }));
    expect(
      await screen.findByText(
        fill(r.deployFailed, { name: "crm", version: "1.0.0", code: "extension.migration_failed" }),
      ),
    ).toBeTruthy();
    expect(screen.getByText("relation exists")).toBeTruthy();
    expect(screen.getByText("snapshot_not_restored: changed meanwhile")).toBeTruthy();
    expect(screen.getByRole("link", { name: r.openItem }).getAttribute("href")).toBe(
      `/admin/catalog/${ID}`,
    );
    expect(router.push).not.toHaveBeenCalled();
  });

  it("a pre-0.1.0 upload shows the legacy-format error prominently", async () => {
    stubApi({
      "GET /api/v1/me": () => json(200, ME),
      "POST /api/v1/admin/catalog/import/file": () =>
        json(422, { error: { code: "catalog.legacy_format", message: "x" } }),
    });
    renderPage(<PluginImportPage />);
    const user = userEvent.setup();
    await screen.findByRole("radio", { name: en.catalog.admin.review.sourceFile });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, new File([new Uint8Array([1, 2, 3])], "old.tgz"));
    await user.click(screen.getByRole("button", { name: en.catalog.admin.review.fetch }));
    expect(await screen.findByText(`✗ ${en.errors.catalog.legacy_format}`)).toBeTruthy();
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
    // The extension step: nothing to fill in (the extension has no org config here)
    expect(screen.getByText(t.extensionNone)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: t.next }));
    // Confirm lists the dependencies installed with it
    expect(screen.getByText(t.summaryDependencies)).toBeTruthy();
    expect(screen.getByText("· crm-core ^1.0.0")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: t.submit }));
    expect(
      await screen.findByText(
        `✗ ${fill(t.failed, { step: t.step.skills, code: "internal" })} ${fill(t.failedIn, { dependency: "crm-core" })}`,
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
      renderPage(<InstallPage />, { locale });
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
    renderPage(<InstallPage />);
    // Wait for the wizard (the loading frame has a disabled submit button too)
    await screen.findByText(t.summaryDependencies);
    await userEvent.setup().click(screen.getByRole("button", { name: t.submit }));
    expect(await screen.findByText(`✗ ${en.errors.catalog.dependency_unresolved}`)).toBeTruthy();
    expect(
      screen.getByText(
        `✗ ${fill(en.catalog.components.errorDependency, { dependency: "crm-core ^1.0.0" })}`,
      ),
    ).toBeTruthy();
  });

  it("the extension's org config is sent as extensionConfig when this install enables it; success goes to the installed plugins", async () => {
    params.current = { itemId: ID };
    const t = en.catalog.org.install;
    const calls = stubApi({
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
    renderPage(<InstallPage />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Region", { exact: false }), "eu");
    await user.click(screen.getByRole("button", { name: t.next }));
    await user.click(screen.getByRole("button", { name: t.submit }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/settings/plugins"));
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
      stubApi({
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
      renderPage(<PluginsPage />, { locale });
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
    },
  );

  it("仍在安装中：409 app.install_in_progress 给出友好说明", async () => {
    stubApi({
      [`GET ${ORG}/plugin-installs`]: () =>
        json(200, { installs: [{ ...INSTALL, status: "installing" }] }),
      [`DELETE ${ORG}/plugin-installs/i1`]: () =>
        json(409, { error: { code: "plugin.install_in_progress", message: "x" } }),
    });
    renderPage(<PluginsPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: en.catalog.plugins.cleanup }));
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: en.catalog.plugins.confirm.confirm,
      }),
    );
    expect(await screen.findByText(`✗ ${en.catalog.plugins.inProgress}`)).toBeTruthy();
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

describe("/admin/marketplaces (SettingsPage)", () => {
  it.each(LOCALES)(
    "官方地址只读、离线模式说明；企业清单可改，显示状态与刷新（%s）",
    async (locale) => {
      const s = msgs[locale].catalog.admin.marketplaces;
      stubApi({
        "GET /api/v1/admin/marketplaces": () => json(200, SOURCES),
        "POST /api/v1/admin/marketplaces/s2/refresh": () =>
          json(200, { ...SOURCES.items[1], lastStatus: "ok", lastError: null }),
      });
      renderPage(<MarketplacesPage />, { locale });
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

describe("/admin/catalog and marketplace entries", () => {
  const item = (over: Record<string, unknown>) => ({
    id: ID,
    name: "cat-a",
    publisher: "Acme",
    displayName: null,
    description: "",
    policy: "allow",
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
    renderPage(<AdminCatalogPage />);
    const table = await screen.findByRole("table", { name: t.admin.title });
    const row = (name: string) => within(table).getByText(name).closest("tr") as HTMLElement;
    expect(within(row("cat-a")).getByText(t.source.official)).toBeTruthy();
    expect(await within(row("cat-a")).findByText(t.newer)).toBeTruthy();
    expect(within(row("manual-skill")).getByText(t.source.manual)).toBeTruthy();
    expect(within(row("manual-skill")).queryByText(t.newer)).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "Kind" })).toBeNull();
    expect(screen.getByRole("link", { name: t.admin.actions.import }).getAttribute("href")).toBe(
      "/admin/catalog/import",
    );
    await userEvent.setup().click(screen.getByRole("radio", { name: t.source.manual }));
    expect(within(table).queryByText("cat-a")).toBeNull();
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
    renderPage(<MarketplaceEntriesPage />);
    expect(await screen.findByText(c.truncated)).toBeTruthy();
    expect(screen.getByText(fill(c.incompatible, { version: "3.0.0" }))).toBeTruthy();
    const table = screen.getByRole("table", { name: c.title });
    const row = (name: string) => within(table).getByText(name).closest("tr") as HTMLElement;
    const git = row("git-a");
    const notAllowed = fill(c.reason.host_not_allowed, { host: "github.com" });
    expect(within(git).getByText(notAllowed)).toBeTruthy();
    expect(within(git).getByText("https://github.com/acme/git-a.git")).toBeTruthy();
    const user = userEvent.setup();
    await user.click(within(git).getAllByRole("button").at(-1) as HTMLElement);
    const item = await screen.findByRole("menuitem", { name: notAllowed });
    expect(
      item.getAttribute("aria-disabled") === "true" || item.hasAttribute("data-disabled"),
    ).toBe(true);
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
    renderPage(<MarketplaceEntriesPage />);
    const table = await screen.findByRole("table", { name: c.title });
    const user = userEvent.setup();
    const importIt = async () => {
      await user.click(within(table).getAllByRole("button").at(-1) as HTMLElement);
      await user.click(
        await screen.findByRole("menuitem", { name: fill(c.importVersion, { version: "2.0.0" }) }),
      );
    };
    await importIt();
    expect(await screen.findByText(`✗ ${en.errors.marketplace.integrity_mismatch}`)).toBeTruthy();
    fail = false;
    await importIt();
    await waitFor(() =>
      expect(router.push).toHaveBeenCalledWith("/admin/catalog/import?staging=st9"),
    );
    expect(bodyOf(calls.filter((x) => x.method === "POST").at(-1))).toEqual({ version: "2.0.0" });
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
                  sdk: "^0.1.0",
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
    renderPage(<AdminCatalogItemPage />);
    const ext = await screen.findByRole("region", { name: c.extension });
    expect(
      within(ext).getByText(fill(c.extensionVersion, { name: "crm", version: "1.0.0" })),
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
    expect(screen.getByRole("button", { name: en.catalog.admin.detail.deploy })).toBeTruthy();
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
    renderPage(<AdminCatalogItemPage />);
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
    renderPage(<AdminCatalogItemPage />);
    expect(await screen.findByText("@acme/crm")).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText(en.catalog.components.extensionNone)).toBeTruthy();
    expect(screen.queryByRole("button", { name: en.catalog.admin.detail.deploy })).toBeNull();
  });

  it("entries search is debounced: typing sends one request with the keyword", async () => {
    const calls = stubApi({
      "GET /api/v1/admin/marketplaces": () => json(200, SOURCES),
      "GET /api/v1/admin/marketplaces/entries": () =>
        json(200, { items: [entry()], truncated: false }),
    });
    renderPage(<MarketplaceEntriesPage />);
    await screen.findByText("@acme/plugin-cat-a");
    await userEvent
      .setup()
      .type(screen.getByRole("textbox", { name: en.catalog.admin.entries.search }), "cat-a");
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
      item: { id: ID, name: "pdf-tools", displayName: null },
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
            : [{ type: "catalog_request", id: "r1", createdAt: request.createdAt, request }],
          truncated: false,
        }),
      [`POST ${ORG}/catalog-requests/r1/decide`]: () => {
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
    renderPage(<ExtensionsPage />, { locale });
    await userEvent.setup().click(
      await screen.findByRole("switch", {
        name: fill(m.extensions.enableLabel, { plugin: "crm-core" }),
      }),
    );
    expect(await screen.findByText(`✗ ${m.errors.catalog.approval_required}`)).toBeTruthy();
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
    renderPage(<InstallPage />);
    const slug = (await screen.findByLabelText(en.catalog.org.install.slug, {
      exact: false,
    })) as HTMLInputElement;
    expect(slug.value).toBe("github_mcp");
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
    renderPage(<CatalogRequestsPage />);
    expect(await screen.findByText("Mia")).toBeTruthy();
    expect(screen.getByText(en.catalog.admin.requests.fields.requester)).toBeTruthy();
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
      renderPage(<MarketplacesPage />, { locale });
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
    renderPage(<MarketplacesPage />);
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
    renderPage(<MarketplaceEntriesPage />);
    const table = await screen.findByRole("table", { name: c.title });
    const row = (name: string) => within(table).getByText(name).closest("tr") as HTMLElement;
    expect(within(row("pinned")).getByText(fill(c.gitPinned, { commit: "89abcde" }))).toBeTruthy();
    expect(within(row("follows")).getByText(fill(c.gitFollows, { ref: "main" }))).toBeTruthy();
    expect(
      within(row("in-repo")).getByText(fill(c.pathSource, { path: "./plugins/x" })),
    ).toBeTruthy();
    expect(within(row("in-repo")).getByText(en.catalog.contentChanged)).toBeTruthy();
    expect(within(row("http-path")).getByText(c.reason.path_needs_git_marketplace)).toBeTruthy();
    const user = userEvent.setup();
    await user.click(within(row("in-repo")).getAllByRole("button").at(-1) as HTMLElement);
    await user.click(
      await screen.findByRole("menuitem", { name: fill(c.importChanged, { version: "1.0.0" }) }),
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
    renderPage(<MarketplaceEntriesPage />);
    const table = await screen.findByRole("table", { name: en.catalog.admin.entries.title });
    const user = userEvent.setup();
    await user.click(within(table).getAllByRole("button").at(-1) as HTMLElement);
    await user.click(
      await screen.findByRole("menuitem", {
        name: fill(en.catalog.admin.entries.importVersion, { version: "1.0.0" }),
      }),
    );
    expect(await screen.findByText(`✗ ${en.errors.marketplace.private_address}`)).toBeTruthy();
    expect(
      screen.getByText(`✗ ${fill(en.catalog.errorDetail.host, { host: "git.internal" })}`),
    ).toBeTruthy();
    // The kernel's English message is for logs and API users, not shown
    expect(screen.queryByText(`✗ ${message}`)).toBeNull();
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
    renderPage(<MarketplaceEntriesPage />);
    const table = await screen.findByRole("table", { name: en.catalog.admin.entries.title });
    const user = userEvent.setup();
    await user.click(within(table).getAllByRole("button").at(-1) as HTMLElement);
    await user.click(
      await screen.findByRole("menuitem", {
        name: fill(en.catalog.admin.entries.importVersion, { version: "1.0.0" }),
      }),
    );
    expect(await screen.findByText(`✗ ${en.errors.marketplace.redirect}`)).toBeTruthy();
    expect(screen.getByText(`✗ ${en.catalog.errorDetail.gitSuffix}`)).toBeTruthy();
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
      renderPage(<PluginImportPage />, { locale });
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
          fill(r.buildVersion, { version: "1.0.0+git.fedcba987654", pluginVersion: "1.0.0" }),
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
    renderPage(<PluginImportPage />);
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
    renderPage(<PluginImportPage />);
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
      renderPage(<PluginImportPage />, { locale });
      const user = userEvent.setup();
      await user.click(await screen.findByRole("radio", { name: r.sourceGit }));
      await user.type(screen.getByRole("textbox", { name: r.gitUrl }), "acme/crm");
      await user.type(screen.getByRole("textbox", { name: startsWith(r.gitRef) }), "v1.0.0");
      await user.type(screen.getByRole("textbox", { name: startsWith(r.gitPath) }), "plugins/crm");
      await user.click(screen.getByRole("button", { name: r.fetch }));
      expect(
        await screen.findByText(`✗ ${msgs[locale].errors.marketplace.git_failed}`),
      ).toBeTruthy();
      expect(
        screen.getByText(
          `✗ ${fill(ed.repo, { location: "github.com/acme/crm" })} · ${fill(ed.ref, { ref: "v1.0.0" })}`,
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
            policy: "allow",
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
    renderPage(<AdminCatalogItemPage />);
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
              policy: "allow",
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
    renderPage(<AdminCatalogPage />);
    const table = await screen.findByRole("table", { name: en.catalog.admin.title });
    expect(within(table).getByText(en.catalog.contentChanged)).toBeTruthy();
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
      renderPage(<PluginsPage />, { locale });
      expect(
        await screen.findByText(fill(m.plugins.upgradeAvailable, { version: "1.1.0" })),
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
        await screen.findByText(fill(m.upgrade.done, { name: "crm", version: "1.1.0" })),
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
    renderPage(<PluginsPage />);
    expect(await screen.findByText(m.plugins.deploymentPending)).toBeTruthy();
    expect(screen.getByText(new RegExp(`^${m.plugins.status.upgrading}`))).toBeTruthy();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: m.plugins.upgrade }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText(m.upgrade.noChanges)).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: m.upgrade.confirm }));
    expect(await within(dialog).findByText(`✗ ${en.errors.plugin.upgrade_stale}`)).toBeTruthy();
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
    renderPage(<OrgCatalogItemPage />);
    expect(
      await screen.findByText(fill(m.org.action.upgradeAvailable, { version: "1.1.0" })),
    ).toBeTruthy();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: m.org.action.upgrade }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText(fill(m.upgrade.versions, { from: "1.0.0", to: "1.1.0" }));
    await user.click(within(dialog).getByRole("button", { name: m.upgrade.confirm }));
    expect(await screen.findByText(m.upgrade.requested)).toBeTruthy();
  });

  const NO_INPUTS = {
    ...PREVIEW,
    components: [],
    inputs: { connectors: [], credentialsChanged: [], extensionConfig: false },
    templates: [],
  };

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
      renderPage(<PluginsPage />, { locale });
      const user = userEvent.setup();
      await user.click(await screen.findByRole("button", { name: m.plugins.upgrade }));
      const dialog = await screen.findByRole("dialog");
      await within(dialog).findByText(m.upgrade.noChanges);
      await user.click(within(dialog).getByRole("button", { name: m.upgrade.confirm }));
      const inDep = fill(m.org.install.failedIn, { dependency: "crm-core" });
      expect(
        await within(dialog).findByText(
          `✗ ${fill(m.upgrade.failed, { step: m.org.install.step.skills, code: "internal", version: "1.0.0" })} ${inDep}`,
        ),
      ).toBeTruthy();
      expect(within(dialog).getByText("✗ skills.notes: bad file")).toBeTruthy();
      expect(within(dialog).queryByText(/English cause/)).toBeNull();
      rolledBack = false;
      await user.click(within(dialog).getByRole("button", { name: m.upgrade.confirm }));
      expect(
        await within(dialog).findByText(
          `✗ ${fill(m.upgrade.failedNoRollback, { step: m.org.install.step.skills, code: "internal" })} ${inDep}`,
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
      renderPage(<PluginsPage />, { locale });
      const user = userEvent.setup();
      await user.click(await screen.findByRole("button", { name: m.catalog.plugins.upgrade }));
      const dialog = await screen.findByRole("dialog");
      expect(
        await within(dialog).findByText(
          `✗ ${fill(m.catalog.errorDetail.deploymentVersion, { deploymentVersion: "0.1.0", allowedVersion: "0.1.0" })}`,
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
          `✗ ${fill(m.catalog.errorDetail.dependentRange, { dependent: "app", range: "^1.0.0", version: "2.0.0" })}`,
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
    renderPage(<PluginsPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: m.plugins.upgrade }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText(m.upgrade.noChanges);
    const confirm = () =>
      within(dialog).getByRole("button", { name: m.upgrade.confirm }) as HTMLButtonElement;
    await user.click(confirm());
    await within(dialog).findByText(`✗ ${en.errors.plugin.upgrade_stale}`);
    await waitFor(() => expect(previews).toBe(2));
    expect(confirm().disabled).toBe(true);
    release();
    await waitFor(() => expect(confirm().disabled).toBe(false));
  });

  it("catalog item: members see the upgrade but no button", async () => {
    params.current = { itemId: ID };
    stubApi({ [`GET ${ORG}/catalog/${ID}`]: () => json(200, DETAIL) });
    renderPage(<OrgCatalogItemPage />, { me: MEMBER });
    expect(
      await screen.findByText(fill(en.catalog.org.action.upgradeAvailable, { version: "1.1.0" })),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: en.catalog.org.action.upgrade })).toBeNull();
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
      renderPage(<InstallPage />, { locale });
      await screen.findByText(m.catalog.org.install.summary);
      await userEvent
        .setup()
        .click(screen.getByRole("button", { name: m.catalog.org.install.submit }));
      expect(await screen.findByText(`✗ ${m.errors.plugin.skill_conflict}`)).toBeTruthy();
      expect(
        screen.getByText(`✗ ${fill(m.catalog.components.skillConflictOrg, { skill: "notes" })}`),
      ).toBeTruthy();
      expect(
        screen.getByText(
          `✗ ${fill(m.catalog.components.skillConflictPlugin, { skill: "extra", plugin: "other 2.0.0" })}`,
        ),
      ).toBeTruthy();
      expect(
        screen.getByText(
          `✗ ${fill(m.catalog.components.skillConflictPlugin, { skill: "more", plugin: "legacy" })}`,
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
      renderPage(<PluginImportPage />, { locale });
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

  it("an empty group says so", async () => {
    const tr = en.catalog.admin.review.translation;
    stage({
      ...CLAUDE_REVIEW,
      translation: {
        ...CLAUDE_REVIEW.translation,
        items: CLAUDE_REVIEW.translation.items.slice(0, 1),
      },
    });
    renderPage(<PluginImportPage />);
    const warnings = await screen.findByRole("region", {
      name: fill(tr.groupTitle, { group: tr.groups.warnings, n: 0 }),
    });
    expect(within(warnings).getByText(tr.groupNone)).toBeTruthy();
  });

  it("suggest pinned checkboxes are sent as pinnedSuggestions on confirm", async () => {
    const tr = en.catalog.admin.review.translation;
    const calls = stage(CLAUDE_REVIEW);
    renderPage(<PluginImportPage />);
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
      deployExtension: false,
      pinnedSuggestions: ["brainstorming"],
    });
  });

  it("confirming the plugin's own suggestion unchanged omits pinnedSuggestions; unticking every suggested skill sends [] (batch-3 m1)", async () => {
    const tr = en.catalog.admin.review.translation;
    const confirmWith = async (untick: boolean) => {
      const calls = stage(CLAUDE_REVIEW);
      renderPage(<PluginImportPage />);
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
    expect(await confirmWith(false)).toEqual({ reviewHash: "h1", deployExtension: false });
    expect(await confirmWith(true)).toEqual({
      reviewHash: "h1",
      deployExtension: false,
      pinnedSuggestions: [],
    });
  });

  it("with a SessionStart hook the pinned suggestion is open and shows the hint", async () => {
    const tr = en.catalog.admin.review.translation;
    stage({
      ...CLAUDE_REVIEW,
      translation: { ...CLAUDE_REVIEW.translation, sessionStart: true },
    });
    renderPage(<PluginImportPage />);
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
    renderPage(<PluginImportPage />);
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
    renderPage(<PluginImportPage />);
    expect(await screen.findByText(tr.licenseTruncated)).toBeTruthy();
    expect(screen.getByText(tr.claudeManifestIgnored)).toBeTruthy();
    expect(screen.queryByRole("button", { name: tr.license })).toBeNull();
  });

  it("a native plugin review shows no translation section but still offers the pinned suggestion", async () => {
    const tr = en.catalog.admin.review.translation;
    stage({ ...REVIEW, extension: undefined, sensitive: false, format: "capybara" });
    renderPage(<PluginImportPage />);
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
  it("item detail: a Claude Code version shows its format, report and license; the versions table has a format column", async () => {
    params.current = { itemId: ID };
    const tr = en.catalog.admin.review.translation;
    const d = en.catalog.admin.detail;
    stubApi({
      [`GET /api/v1/admin/catalog/items/${ID}`]: () =>
        json(200, {
          item: {
            id: ID,
            name: "superpowers",
            publisher: "Jesse Vincent",
            displayName: null,
            description: "",
            policy: "allow",
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
            },
          ],
          hasIcon: false,
        }),
      "GET /api/v1/admin/marketplaces": () => json(200, SOURCES),
      "GET /api/v1/admin/catalog/items": () => json(200, { items: [], nextOffset: null }),
    });
    renderPage(<AdminCatalogItemPage />);
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
      renderPage(<MarketplacesPage />, { locale });
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
    renderPage(<MarketplacesPage />);
    expect(await screen.findByText("1 entry was skipped by the last refresh")).toBeTruthy();
    cleanup();
    vi.unstubAllGlobals();

    const many = Array.from({ length: 25 }, () => ({ name: "dup", reason: "invalid_entry" }));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    stubApi(routes(many));
    renderPage(<MarketplacesPage />);
    expect(await screen.findByText("25 entries were skipped by the last refresh")).toBeTruthy();
    const line = fill(s.skipped.line, { name: "dup", reason: s.skipped.reasons.invalid_entry });
    expect(screen.getAllByText(line)).toHaveLength(20);
    expect(screen.getByText(fill(s.skipped.more, { n: 5 }))).toBeTruthy();
    // no duplicate React keys
    expect(errors.mock.calls.some((c) => String(c[0]).includes("same key"))).toBe(false);
  });
});
