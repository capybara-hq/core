import { describeNestedBox, findNestedBoxes } from "@capybara-hq/design/reference";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { OrgPluginUploadDialog } from "../src/components/OrgPluginUploadDialog";
import type { Me } from "../src/lib/session";
import { bodyOf, json, lastStubRoutes, noContent, stubApi as stubApiOnly } from "./support/api";
import { resetNavigation, router } from "./support/navigation";
import { renderRouteWithCache } from "./support/query";
import { ME, renderPage } from "./support/render";
import type { Routes } from "./support/server";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
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

const ORG = "/api/v1/orgs/o1";
const ID = "11111111-1111-4111-8111-111111111111";
const ACME = { kind: "org", orgId: "o1", name: "Acme" } as const;
const MEMBER: Me = {
  ...ME,
  memberships: [{ ...ME.memberships[0], role: "member" } as Me["memberships"][number]],
};
const fill = (s: string, vars: Record<string, string | number>) =>
  s.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k]));

/** The reads every org 插件 page makes besides the catalog (answered empty). */
const DEFAULTS: Routes = {
  [`GET ${ORG}/extensions`]: () => json(200, { extensions: [] }),
  [`GET ${ORG}/marketplaces/entries`]: () => json(200, { items: [] }),
  [`GET ${ORG}/plugin-installs`]: () => json(200, { installs: [] }),
  [`GET ${ORG}/components`]: () => json(200, { components: [] }),
};
const stubApi = (routes: Routes) => stubApiOnly({ ...DEFAULTS, ...routes });

function orgItem(over: Record<string, unknown> = {}) {
  return {
    id: ID,
    name: "crm",
    publisher: "Acme",
    displayName: null,
    description: "CRM helpers",
    descriptionZh: null,
    policy: "allow",
    scope: "named",
    builtin: false,
    disabled: false,
    owner: { kind: "platform" },
    shareable: false,
    latestVersion: "1.0.0",
    versions: ["1.0.0"],
    source: "file",
    updatedAt: "2026-11-06T00:00:00.000Z",
    state: "on",
    switchable: true,
    notDeployed: false,
    installed: null,
    request: null,
    componentCounts: { extension: 0, skills: 1, connectorTemplates: 0, agentTemplates: 0 },
    sourceFormat: "capybara",
    ...over,
  };
}

const detailOf = (item: Record<string, unknown>) => ({
  item,
  hasIcon: false,
  extension: null,
  templates: [],
  dependencies: [],
  skills: ["skills/notes"],
});

const REVIEW = {
  name: "crm",
  version: "1.0.0",
  packageName: "@acme/plugin-crm",
  publisher: "Acme",
  description: "CRM plugin",
  extension: {
    name: "crm",
    version: "1.0.0",
    sha256: "a".repeat(64),
    action: "install",
    deployed: false,
    currentVersion: null,
    currentSha256: null,
    permissions: [],
    added: [],
    addedItems: [],
    removed: [],
    warnings: [],
    reviewHash: "p1",
    sensitive: false,
  },
  connectorTemplates: [],
  skills: [
    { name: "notes", description: "Notes", body: "# Notes", path: "skills/notes", files: 1 },
  ],
  dependencies: [],
  source: { kind: "file", ref: "upload" },
  provenance: { checked: false, reason: "not from npm" },
  contentDigest: "d".repeat(64),
  sensitive: false,
  reviewHash: "h1",
};

/** A review with everything that used to be a card: permission groups, a warning, a template. */
const FULL_REVIEW = {
  ...REVIEW,
  extension: {
    ...REVIEW.extension,
    sensitive: true,
    permissions: [
      {
        category: "tables",
        sensitive: true,
        items: ["crm_contacts"],
        entries: [{ value: "crm_contacts", sensitive: true }],
      },
    ],
    warnings: [
      {
        kind: "destructive_migration",
        sensitive: true,
        file: "migrations/0002_drop.sql",
        line: 3,
        statement: "DROP TABLE old;",
      },
    ],
  },
  connectorTemplates: [
    {
      id: "crm-api",
      displayName: { en: "CRM API" },
      description: "The CRM's API",
      plugin: "connector-openapi",
      connector: "openapi",
      endpoint: { url: "https://crm.example.com" },
      auth: { type: "none" },
      editableEndpoint: [],
      endpointChecked: true,
    },
  ],
  sensitive: true,
};

