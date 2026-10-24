import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { signIn } from "./support/sign-in";

/** 界面文案取自 zh 文案文件，避免与实现重复硬编码。 */
const zh = JSON.parse(
  readFileSync(new URL("../messages/zh.json", import.meta.url), "utf8"),
) as typeof import("../messages/zh.json");

const CSRF = { "X-Capybara-Csrf": "1" };
const D = zh.directory;
const fill = (s: string, vars: Record<string, string | number>) =>
  s.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k]));

test("企业目录：刷新官方清单 → 引入应用并一次审阅、装到部署 → 组织走安装向导 → 卸载后显示保留项", async ({
  page,
}) => {
  await signIn(page);

  // 1. 目录来源：官方地址只读，立即刷新拉到假清单
  await page.goto("/zh/admin/directory/sources");
  await expect(page.locator('[data-template="SettingsPage"]')).toBeVisible();
  await page.getByRole("button", { name: D.admin.sources.refresh }).first().click();
  await expect(page.getByText(/1 个条目/)).toBeVisible({ timeout: 30_000 });

  // 2. 浏览清单：引入应用 → 跳到审阅页（按清单下载、校验并暂存）
  await page.goto("/zh/admin/directory/catalog");
  const table = page.getByRole("table", { name: D.admin.catalog.title });
  const row = table.getByRole("row").filter({ hasText: "@acme/app-crm" });
  await expect(row).toBeVisible();
  await row.getByRole("button").last().click();
  await page
    .getByRole("menuitem", { name: fill(D.admin.catalog.importVersion, { version: "1.0.0" }) })
    .click();
  await expect(page).toHaveURL(/\/zh\/admin\/directory\/apps\/review\?/);
  await expect(page.locator('[data-template="WizardPage"]')).toBeVisible();

  // 3. 一次审阅：插件动作、连接器模板、技能
  await expect(
    page.getByText(fill(D.admin.review.action.install, { version: "1.0.0" })),
  ).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByText("docs · connector-mcp / mcp")).toBeVisible();
  await expect(page.getByText(/crm-notes/).first()).toBeVisible();
  await page.getByRole("button", { name: zh.admin.plugins.wizard.next }).click();

  // 4. 确认：说明不装到部署的后果；勾选「同时把插件装到部署」后确认
  await expect(page.getByText(D.admin.review.deployOff)).toBeVisible();
  await page.getByRole("checkbox", { name: D.admin.review.deployPlugins }).check();
  await page.getByRole("button", { name: D.admin.review.confirm }).click();
  await expect(page).toHaveURL(/\/zh\/admin\/directory\/[0-9a-f-]{36}$/);
  await expect(page.locator('[data-template="DetailPage"]')).toBeVisible();
  // 图标经内核路由以 <img> 显示
  await expect(page.getByRole("img", { name: fill(D.iconAlt, { name: "crm" }) })).toBeVisible();

  // 5. 先在本组织启用 crm-core（之后卸载时它是「原有」的，应保留）；等插件在部署上加载
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

  // 6. 组织目录：应用可装 → 详情 → 安装向导
  await page.goto("/zh/directory");
  const appRow = page.getByRole("row").filter({ hasText: "CRM 套件" });
  await expect(appRow.getByRole("button", { name: D.org.action.install })).toBeVisible({
    timeout: 60_000,
  });
  await appRow.getByRole("button", { name: D.org.action.install }).click();
  await expect(page).toHaveURL(/\/zh\/directory\/[0-9a-f-]{36}\/install$/);
  // 连接器一步：不可编辑的字段只读（本模板只有 url，可改），无认证
  await expect(page.getByLabel("url", { exact: true })).toBeEditable();
  await expect(page.getByText(D.org.install.noneHint)).toBeVisible();
  await page.getByRole("button", { name: D.org.install.next }).click();
  // 插件一步：crm-core 已在本组织启用
  await expect(
    page.getByText(fill(D.org.install.pluginEnabled, { name: "crm-core" })),
  ).toBeVisible();
  await page.getByRole("button", { name: D.org.install.next }).click();
  await page.getByRole("button", { name: D.org.install.submit }).click();

  // 7. 已安装的应用：卸载 → 报告列出移除项，crm-core 因安装前就有而保留
  await expect(page).toHaveURL(/\/zh\/settings\/apps$/, { timeout: 60_000 });
  await page.getByRole("button", { name: D.apps.uninstall }).click();
  await page.getByRole("dialog").getByRole("button", { name: D.apps.confirm.confirm }).click();
  const report = page.getByRole("region", { name: fill(D.apps.report.title, { name: "crm" }) });
  await expect(report).toBeVisible();
  await expect(
    report.getByText(
      `· ${D.apps.componentKind.extension} crm-core — ${D.apps.report.reason.pre_existing}`,
    ),
  ).toBeVisible();
  await expect(report.getByText(new RegExp(`− ${D.apps.componentKind.skill} `))).toBeVisible();
  await expect(page.getByText(D.apps.empty)).toBeVisible();
});
