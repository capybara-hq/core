import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { RECORD_ROW_MENU } from "./support/chat";
import { hydrated } from "./support/nav";
import { signIn } from "./support/sign-in";

/** 界面文案取自 zh 文案文件，避免与实现重复硬编码。 */
const zh = JSON.parse(
  readFileSync(new URL("../messages/zh.json", import.meta.url), "utf8"),
) as typeof import("../messages/zh.json");

/** DataTable 行菜单的触发按钮名称（设计系统文案 table.rowActions，zh）。 */
const M = zh.models;
const P = M.purpose;

const fill = (s: string, vars: Record<string, string | number>) =>
  s.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k]));

/** The page's one save: the ActionRow's primary (the purpose cards have no save of their own). */
const saveAll = (page: import("@playwright/test").Page) =>
  page.locator('[data-part="action-row"]').getByRole("button", { name: P.save }).click();

/**
 * 模型、价格与用途映射（T18）：超级管理员在后台给 fake-1 定价、把评委用途 eval 的部署默认设为 fake-1；
 * 组织设置页显示部署默认，覆盖后再恢复默认。最后清掉价格与映射，不影响其他用例。
 */
/** model-fake's display name (zh, its plugin.json): each provider's table is named by it. */
const MODEL_FAKE = "模拟模型";

test("后台定价与 eval 部署默认 → 组织设置页覆盖并恢复默认", async ({ page }) => {
  await signIn(page);

  // 1. 管理 → 模型：model-fake 的表里有 fake-1，行内编辑价格
  await page.goto("/admin/models");
  await expect(page.locator('[data-template="ListPage"]')).toBeVisible();
  // controls used before hydration have no React handlers yet: what they do would be lost
  await hydrated(page);
  const table = page.getByRole("table", { name: MODEL_FAKE });
  const row = table.getByRole("row").filter({ hasText: "fake-1" });
  await row.getByRole("button", { name: RECORD_ROW_MENU }).click();
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
  await saveAll(page);
  await expect(page.getByText(fill(P.savedAll, { n: 1 }))).toBeVisible();
  await expect(page.getByText(M.evalUnmapped)).toHaveCount(0);

  // 刷新后价格与映射仍在（存在 PG）
  await page.reload();
  await expect(
    page
      .getByRole("table", { name: MODEL_FAKE })
      .getByRole("row")
      .filter({ hasText: "fake-1" })
      .getByRole("cell", { name: "8", exact: true }),
  ).toBeVisible();
  await expect(evalCard.getByRole("combobox", { name: P.model })).toHaveValue("model-fake/fake-1");

  // 3. 组织设置 → 模型用途（评测向导的「去设置」链到这里）：显示部署默认，覆盖后恢复默认
  await page.goto("/settings/models");
  await hydrated(page);
  const orgCard = page.locator('[data-purpose="eval"]');
  const defText = fill(P.deploymentDefault, { target: `${MODEL_FAKE} / fake-1` });
  await expect(orgCard.getByText(defText)).toBeVisible();
  await expect(orgCard.getByText(P.overridden)).toHaveCount(0);
  await orgCard.getByRole("combobox", { name: P.model }).selectOption("model-fake/fake-1");
  await saveAll(page);
  await expect(orgCard.getByText(P.overridden)).toBeVisible();
  // Restoring the default: choose 「使用部署默认」 and save
  await orgCard.getByRole("combobox", { name: P.model }).selectOption("");
  await saveAll(page);
  await expect(orgCard.getByText(P.overridden)).toHaveCount(0);
  await expect(orgCard.getByRole("combobox", { name: P.model })).toHaveValue("");

  // 4. 清理：清除 eval 部署默认与 fake-1 的价格
  await page.goto("/admin/models");
  await hydrated(page);
  await page
    .locator('[data-purpose="eval"]')
    .getByRole("combobox", { name: P.model })
    .selectOption("");
  await saveAll(page);
  await expect(page.getByText(M.evalUnmapped)).toBeVisible();
  const priced = page
    .getByRole("table", { name: MODEL_FAKE })
    .getByRole("row")
    .filter({ hasText: "fake-1" });
  await priced.getByRole("button", { name: RECORD_ROW_MENU }).click();
  await page.getByRole("menuitem", { name: M.admin.menu.clearPrice }).click();
  await expect(priced.getByRole("cell", { name: "8", exact: true })).toHaveCount(0);
});
