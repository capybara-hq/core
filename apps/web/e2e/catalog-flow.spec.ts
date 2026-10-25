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

/** Imports one marketplace entry: its row menu "Import 1.0.0", then the review opens staged. */
async function importEntry(page: Page, pkg: string): Promise<void> {
  await page.goto("/zh/admin/marketplaces/entries");
  const table = page.getByRole("table", { name: D.admin.entries.title });
  const row = table.getByRole("row").filter({ hasText: pkg });
  await expect(row).toBeVisible();
  await row.getByRole("button").last().click();
  await page
    .getByRole("menuitem", { name: fill(D.admin.entries.importVersion, { version: "1.0.0" }) })
    .click();
  await expect(page).toHaveURL(/\/zh\/admin\/catalog\/import\?staging=/, { timeout: 60_000 });
  await expect(page.locator('[data-template="WizardPage"]')).toBeVisible();
}

test("catalog: refresh the official marketplace -> import a dependency plugin with its extension and a plugin that depends on it, each in one review -> org install wizard installs the dependency too -> uninstall shows the kept components", async ({
  page,
}) => {
  await signIn(page);

  // 1. Marketplaces: the official URL is read-only; refresh fetches the fake marketplace.json
  await page.goto("/zh/admin/marketplaces");
  await expect(page.locator('[data-template="SettingsPage"]')).toBeVisible();
  await page.getByRole("button", { name: D.admin.marketplaces.refresh }).first().click();
  await expect(page.getByText(/3 个条目/)).toBeVisible({ timeout: 30_000 });

  // 2. Entries: the git entry is listed but needs git marketplaces (phase A)
  await page.goto("/zh/admin/marketplaces/entries");
  const gitRow = page
    .getByRole("table", { name: D.admin.entries.title })
    .getByRole("row")
    .filter({ hasText: "crm-next" });
  await expect(gitRow.getByText(D.admin.entries.needsGitMarketplaces)).toBeVisible();

  // 3. Import crm-core: its extension is reviewed and installed on the deployment
  await importEntry(page, "@test/plugin-crm-core");
  const ext = page.getByRole("region", { name: D.components.extension });
  await expect(
    ext.getByText(fill(D.admin.review.action.install, { version: "1.0.0" })),
  ).toBeVisible();
  await page.getByRole("button", { name: zh.admin.extensions.wizard.next }).click();
  await expect(page.getByText(D.admin.review.deployOff)).toBeVisible();
  await page.getByRole("checkbox", { name: D.admin.review.deployExtension }).check();
  await page.getByRole("button", { name: D.admin.review.confirm }).click();
  await expect(page).toHaveURL(/\/zh\/admin\/catalog\/[0-9a-f-]{36}$/, { timeout: 60_000 });

  // 4. Import crm: one review of its skill, template and dependency (resolved to crm-core 1.0.0)
  await importEntry(page, "@acme/plugin-crm");
  await expect(
    page.getByRole("region", { name: D.components.dependencies }).getByText(
      fill(D.components.dependencyResolved, {
        name: "crm-core",
        range: "^1.0.0",
        version: "1.0.0",
      }),
    ),
  ).toBeVisible();
  await expect(page.getByText("docs · connector-mcp / mcp")).toBeVisible();
  await expect(
    page.getByRole("region", { name: D.components.skills }).getByText(/crm-notes/),
  ).toBeVisible();
  await page.getByRole("button", { name: zh.admin.extensions.wizard.next }).click();
  // No extension: nothing to install on the deployment
  await expect(page.getByText(D.admin.review.noExtension)).toBeVisible();
  await page.getByRole("button", { name: D.admin.review.confirm }).click();
  await expect(page).toHaveURL(/\/zh\/admin\/catalog\/[0-9a-f-]{36}$/);
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
  await page.goto("/zh/catalog");
  const appRow = page.getByRole("row").filter({ hasText: "CRM 套件" });
  await expect(appRow.getByRole("button", { name: D.org.action.install })).toBeVisible({
    timeout: 60_000,
  });
  await appRow.getByRole("button", { name: D.org.action.install }).click();
  await expect(page).toHaveURL(/\/zh\/catalog\/[0-9a-f-]{36}\/install$/);
  // The connector step: url is editable (the template's only field), no auth
  await expect(page.getByLabel("url", { exact: true })).toBeEditable();
  await expect(page.getByText(D.org.install.noneHint)).toBeVisible();
  await page.getByRole("button", { name: D.org.install.next }).click();
  // Confirm: crm-core is installed with it
  await expect(page.getByText(D.org.install.summaryDependencies)).toBeVisible();
  await page.getByRole("button", { name: D.org.install.submit }).click();

  // 7. Installed plugins: crm-core is listed as crm's dependency; uninstalling crm removes the
  //    dependency install and keeps the crm-core extension, enabled before the install
  await expect(page).toHaveURL(/\/zh\/settings\/plugins$/, { timeout: 60_000 });
  await expect(page.getByText(fill(D.plugins.dependencyOf, { names: "crm" }))).toBeVisible();
  await page
    .getByRole("region", { name: "crm 1.0.0", exact: true })
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
