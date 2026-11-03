import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { signIn } from "./support/sign-in";

/** UI copy comes from the zh messages file, so it is not hard-coded twice. */
const zh = JSON.parse(
  readFileSync(new URL("../messages/zh.json", import.meta.url), "utf8"),
) as typeof import("../messages/zh.json");

const CSRF = { "X-Capybara-Csrf": "1" };
const D = zh.catalog;
const fill = (s: string, vars: Record<string, string | number>) =>
  s.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k]));

/** The entries list's object row of an entry (its name, source and version are on the row). */
const entryRow = (page: Page, text: string) =>
  page.getByRole("list", { name: D.admin.entries.title }).getByRole("listitem").filter({
    hasText: text,
  });

/** Imports one marketplace entry: its row action "引入 v1.0.0", then the review opens staged. */
async function importEntry(page: Page, pkg: string): Promise<void> {
  await page.goto("/admin/marketplaces/entries");
  const row = entryRow(page, pkg);
  await expect(row).toBeVisible();
  await row
    .getByRole("button", { name: fill(D.admin.entries.importVersion, { version: "v1.0.0" }) })
    .click();
  await expect(page).toHaveURL(/\/admin\/catalog\/import\?staging=/, { timeout: 60_000 });
  await expect(page.locator('[data-template="WizardPage"]')).toBeVisible();
}

test("catalog: refresh the official marketplace -> import a dependency plugin with its extension and a plugin that depends on it, each in one review -> org install wizard installs the dependency too -> uninstall shows the kept components", async ({
  page,
}) => {
  await signIn(page);

  // 1. Marketplaces: the official URL is read-only; refresh fetches the fake marketplace.json
  await page.goto("/admin/marketplaces");
  await expect(page.locator('[data-template="ListPage"]')).toBeVisible();
  await page.getByRole("button", { name: D.admin.marketplaces.refresh }).first().click();
  await expect(page.getByText(/3 个条目/)).toBeVisible({ timeout: 30_000 });

  // 2. Entries: the git entry on github.com is listed but outside marketplaces.allowedHosts
  await page.goto("/admin/marketplaces/entries");
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
  await expect(page.getByText(D.admin.review.deployOff)).toBeVisible();
  await page.getByRole("checkbox", { name: D.admin.review.deployExtension }).check();
  await page.getByRole("button", { name: D.admin.review.confirm }).click();
  await expect(page).toHaveURL(/\/admin\/catalog\/[0-9a-f-]{36}$/, { timeout: 60_000 });

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
  await expect(page).toHaveURL(/\/admin\/catalog\/[0-9a-f-]{36}$/);
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

  // 6. Org catalog: crm is installable -> install wizard
  await page.goto("/catalog");
  const appRow = page.getByRole("listitem").filter({ hasText: "CRM 套件" });
  await expect(appRow.getByRole("link", { name: D.org.action.install })).toBeVisible({
    timeout: 60_000,
  });
  await appRow.getByRole("link", { name: D.org.action.install }).click();
  await expect(page).toHaveURL(/\/catalog\/[0-9a-f-]{36}\/install$/);
  // The connector step: url is editable (the template's only field), no auth
  await expect(page.getByLabel("url", { exact: true })).toBeEditable();
  await expect(page.getByText(D.org.install.noneHint)).toBeVisible();
  await page.getByRole("button", { name: D.org.install.next }).click();
  // Confirm: crm-core is installed with it
  await expect(page.getByText(D.org.install.summaryDependencies)).toBeVisible();
  await page.getByRole("button", { name: D.org.install.submit }).click();

  // 7. Installed plugins: crm-core is listed as crm's dependency; uninstalling crm removes the
  //    dependency install and keeps the crm-core extension, enabled before the install
  await expect(page).toHaveURL(/\/settings\/plugins$/, { timeout: 60_000 });
  await expect(page.getByText(fill(D.plugins.dependencyOf, { names: "crm" }))).toBeVisible();
  await page
    .getByRole("region", { name: "crm v1.0.0", exact: true })
    .getByRole("button", { name: D.plugins.uninstall })
    .click();
  await page.getByRole("dialog").getByRole("button", { name: D.plugins.confirm.confirm }).click();
  const report = page.getByRole("region", { name: fill(D.plugins.report.title, { name: "crm" }) });
  await expect(report).toBeVisible();
  await expect(
    report.getByText(
      `· ${D.plugins.componentKind.extension} crm-core — ${D.plugins.report.reason.pre_existing}`,
    ),
  ).toBeVisible();
  await expect(report.getByText(`− ${D.plugins.componentKind.plugin} crm-core`)).toBeVisible();
  await expect(report.getByText(new RegExp(`− ${D.plugins.componentKind.skill} `))).toBeVisible();
  await expect(page.getByText(D.plugins.empty)).toBeVisible();
});

