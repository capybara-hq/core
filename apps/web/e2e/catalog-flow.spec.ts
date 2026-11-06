import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { signIn } from "./support/sign-in";

/** UI copy comes from the zh messages file, so it is not hard-coded twice. */
const zh = JSON.parse(
  readFileSync(new URL("../messages/zh.json", import.meta.url), "utf8"),
) as typeof import("../messages/zh.json");

const CSRF = { "X-Capybara-Csrf": "1" };
const D = zh.catalog;
const P = zh.plugins;
const fill = (s: string, vars: Record<string, string | number>) =>
  s.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k]));

/** The entries list's object row of an entry (its name, source and version are on the row). */
const entryRow = (page: Page, text: string) =>
  page.getByRole("list", { name: D.admin.entries.title }).getByRole("listitem").filter({
    hasText: text,
  });

/** Imports one marketplace entry: its row action "引入 v1.0.0", then the review opens staged. */
async function importEntry(page: Page, pkg: string): Promise<void> {
  await page.goto("/admin/plugins/market");
  const row = entryRow(page, pkg);
  await expect(row).toBeVisible();
  await row
    .getByRole("button", { name: fill(D.admin.entries.importVersion, { version: "v1.0.0" }) })
    .click();
  await expect(page).toHaveURL(/\/admin\/plugins\/import\?staging=/, { timeout: 60_000 });
  await expect(page.locator('[data-template="WizardPage"]')).toBeVisible();
}