const renderPlugins = (opts: Parameters<typeof renderRouteWithCache>[2] = {}) =>
  renderRouteWithCache("/plugins", lastStubRoutes(), opts);
const renderItem = (opts: Parameters<typeof renderRouteWithCache>[2] = {}) => {
  params.current = { itemId: ID };
  return renderRouteWithCache(`/plugins/${ID}`, lastStubRoutes(), opts);
};

/** Opens 上传插件包 and uploads `file` in the dialog. */
async function uploadIn(file: File, locale: "zh" | "en" = "zh") {
  const m = { zh, en }[locale].plugins.upload;
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: m.action }));
  const dialog = await screen.findByRole("dialog");
  const input = dialog.querySelector('input[type="file"]') as HTMLInputElement;
  await user.upload(input, file);
  return { user, dialog };
}
const tgz = () => new File([new Uint8Array([1, 2, 3])], "crm.tgz");

beforeEach(() => {
  resetNavigation("/");
  params.current = {};
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** A long, multi-line description: detail pages show it in full (fix round 1). */
const LONG =
  "Use when a meeting ends.\nIt writes the minutes, lists the decisions and the follow-ups, and names who owns each one, so nothing said in the room is lost on the way out of it.";

describe("/plugins: 上传插件包", () => {
  it("org admins see 上传插件包; members do not", async () => {
    stubApi({ [`GET ${ORG}/catalog`]: () => json(200, { items: [] }) });
    await renderPlugins({ locale: "zh" });
    expect(await screen.findByRole("button", { name: zh.plugins.upload.action })).toBeTruthy();
    cleanup();
    stubApi({ [`GET ${ORG}/catalog`]: () => json(200, { items: [] }) });
    await renderPlugins({ locale: "zh", me: MEMBER });
    await screen.findByText(zh.plugins.empty);
    expect(screen.queryByRole("button", { name: zh.plugins.upload.action })).toBeNull();
  });

  it("the review is org-only with 可共享 off and the extension notice; confirm posts reviewHash and shareable; pending toasts", async () => {
    const m = zh.plugins.upload;
    const calls = stubApi({
      [`GET ${ORG}/catalog`]: () => json(200, { items: [] }),
      [`POST ${ORG}/catalog/uploads/file`]: () =>
        json(200, { stagingId: "st1", review: REVIEW, update: null }),
      [`POST ${ORG}/catalog/uploads/st1/confirm`]: () =>
        json(201, {
          item: orgItem({ owner: ACME, awaitingConfirmation: true, pendingVersion: "1.0.0" }),
          outcome: "pending",
        }),
      "GET /api/v1/me": () => json(200, ME),
    });
    await renderPlugins({ locale: "zh" });
    const { user, dialog } = await uploadIn(tgz());
    // the scope block is a titled section, its one fact as the help line
    const scope = await within(dialog).findByRole("region", { name: m.scope });
    expect(within(scope).getByText(m.scopeOnly)).toBeTruthy();
    // a notice in a Dialog is a warn line with its icon (spec §6.19), first in the body
    const notice = within(dialog).getByText(m.extensionNotice).closest('[data-part="callout"]');
    expect(notice?.getAttribute("data-framed")).toBe("false");
    expect(notice?.querySelector("svg")).not.toBeNull();
    // One box (acceptance item AB): the Dialog holds headings and rows, never a card
    expect(dialog.querySelector('[data-part="card"]')).toBeNull();
    expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
    const share = within(dialog).getByRole("switch", { name: m.shareable });
    expect(share.getAttribute("aria-checked")).toBe("false");
    // org mode: no scope picker, no pinned suggestions
    expect(within(dialog).queryByRole("radio")).toBeNull();
    await user.click(share);
    await user.click(within(dialog).getByRole("button", { name: m.confirm }));
    await waitFor(() =>
      expect(bodyOf(calls.find((c) => c.url.endsWith("/st1/confirm")))).toEqual({
        reviewHash: "h1",
        shareable: true,
      }),
    );
    expect(await screen.findByText(m.pending)).toBeTruthy();
  });

  it("the review in the Dialog: the extension a subsection, its permissions and the templates rows, the warning a warn line over its code", async () => {
    const tp = en.extensions;
    stubApi({
      [`GET ${ORG}/catalog`]: () => json(200, { items: [] }),
      [`POST ${ORG}/catalog/uploads/file`]: () =>
        json(200, { stagingId: "st9", review: FULL_REVIEW, update: null }),
      "GET /api/v1/me": () => json(200, ME),
    });
    await renderPlugins({ locale: "en" });
    const { dialog } = await uploadIn(tgz(), "en");
    const ext = await within(dialog).findByRole("region", { name: "crm" });
    expect(ext.getAttribute("data-part")).toBe("subsection");
    // the review's region keeps its name; the list inside it is named apart (no duplicate)
    const region = within(ext).getByRole("region", {
      name: fill(tp.permissionsLabel, { plugin: "crm" }),
    });
    const perms = within(region).getByRole("list", { name: tp.permissions });
    const db = within(perms).getByRole("group", { name: tp.category.tables });
    expect(within(db).getByText(tp.sensitive)).toBeTruthy();
    expect(within(db).getByText("· crm_contacts")).toBeTruthy();
    const warning = within(perms).getByRole("group", { name: tp.review.warnings });
    expect(within(warning).getByText(tp.review.warningsHint)).toBeTruthy();
    expect(warning.querySelector('[data-part="code-block"]')).not.toBeNull();
    const templates = within(dialog).getByRole("list", { name: en.catalog.components.templates });
    expect(within(templates).getByRole("group", { name: /^crm-api/ })).toBeTruthy();
    expect(dialog.querySelector('[data-part="card"]')).toBeNull();
    expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
  });

  it("a new version of the org's own plugin shows the update preview and sends no pinnedSuggestions", async () => {
    const m = en.plugins.upload;
    const calls = stubApi({
      [`GET ${ORG}/catalog`]: () =>
        json(200, { items: [orgItem({ owner: ACME, shareable: true })] }),
      [`POST ${ORG}/catalog/uploads/file`]: () =>
        json(200, {
          stagingId: "st2",
          review: { ...REVIEW, version: "1.1.0", extension: undefined, reviewHash: "h2" },
          update: {
            itemId: ID,
            name: "crm",
            from: "1.0.0",
            to: "1.1.0",
            components: [],
            extension: null,
            connectorOrgs: [],
            diffHash: "d2",
          },
        }),
      [`POST ${ORG}/catalog/uploads/st2/confirm`]: () =>
        json(201, { item: orgItem({ owner: ACME, latestVersion: "1.1.0" }), outcome: "updated" }),
      "GET /api/v1/me": () => json(200, ME),
    });
    await renderPlugins({ locale: "en" });
    const { user, dialog } = await uploadIn(tgz(), "en");
    expect(
      await within(dialog).findByText(
        fill(en.catalog.update.versions, { from: "v1.0.0", to: "v1.1.0" }),
      ),
    ).toBeTruthy();
    // the update preview sits under its heading in the Dialog, not in a card
    expect(within(dialog).getByRole("region", { name: m.updateTitle })).toBeTruthy();
    expect(dialog.querySelector('[data-part="card"]')).toBeNull();
    expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
    expect(within(dialog).queryByText(m.extensionNotice)).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: m.confirm }));
    await waitFor(() =>
      expect(bodyOf(calls.find((c) => c.url.endsWith("/st2/confirm")))).toEqual({
        reviewHash: "h2",
      }),
    );
  });

  it("confirm waits for the org catalog: a new version of an own plugin never sends shareable", async () => {
    const m = en.plugins.upload;
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    const calls = stubApi({
      // the dialog opened before the catalog was read (nothing cached): its read is held
      [`GET ${ORG}/catalog`]: async () => {
        await held;
        return json(200, { items: [orgItem({ owner: ACME, shareable: true })] });
      },
      [`POST ${ORG}/catalog/uploads/file`]: () =>
        json(200, {
          stagingId: "st3",
          review: { ...REVIEW, version: "1.2.0", extension: undefined, reviewHash: "h3" },
          update: null,
        }),
      [`POST ${ORG}/catalog/uploads/st3/confirm`]: () =>
        json(201, { item: orgItem({ owner: ACME }), outcome: "updated" }),
      "GET /api/v1/me": () => json(200, ME),
    });
    renderPage(<OrgPluginUploadDialog orgId="o1" me={ME} onClose={() => {}} />);
    const dialog = await screen.findByRole("dialog");
    const user = userEvent.setup();
    await user.upload(dialog.querySelector('input[type="file"]') as HTMLInputElement, tgz());
    await within(dialog).findByText(m.scope);
    const confirm = within(dialog).getByRole("button", { name: m.confirm });
    expect(confirm).toHaveProperty("disabled", true);
    expect(within(dialog).queryByRole("switch", { name: m.shareable })).toBeNull();
    release();
    await waitFor(() => expect(confirm).toHaveProperty("disabled", false));
    expect(within(dialog).queryByRole("switch", { name: m.shareable })).toBeNull();
    await user.click(confirm);
    await waitFor(() =>
      expect(bodyOf(calls.find((c) => c.url.endsWith("/st3/confirm")))).toEqual({
        reviewHash: "h3",
      }),
    );
  });

  it("the update preview names other orgs by the kernel's names, else as a count, never as ids", async () => {
    const preview = (orgNames?: Record<string, string>) => ({
      itemId: ID,
      name: "crm",
      from: "1.0.0",
      to: "1.1.0",
      components: [],
      extension: { from: "1.0.0", to: null, orgs: ["o1", "o7", "o8"], needsApproval: false },
      connectorOrgs: [],
      diffHash: "d4",
      ...(orgNames !== undefined && { orgNames }),
    });
    for (const [names, expected] of [
      [undefined, "Acme, 2 other organizations"],
      [{ o7: "Beta", o8: "Gamma" }, "Acme, Beta, Gamma"],
    ] as const) {
      stubApi({
        [`GET ${ORG}/catalog`]: () =>
          json(200, { items: [orgItem({ owner: ACME, shareable: true })] }),
        [`POST ${ORG}/catalog/uploads/file`]: () =>
          json(200, {
            stagingId: "st4",
            review: { ...REVIEW, version: "1.1.0", extension: undefined, reviewHash: "h4" },
            update: preview(names),
          }),
        "GET /api/v1/me": () => json(200, ME),
      });
      await renderPlugins({ locale: "en" });
      const { dialog } = await uploadIn(tgz(), "en");
      const line = await within(dialog).findByText(
        fill(en.catalog.update.extensionOrgs, { orgs: expected }),
        { exact: false },
      );
      expect(line.textContent).not.toContain("o7");
      cleanup();
    }
  });

  it("plugin.name_taken names the owner", async () => {
    stubApi({
      [`GET ${ORG}/catalog`]: () => json(200, { items: [] }),
      [`POST ${ORG}/catalog/uploads/file`]: () =>
        json(409, {
          error: {
            code: "plugin.name_taken",
            message: "x",
            details: [{ owner: { kind: "org", orgId: "o2", name: "Beta" } }],
          },
        }),
      "GET /api/v1/me": () => json(200, ME),
    });
    await renderPlugins({ locale: "zh" });
    const { dialog } = await uploadIn(tgz());
    expect(
      await within(dialog).findByText(fill(zh.catalog.components.nameTakenBy, { owner: "Beta" })),
    ).toBeTruthy();
  });
});

