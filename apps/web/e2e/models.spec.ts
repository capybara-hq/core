import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { RECORD_ROW_MENU } from "./support/chat";
import { hydrated } from "./support/nav";
import { selectOption } from "./support/select";
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

/** The page's one save: the ActionRow's primary (the purpose rows have no save of their own). */
const saveAll = (page: import("@playwright/test").Page) =>
  page.locator('[data-part="action-row"]').getByRole("button", { name: P.save }).click();

/**
 * 模型、价格与用途映射（T18）：超级管理员在后台给 fake-1 定价、把评委用途 eval 的部署默认设为 fake-1；
 * 组织设置页显示部署默认，覆盖后再恢复默认。最后清掉价格与映射，不影响其他用例。
 */
/** model-fake's display name (zh, its plugin.json): each provider's table is named by it. */
const MODEL_FAKE = "模拟模型";

/**
 * The 模型 tab with model-fake open (`?provider=<plugin>`), and the 用途默认 tab (`?tab=purposes`)
 * of the admin and org models pages.
 */
const ADMIN_MODELS = "/admin/models?provider=model-fake";
const ADMIN_PURPOSES = "/admin/models?tab=purposes";
const ORG_PURPOSES = "/settings/models?tab=purposes";

/**
 * model-fake's chat models table on the 模型 tab: one table per model kind, named by the provider,
 * or `<provider> · <kind>` when the provider has models of more than one kind.
 */
const chatTable = (page: import("@playwright/test").Page) =>
  page.getByRole("table", { name: new RegExp(`^${MODEL_FAKE}( · ${M.kind.chat})?$`) });

/**
 * The eval purpose's row (an ItemListItem, never a card): a group named by the purpose's label,
 * the kernel's `KERNEL_PURPOSES` zh label.
 */
const evalRow = (page: import("@playwright/test").Page) =>
  page.getByRole("group", { name: "评测评委", exact: true });

test("后台定价与 eval 部署默认 → 组织设置页覆盖并恢复默认", async ({ page }) => {
  await signIn(page);

  // 1. Admin -> models, 模型 tab with model-fake open: fake-1 in its chat table, edit the price
  // from the row menu
  await page.goto(ADMIN_MODELS);
  await expect(page.locator('[data-template="ListPage"]')).toBeVisible();
  // controls used before hydration have no React handlers yet: what they do would be lost
  await hydrated(page);
  const row = chatTable(page).getByRole("row").filter({ hasText: "fake-1" });
  await row.getByRole("button", { name: RECORD_ROW_MENU }).click();
  await page.getByRole("menuitem", { name: M.admin.menu.editPrice }).click();
  await page.getByRole("textbox", { name: M.admin.price.input }).fill("2");
  await page.getByRole("textbox", { name: M.admin.price.output }).fill("8");
  await page
    .getByRole("button", { name: fill(M.admin.price.saveLabel, { model: "fake-1" }) })
    .click();
  await expect(page.getByText(fill(M.admin.price.saved, { model: "fake-1" }))).toBeVisible();
  await expect(row.getByRole("cell", { name: "8", exact: true })).toBeVisible();

  // 2. 用途默认 tab: eval unmapped -> set the deployment default to fake-1, the notice goes
  await page.goto(ADMIN_PURPOSES);
  await hydrated(page);
  await expect(page.getByText(M.evalUnmapped)).toBeVisible();
  const evalCard = evalRow(page);
  await selectOption(evalCard.getByRole("combobox", { name: P.model }), "model-fake/fake-1");
  await saveAll(page);
  await expect(page.getByText(fill(P.savedAll, { n: 1 }))).toBeVisible();
  await expect(page.getByText(M.evalUnmapped)).toHaveCount(0);

  // After a reload the mapping and the price are still there (stored in PG)
  await page.reload();
  await expect(evalCard.getByRole("combobox", { name: P.model })).toHaveAttribute(
    "value",
    "model-fake/fake-1",
  );
  await page.goto(ADMIN_MODELS);
  await expect(
    chatTable(page)
      .getByRole("row")
      .filter({ hasText: "fake-1" })
      .getByRole("cell", { name: "8", exact: true }),
  ).toBeVisible();

  // 3. Org settings -> models, 用途默认 tab (the eval wizard's 「去设置」 links here): it shows the
  // deployment default; override, then restore the default
  await page.goto(ORG_PURPOSES);
  await hydrated(page);
  const orgCard = evalRow(page);
  const defText = fill(P.useDefault, { target: `${MODEL_FAKE} / fake-1` });
  await expect(orgCard.getByRole("combobox", { name: P.model })).toContainText(defText);
  await expect(orgCard.getByText(P.overridden)).toHaveCount(0);
  await selectOption(orgCard.getByRole("combobox", { name: P.model }), "model-fake/fake-1");
  await saveAll(page);
  await expect(orgCard.getByText(P.overridden)).toBeVisible();
  // Restoring the default: choose 「使用部署默认」 and save
  await selectOption(orgCard.getByRole("combobox", { name: P.model }), "");
  await saveAll(page);
  await expect(orgCard.getByText(P.overridden)).toHaveCount(0);
  await expect(orgCard.getByRole("combobox", { name: P.model })).toHaveAttribute("value", "");

  // 4. Clean up: clear the eval deployment default (用途默认) and fake-1's price (模型)
  await page.goto(ADMIN_PURPOSES);
  await hydrated(page);
  await selectOption(evalRow(page).getByRole("combobox", { name: P.model }), "");
  await saveAll(page);
  await expect(page.getByText(M.evalUnmapped)).toBeVisible();
  await page.goto(ADMIN_MODELS);
  await hydrated(page);
  const priced = chatTable(page).getByRole("row").filter({ hasText: "fake-1" });
  await priced.getByRole("button", { name: RECORD_ROW_MENU }).click();
  await page.getByRole("menuitem", { name: M.admin.menu.clearPrice }).click();
  await expect(priced.getByRole("cell", { name: "8", exact: true })).toHaveCount(0);
});