test("catalog: refresh the official marketplace -> import a dependency plugin with its extension and a plugin that depends on it, each in one review -> the org 插件 page turns it on through the input wizard, installing the dependency too -> turning it off previews the kept components", async ({
  page,
}) => {
  await signIn(page);

  // 1. Marketplaces: the official URL is read-only; refresh fetches the fake marketplace.json
  await page.goto("/admin/plugins/sources");
  await expect(page.locator('[data-template="ListPage"]')).toBeVisible();
  await page.getByRole("button", { name: D.admin.marketplaces.refresh }).first().click();
  await expect(page.getByText(/3 个条目/)).toBeVisible({ timeout: 30_000 });

  // 2. Entries: the git entry on github.com is listed but outside marketplaces.allowedHosts
  await page.goto("/admin/plugins/market");
  const gitRow = entryRow(page, "crm-next");
  await expect(
    gitRow.getByText(fill(D.admin.entries.reason.host_not_allowed, { host: "github.com" })),
  ).toBeVisible();

  // 3. Import crm-core: its extension is reviewed and installed on the deployment
  await importEntry(page, "@test/plugin-crm-core");
  const ext = page.getByRole("region", { name: D.components.extension });
  await expect(
    ext.getByText(fill(D.admin.review.action.install, { version: "v1.0.0" })),
  ).toBeVisible();
  await page.getByRole("button", { name: zh.admin.extensions.wizard.next }).click();
  // Confirming installs the extension; the scope defaults to 组织自选
  await expect(page.getByText(D.admin.review.deployOn)).toBeVisible();
  await expect(page.getByRole("radio", { name: new RegExp(D.scope.optional) })).toBeChecked();
  await page.getByRole("button", { name: D.admin.review.confirm }).click();
  await expect(page).toHaveURL(/\/admin\/plugins\/[0-9a-f-]{36}$/, { timeout: 60_000 });

  // 4. Import crm: one review of its skill, template and dependency (resolved to crm-core 1.0.0)
  await importEntry(page, "@acme/plugin-crm");
  await expect(
    page.getByRole("region", { name: D.components.dependencies }).getByText(
      fill(D.components.dependencyResolved, {
        name: "crm-core",
        range: "^1.0.0",
        version: "v1.0.0",
      }),
    ),
  ).toBeVisible();
  await expect(page.getByText("docs · fake-connector / mcp")).toBeVisible();
  await expect(
    page.getByRole("region", { name: D.components.skills }).getByText(/^crm-notes · /),
  ).toBeVisible();
  await page.getByRole("button", { name: zh.admin.extensions.wizard.next }).click();
  // No extension: nothing to install on the deployment
  await expect(page.getByText(D.admin.review.noExtension)).toBeVisible();
  await page.getByRole("button", { name: D.admin.review.confirm }).click();
  await expect(page).toHaveURL(/\/admin\/plugins\/[0-9a-f-]{36}$/);
  await expect(page.locator('[data-template="DetailPage"]')).toBeVisible();
  // The icon is shown as <img> through the kernel route; the components are listed
  await expect(page.getByRole("img", { name: fill(D.iconAlt, { name: "crm" }) })).toBeVisible();
  await expect(page.getByRole("region", { name: D.components.dependencies })).toContainText(
    "crm-core",
  );

  // 5. Enable crm-core in this org first (it is "pre-existing" at uninstall and kept); wait until
  //    the extension is loaded on the deployment
  const me = await page.request.get("/api/v1/me");
  const orgId = ((await me.json()) as { currentOrgId: string }).currentOrgId;
  await expect
    .poll(
      async () => {
        const r = await page.request.put(`/api/v1/orgs/${orgId}/extensions/crm-core`, {
          headers: CSRF,
          data: { enabled: true },
        });
        return r.status();
      },
      { timeout: 60_000 },
    )
    .toBe(200);

  // 6. The org's 插件 page: crm is off and asks for input -> the enable wizard
  await page.goto("/plugins");
  const appRow = page.getByRole("listitem").filter({ hasText: "CRM 套件" });
  await expect(appRow.getByRole("link", { name: P.action.enable })).toBeVisible({
    timeout: 60_000,
  });
  await appRow.getByRole("link", { name: P.action.enable }).click();
  await expect(page).toHaveURL(/\/plugins\/[0-9a-f-]{36}\/enable$/);
  // The connector step: url is editable (the template's only field), no auth
  await expect(page.getByLabel("url", { exact: true })).toBeEditable();
  await expect(page.getByText(D.org.install.noneHint)).toBeVisible();
  await page.getByRole("button", { name: D.org.install.next }).click();
  // Confirm: crm-core is installed with it
  await expect(page.getByText(D.org.install.summaryDependencies)).toBeVisible();
  await page.getByRole("button", { name: D.org.install.submit }).click();

  // 7. The plugin's page: its install lists crm-core as a dependency; turning crm off previews
  //    what goes (the dependency install, its skill) and what stays (the crm-core extension,
  //    enabled before the install), then removes it
  await expect(page).toHaveURL(/\/plugins\/[0-9a-f-]{36}$/, { timeout: 60_000 });
  const card = page.getByRole("region", { name: "crm v1.0.0", exact: true });
  await expect(
    card.getByText(`· ${D.plugins.componentKind.plugin} crm-core — ${D.plugins.created}`),
  ).toBeVisible();
  await page.getByRole("button", { name: P.action.disable }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByText(
      `· ${D.plugins.componentKind.extension} crm-core — ${D.plugins.report.reason.pre_existing}`,
    ),
  ).toBeVisible();
  await expect(dialog.getByText(`− ${D.plugins.componentKind.plugin} crm-core`)).toBeVisible();
  await expect(dialog.getByText(new RegExp(`− ${D.plugins.componentKind.skill} `))).toBeVisible();
  await dialog.getByRole("button", { name: P.switchOff.confirm }).click();
  await expect(page.getByText(P.state.off, { exact: true }).first()).toBeVisible({
    timeout: 60_000,
  });
});

/** Imports `notes <version>` from the git marketplace's entries and confirms the review. */
async function importNotes(page: Page, version: string): Promise<void> {
  await page.goto("/admin/plugins/market");
  await page.getByRole("tab", { name: "Team git" }).click();
  const importIt = page.getByRole("button", {
    name: fill(D.admin.entries.importVersion, { version: `v${version}` }),
    exact: true,
  });
  // The entry shows the plugin's display name (笔记), not only its id
  const row = page.getByRole("listitem").filter({ has: importIt }).filter({ hasText: "笔记" });
  // A git entry pinned to a commit of the notes repository
  await expect(
    row.getByText(new RegExp(fill(D.admin.entries.gitPinned, { commit: "[0-9a-f]{7}" }))),
  ).toBeVisible();
  await importIt.click();
  await expect(page).toHaveURL(/\/admin\/plugins\/import\?staging=/, { timeout: 60_000 });
  // The review names where it was read from (the marketplace repository at its commit)
  await expect(page.getByText(/127\.0\.0\.1/).first()).toBeVisible();
  await page.getByRole("button", { name: zh.admin.extensions.wizard.next }).click();
  await page.getByRole("button", { name: D.admin.review.confirm }).click();
  await expect(page).toHaveURL(/\/admin\/plugins\/[0-9a-f-]{36}$/, { timeout: 60_000 });
}

