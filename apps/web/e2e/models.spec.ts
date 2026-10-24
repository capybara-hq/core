import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { signIn } from "./support/sign-in";

/** 界面文案取自 zh 文案文件，避免与实现重复硬编码。 */
const zh = JSON.parse(
  readFileSync(new URL("../messages/zh.json", import.meta.url), "utf8"),
) as typeof import("../messages/zh.json");

/** DataTable 行菜单的触发按钮名称（设计系统文案 table.rowActions，zh）。 */
const ROW_ACTIONS = "行操作";
const M = zh.models;
const P = M.purpose;

const fill = (s: string, vars: Record<string, string | number>) =>
  s.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k]));

/**
 * 模型、价格与用途映射（T18）：企业管理员在后台给 fake-1 定价、把评委用途 eval 的部署默认设为 fake-1；
 * 组织设置页显示部署默认，覆盖后再恢复默认。最后清掉价格与映射，不影响其他用例。
 */
test("后台定价与 eval 部署默认 → 组织设置页覆盖并恢复默认", async ({ page }) => {
  await signIn(page);

  // 1. 管理 → 模型：model-fake 的表里有 fake-1，行内编辑价格
  await page.goto("/zh/admin/models");
  await expect(page.locator('[data-template="SettingsPage"]')).toBeVisible();
  const table = page.getByRole("table", { name: "model-fake" });
  const row = table.getByRole("row").filter({ hasText: "fake-1" });
  await row.getByRole("button", { name: ROW_ACTIONS }).click();
  await page.getByRole("menuitem", { name: M.admin.menu.editPrice }).click();
  await page.getByRole("textbox", { name: M.admin.price.input }).fill("2");
  await page.getByRole("textbox", { name: M.admin.price.output }).fill("8");
  await page
    .getByRole("button", { name: fill(M.admin.price.saveLabel, { model: "fake-1" }) })
    .click();
  await expect(page.getByText(fill(M.admin.price.saved, { model: "fake-1" }))).toBeVisible();
  await expect(row.getByRole("cell", { name: "8", exact: true })).toBeVisible();

  // 2. eval 未映射 → 设部署默认为 fake-1，提示消失
  await expect(page.getByText(M.evalUnmapped)).toBeVisible();
  const evalCard = page.locator('[data-purpose="eval"]');
  await evalCard.getByRole("combobox", { name: P.model }).selectOption("model-fake/fake-1");
  await evalCard.getByRole("button", { name: fill(P.saveLabel, { purpose: "eval" }) }).click();
  await expect(page.getByText(fill(P.saved, { purpose: "eval" }))).toBeVisible();
  await expect(page.getByText(M.evalUnmapped)).toHaveCount(0);

  // 刷新后价格与映射仍在（存在 PG）
  await page.reload();
  await expect(
    page
      .getByRole("table", { name: "model-fake" })
      .getByRole("row")
      .filter({ hasText: "fake-1" })
      .getByRole("cell", { name: "8", exact: true }),
  ).toBeVisible();
  await expect(evalCard.getByRole("combobox", { name: P.model })).toHaveValue("model-fake/fake-1");

  // 3. 组织设置 → 模型用途（评测向导的「去设置」链到这里）：显示部署默认，覆盖后恢复默认
  await page.goto("/zh/settings/models");
  const orgCard = page.locator('[data-purpose="eval"]');
  const defText = fill(P.deploymentDefault, { target: "model-fake / fake-1" });
  await expect(orgCard.getByText(defText)).toBeVisible();
  await expect(orgCard.getByText(P.overridden)).toHaveCount(0);
  await orgCard.getByRole("combobox", { name: P.model }).selectOption("model-fake/fake-1");
  await orgCard.getByRole("button", { name: fill(P.saveLabel, { purpose: "eval" }) }).click();
  await expect(orgCard.getByText(P.overridden)).toBeVisible();
  await orgCard.getByRole("button", { name: fill(P.restoreLabel, { purpose: "eval" }) }).click();
  await expect(orgCard.getByText(P.overridden)).toHaveCount(0);
  await expect(orgCard.getByRole("combobox", { name: P.model })).toHaveValue("");

  // 4. 清理：清除 eval 部署默认与 fake-1 的价格
  await page.goto("/zh/admin/models");
  await page
    .locator('[data-purpose="eval"]')
    .getByRole("button", { name: fill(P.clearLabel, { purpose: "eval" }) })
    .click();
  await expect(page.getByText(M.evalUnmapped)).toBeVisible();
  const priced = page
    .getByRole("table", { name: "model-fake" })
    .getByRole("row")
    .filter({ hasText: "fake-1" });
  await priced.getByRole("button", { name: ROW_ACTIONS }).click();
  await page.getByRole("menuitem", { name: M.admin.menu.clearPrice }).click();
  await expect(priced.getByRole("cell", { name: "8", exact: true })).toHaveCount(0);
});