describe("/plugins: pending uploads", () => {
  it("an awaiting item reads 等待超级管理员确认 with 撤回, which withdraws it", async () => {
    let withdrawn = false;
    const calls = stubApi({
      [`GET ${ORG}/catalog`]: () =>
        json(200, {
          items: withdrawn
            ? []
            : [
                orgItem({
                  owner: ACME,
                  state: "off",
                  awaitingConfirmation: true,
                  pendingVersion: "1.0.0",
                }),
              ],
        }),
      [`DELETE ${ORG}/owned-plugins/${ID}/pending`]: () => {
        withdrawn = true;
        return noContent();
      },
    });
    await renderPlugins({ locale: "zh" });
    const list = await screen.findByRole("list", { name: zh.plugins.title });
    expect(within(list).getByText(zh.plugins.state.awaiting)).toBeTruthy();
    await userEvent
      .setup()
      .click(within(list).getByRole("button", { name: zh.plugins.action.withdraw }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/pending"))).toBe(true),
    );
    await waitFor(() => expect(screen.queryByText(zh.plugins.state.awaiting)).toBeNull());
  });

  it("a pending new version is said on the row; members see the state without 撤回", async () => {
    stubApi({
      [`GET ${ORG}/catalog`]: () =>
        json(200, {
          items: [orgItem({ owner: ACME, awaitingConfirmation: false, pendingVersion: "1.1.0" })],
        }),
    });
    await renderPlugins({ locale: "zh", me: MEMBER });
    const list = await screen.findByRole("list", { name: zh.plugins.title });
    expect(
      within(list).getByText(fill(zh.plugins.chips.pendingVersion, { version: "v1.1.0" })),
    ).toBeTruthy();
    expect(within(list).queryByRole("button", { name: zh.plugins.action.withdraw })).toBeNull();
  });
});

describe("/plugins/<id>: the org's own plugin", () => {
  it("shows 本组织上传; the 可共享 switch calls the route and reads the plugin again", async () => {
    let shareable = false;
    const calls = stubApi({
      [`GET ${ORG}/catalog/${ID}`]: () => json(200, detailOf(orgItem({ owner: ACME, shareable }))),
      [`PUT ${ORG}/owned-plugins/${ID}/shareable`]: (c) => {
        shareable = (bodyOf(c) as { shareable: boolean }).shareable;
        return noContent();
      },
    });
    await renderItem({ locale: "zh" });
    expect(await screen.findByText(zh.plugins.chips.ownUpload)).toBeTruthy();
    expect(screen.getByText(zh.plugins.owned.shareableHelp)).toBeTruthy();
    const sw = screen.getByRole("switch", { name: zh.plugins.owned.shareable });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    await userEvent.setup().click(sw);
    await waitFor(() =>
      expect(bodyOf(calls.find((c) => c.method === "PUT"))).toEqual({ shareable: true }),
    );
    await waitFor(() =>
      expect(
        screen
          .getByRole("switch", { name: zh.plugins.owned.shareable })
          .getAttribute("aria-checked"),
      ).toBe("true"),
    );
    expect(calls.some((c) => c.method === "GET" && c.url.endsWith(`/catalog/${ID}`))).toBe(true);
  });

  it("删除 previews the transfer with the orgs and the agents, then deletes with the preview's hash", async () => {
    const m = zh.plugins.delete;
    const calls = stubApi({
      [`GET ${ORG}/catalog/${ID}`]: () => json(200, detailOf(orgItem({ owner: ACME }))),
      [`GET ${ORG}/catalog`]: () => json(200, { items: [] }),
      [`POST ${ORG}/owned-plugins/${ID}/delete/preview`]: () =>
        json(200, {
          outcome: "transferred",
          orgs: [
            { id: "o2", name: "Beta" },
            { id: "o3", name: "Gamma" },
          ],
          agents: [{ id: "a1", name: "Sales bot" }],
          previewHash: "ph1",
        }),
      [`POST ${ORG}/owned-plugins/${ID}/delete`]: () => noContent(),
    });
    await renderItem({ locale: "zh" });
    const user = userEvent.setup();
    // 删除 is the head's ⋯ menu item (destructive)
    await user.click(await screen.findByRole("button", { name: zh.common.moreActions }));
    const item = await screen.findByRole("menuitem", { name: zh.plugins.action.delete });
    expect(item.getAttribute("data-danger")).toBe("true");
    await user.click(item);
    const dialog = await screen.findByRole("dialog");
    expect(
      await within(dialog).findByText(fill(m.transferred, { orgs: "Beta、Gamma" })),
    ).toBeTruthy();
    expect(within(dialog).getByText(/Sales bot/)).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: m.confirm }));
    await waitFor(() =>
      expect(bodyOf(calls.find((c) => c.url.endsWith(`/${ID}/delete`)))).toEqual({
        previewHash: "ph1",
      }),
    );
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/plugins"));
  });

  it("a plugin no other org uses says it cannot be undone", async () => {
    stubApi({
      [`GET ${ORG}/catalog/${ID}`]: () => json(200, detailOf(orgItem({ owner: ACME }))),
      [`POST ${ORG}/owned-plugins/${ID}/delete/preview`]: () =>
        json(200, { outcome: "removed", orgs: [], agents: [], previewHash: "ph2" }),
    });
    await renderItem({ locale: "en" });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: en.common.moreActions }));
    await user.click(await screen.findByRole("menuitem", { name: en.plugins.action.delete }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText(en.plugins.delete.removed)).toBeTruthy();
  });

  it("members see 本组织上传 and the state, without the switch's action or 删除", async () => {
    stubApi({
      [`GET ${ORG}/catalog/${ID}`]: () =>
        json(200, detailOf(orgItem({ owner: ACME, shareable: true }))),
    });
    await renderItem({ locale: "zh", me: MEMBER });
    expect(await screen.findByText(zh.plugins.chips.ownUpload)).toBeTruthy();
    const sw = screen.getByRole("switch", { name: zh.plugins.owned.shareable });
    expect(sw.hasAttribute("disabled")).toBe(true);
    expect(screen.queryByRole("button", { name: zh.plugins.action.delete })).toBeNull();
    expect(screen.queryByRole("button", { name: zh.common.moreActions })).toBeNull();
  });

  it("while 启用 runs from the head, its other buttons are disabled (never a dead click)", async () => {
    let answer: () => void = () => {};
    const held = new Promise<void>((r) => {
      answer = r;
    });
    stubApi({
      [`GET ${ORG}/catalog/${ID}`]: () =>
        json(200, detailOf(orgItem({ owner: ACME, state: "off", pendingVersion: "1.1.0" }))),
      [`PUT ${ORG}/catalog/${ID}/switch`]: async () => {
        await held;
        return json(200, { item: orgItem({ owner: ACME, state: "on" }) });
      },
    });
    await renderItem({ locale: "en" });
    const user = userEvent.setup();
    const enable = await screen.findByRole("button", { name: en.plugins.action.enable });
    const withdraw = screen.getByRole("button", { name: en.plugins.action.withdraw });
    expect((withdraw as HTMLButtonElement).disabled).toBe(false);
    await user.click(enable);
    await waitFor(() => expect(enable.getAttribute("aria-busy")).toBe("true"));
    expect((withdraw as HTMLButtonElement).disabled).toBe(true);
    await act(async () => answer());
    await waitFor(() => expect(enable.getAttribute("aria-busy")).toBeNull());
  });

  it("one centred column: the full description first, the facts as a KeyValue with the owner", async () => {
    stubApi({
      [`GET ${ORG}/catalog/${ID}`]: () =>
        json(200, detailOf(orgItem({ owner: ACME, description: LONG }))),
    });
    await renderItem({ locale: "zh" });
    await screen.findByText(zh.plugins.chips.ownUpload);
    expect(document.querySelector(".cb-body")?.getAttribute("data-layout")).toBe("single");
    // The head carries no description: the full text (line breaks kept) leads the facts block
    expect(document.querySelector('[data-part="page-header-description"]')).toBeNull();
    const block = document.querySelector('[data-part="detail-facts"]');
    const first = block?.querySelector(".cb-stack")?.firstElementChild;
    expect(first?.textContent).toBe(LONG);
    expect(first?.getAttribute("data-pre")).toBe("true");
    const facts = block?.querySelector('[data-part="key-value"]');
    expect(facts?.textContent).toContain(zh.catalog.org.detail.fields.owner);
    expect(facts?.textContent).toContain(zh.catalog.owner.self);
    // one view: no tab row; the version is the head's, not a fact again
    expect(document.querySelector('[data-part="page-tabs"]')).toBeNull();
    expect(facts?.textContent).not.toContain(zh.catalog.org.detail.fields.version);
  });
});