test("git marketplace: add a repository in the admin console -> refresh -> import notes 1.0.0 -> turn it on in the org -> import 1.1.0 -> update the platform plugin from its admin page with a preview", async ({
  page,
}) => {
  const gitUrl = process.env.CAPYBARA_E2E_GIT_MARKETPLACE_URL as string;
  const m = D.admin.marketplaces;
  await signIn(page);

  // 1. Add the git repository as a marketplace, then refresh it (two entries)
  await page.goto("/admin/plugins/sources");
  const add = page.getByRole("region", { name: m.add });
  await add.getByRole("radio", { name: m.formGit }).check();
  await add.getByRole("textbox", { name: m.name }).fill("Team git");
  await add.getByRole("textbox", { name: m.url }).fill(gitUrl);
  await add.getByRole("button", { name: m.add }).click();
  await expect(page.getByText(fill(m.added, { name: "Team git" }))).toBeVisible();
  await expect(page.getByText(fill(m.gitInfo, { ref: m.defaultBranch }))).toBeVisible();
  await page.getByRole("button", { name: m.refresh }).last().click();
  await expect(page.getByText(/2 个条目/)).toBeVisible({ timeout: 30_000 });
  await expect(
    page.getByText(new RegExp(fill(m.lastCommit, { commit: "[0-9a-f]{7}" }))),
  ).toBeVisible();

  // 2. Import notes 1.0.0 and turn it on in the org (a skills-only plugin: no input)
  await importNotes(page, "1.0.0");
  await page.goto("/plugins");
  const row = page.getByRole("listitem").filter({ hasText: "notes" });
  await row.getByRole("button", { name: P.action.enable }).click();
  await expect(row.getByText(P.state.on, { exact: true })).toBeVisible({ timeout: 60_000 });
  await row.getByRole("link", { name: "notes", exact: true }).click();
  await expect(page).toHaveURL(/\/plugins\/[0-9a-f-]{36}$/);
  const detail = page.url();
  await expect(page.getByRole("region", { name: "notes v1.0.0", exact: true })).toBeVisible();

  // 3. Import 1.1.0 (the import does not move the platform), then update the platform plugin
  // from its admin page: the preview lists each component's change (ruling F2: one version for
  // the deployment; the org upgrade is gone)
  await importNotes(page, "1.1.0");
  await page
    .getByRole("button", { name: fill(D.admin.detail.actions.update, { version: "v1.1.0" }) })
    .click();
  const dialog = page.getByRole("dialog");
  const changes = dialog.getByRole("table", { name: D.update.components });
  await expect(
    changes.getByRole("row").filter({ hasText: "notes-extra" }).getByText(D.update.change.added),
  ).toBeVisible();
  await expect(
    changes
      .getByRole("row")
      .filter({ hasText: /^notes(?!-)/ })
      .getByText(D.update.change.upgrade),
  ).toBeVisible();
  await dialog.getByRole("button", { name: D.update.confirm }).click();
  await expect(
    page.getByText(fill(D.update.done, { name: "笔记", version: "v1.1.0" })),
  ).toBeVisible({ timeout: 60_000 });
  // The org's install moved with the platform
  await page.goto(detail);
  const upgraded = page.getByRole("region", { name: "notes v1.1.0", exact: true });
  await expect(upgraded).toBeVisible({ timeout: 60_000 });

  // 4. Clean up: turn it off (the skills it created go with it)
  await page.getByRole("button", { name: P.action.disable }).click();
  await page.getByRole("dialog").getByRole("button", { name: P.switchOff.confirm }).click();
  await expect(upgraded).toHaveCount(0, { timeout: 60_000 });
});
