import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";

/** 界面文案取自 zh 文案文件，避免与实现重复硬编码。 */
const zh = JSON.parse(
  readFileSync(new URL("../messages/zh.json", import.meta.url), "utf8"),
) as typeof import("../messages/zh.json");

const LOGIN = "admin";
const PASSWORD = "correct-horse-battery";
/** DataTable 行菜单的触发按钮名称（设计系统文案 table.rowActions，zh）。 */
const ROW_ACTIONS = "行操作";
const A = zh.admin;

const fill = (s: string, vars: Record<string, string | number>) =>
  s.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k]));

/** 登录（与其他用例共用同一个内核：未初始化时走初始化向导，初始化的账号是企业管理员）。 */
async function signIn(page: Page) {
  await page.goto("/zh");
  const setupButton = page.getByRole("button", { name: zh.setup.submit });
  const loginButton = page.getByRole("button", { name: zh.login.submit, exact: true });
  await expect(setupButton.or(loginButton)).toBeVisible();
  if (await setupButton.isVisible()) {
    await page.getByLabel(zh.setup.loginLabel).fill(LOGIN);
    await page.getByLabel(zh.setup.passwordLabel).fill(PASSWORD);
    await page.getByLabel(zh.setup.displayNameLabel).fill("Admin");
    await page.getByLabel(zh.setup.orgNameLabel).fill("Acme");
    await page.getByRole("button", { name: zh.setup.submit }).click();
  } else {
    await page.getByLabel(zh.login.loginLabel).fill(LOGIN);
    await page.getByLabel(zh.login.passwordLabel).fill(PASSWORD);
    await page.getByRole("button", { name: zh.login.submit, exact: true }).click();
  }
  await expect(page).toHaveURL(/\/zh$/);
}

test("企业管理员：顶栏「管理」→ 组织 → 设置运行并发并保存成功", async ({ page }) => {
  await signIn(page);

  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("link", { name: zh.nav.admin })
    .click();
  await expect(page).toHaveURL(/\/zh\/admin$/);
  await expect(page.locator('[data-template="OverviewPage"]')).toBeVisible();
  await page.getByRole("link", { name: A.overview.orgs.open }).click();
  await expect(page).toHaveURL(/\/zh\/admin\/orgs$/);

  const row = page.getByRole("row").filter({ hasText: "Acme" });
  await row.getByRole("button", { name: ROW_ACTIONS }).click();
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