/** Imports `notes <version>` from the git marketplace's entries and confirms the review. */
async function importNotes(page: Page, version: string): Promise<void> {
  await page.goto("/admin/marketplaces/entries");
  await page.getByRole("tab", { name: "Team git" }).click();
  const importIt = page.getByRole("button", {
    name: fill(D.admin.entries.importVersion, { version: `v${version}` }),
    exact: true,
  });
  const row = page.getByRole("listitem").filter({ has: importIt });
  // A git entry pinned to a commit of the notes repository
  await expect(
    row.getByText(new RegExp(fill(D.admin.entries.gitPinned, { commit: "[0-9a-f]{7}" }))),
  ).toBeVisible();
  await importIt.click();
  await expect(page).toHaveURL(/\/admin\/catalog\/import\?staging=/, { timeout: 60_000 });
  // The review names where it was read from (the marketplace repository at its commit)
  await expect(page.getByText(/127\.0\.0\.1/).first()).toBeVisible();
  await page.getByRole("button", { name: zh.admin.extensions.wizard.next }).click();
  await page.getByRole("button", { name: D.admin.review.confirm }).click();
  await expect(page).toHaveURL(/\/admin\/catalog\/[0-9a-f-]{36}$/, { timeout: 60_000 });
}

test("git marketplace: add a repository in the admin console -> refresh -> import notes 1.0.0 -> org install -> import 1.1.0 -> upgrade from the installed plugins with a preview", async ({
  page,
}) => {
  const gitUrl = process.env.CAPYBARA_E2E_GIT_MARKETPLACE_URL as string;
  const m = D.admin.marketplaces;
  await signIn(page);

  // 1. Add the git repository as a marketplace, then refresh it (two entries)
  await page.goto("/admin/marketplaces");
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

  // 2. Import notes 1.0.0 and install it in the org (a skills-only plugin: just confirm)
  await importNotes(page, "1.0.0");
  await page.goto("/catalog");
  const row = page.getByRole("listitem").filter({ hasText: "notes" });
  await row.getByRole("link", { name: D.org.action.install }).click();
  await expect(page).toHaveURL(/\/catalog\/[0-9a-f-]{36}\/install$/);
  await page.getByRole("button", { name: D.org.install.submit }).click();
  await expect(page).toHaveURL(/\/settings\/plugins$/, { timeout: 60_000 });
  await expect(page.getByRole("region", { name: "notes v1.0.0", exact: true })).toBeVisible();

  // 3. Import 1.1.0: the installed plugin offers the upgrade; the preview lists the changes
  await importNotes(page, "1.1.0");
  await page.goto("/settings/plugins");
  const card = page.getByRole("region", { name: "notes v1.0.0", exact: true });
  await expect(
    card.getByText(fill(D.plugins.upgradeAvailable, { version: "v1.1.0" })),
  ).toBeVisible();
  await card.getByRole("button", { name: D.plugins.upgrade }).click();
  const dialog = page.getByRole("dialog");
  const line = (change: "added" | "changed", ref: string) =>
    fill(D.upgrade.line, {
      change: D.upgrade.change[change],
      kind: D.plugins.componentKind.skill,
      ref,
    });
  await expect(dialog.getByText(line("added", "notes-extra"))).toBeVisible();
  await expect(dialog.getByText(line("changed", "notes"))).toBeVisible();
  await dialog.getByRole("button", { name: D.upgrade.confirm }).click();
  await expect(
    page.getByText(fill(D.upgrade.done, { name: "notes", version: "v1.1.0" })),
  ).toBeVisible({
    timeout: 60_000,
  });
  const upgraded = page.getByRole("region", { name: "notes v1.1.0", exact: true });
  await expect(upgraded).toBeVisible();
  await expect(upgraded.getByRole("button", { name: D.plugins.upgrade })).toHaveCount(0);

  // 4. Clean up: uninstall (the skills it created go with it)
  await upgraded.getByRole("button", { name: D.plugins.uninstall }).click();
  await page.getByRole("dialog").getByRole("button", { name: D.plugins.confirm.confirm }).click();
  await expect(page.getByText(D.plugins.empty)).toBeVisible();
});
