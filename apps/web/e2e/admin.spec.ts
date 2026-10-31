import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { RECORD_ROW_MENU } from "./support/chat";
import { signIn } from "./support/sign-in";

/** 界面文案取自 zh 文案文件，避免与实现重复硬编码。 */
const zh = JSON.parse(
  readFileSync(new URL("../messages/zh.json", import.meta.url), "utf8"),
) as typeof import("../messages/zh.json");

/** DataTable 行菜单的触发按钮名称（设计系统文案 table.rowActions，zh）。 */
const A = zh.admin;

const fill = (s: string, vars: Record<string, string | number>) =>
  s.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k]));

test("企业管理员：顶栏「管理」→ 组织 → 设置运行并发并保存成功", async ({ page }) => {
  await signIn(page, { org: false });

  // the admin console's entry sits above the account row (enterprise admins)
  await page.getByRole("link", { name: "管理后台" }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.locator('[data-template="OverviewPage"]')).toBeVisible();
  await page.getByRole("link", { name: A.overview.orgs.open }).click();
  await expect(page).toHaveURL(/\/admin\/orgs$/);

  const row = page.getByRole("row").filter({ hasText: "Acme" });
  await row.getByRole("button", { name: RECORD_ROW_MENU }).click();
  await page.getByRole("menuitem", { name: A.orgs.edit }).click();
  const dialog = page.getByRole("dialog", { name: fill(A.orgs.dialog.title, { name: "Acme" }) });
  await dialog.getByRole("textbox", { name: A.orgs.dialog.runConcurrency }).fill("17");
  await dialog.getByRole("button", { name: A.orgs.dialog.save }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText(A.orgs.saved)).toBeVisible();
  await expect(row.getByRole("cell", { name: "17", exact: true })).toBeVisible();

  // 刷新后仍是保存的值（存在部署设置里）
  await page.reload();
  await expect(
    page
      .getByRole("row")
      .filter({ hasText: "Acme" })
      .getByRole("cell", { name: "17", exact: true }),
  ).toBeVisible();
});
