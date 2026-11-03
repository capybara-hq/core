import { expect, type Page, test } from "@playwright/test";

/**
 * Repeater interaction (design spec §6.26): the preset menu, add and the new item's focus, remove
 * with its undo toast, and reordering by keyboard and by the move buttons. Runs on the live
 * `/dev/ui/reference/repeater` blocks (endpoints with presets; model rows without).
 */
const block = (page: Page, id: string) => page.locator(`[data-ref-block="${id}"]`);

async function open(page: Page) {
  await page.goto("/dev/ui/reference/repeater");
  await page.waitForLoadState("networkidle");
}

/** The item groups' accessible names, in order. */
const titles = (page: Page, id: string) =>
  block(page, id)
    .locator('[data-part="repeater-item"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") ?? ""));

test("the add button opens the presets plus 空白; a preset adds a card and focuses its first field", async ({
  page,
}) => {
  await open(page);
  const b = block(page, "repeater-default");
  await b.getByRole("button", { name: "添加端点" }).click();
  const menu = page.getByRole("menu", { name: "添加端点" });
  await expect(menu.getByRole("menuitem")).toHaveText([
    "DeepSeek",
    "通义千问（百炼）",
    "火山方舟",
    "空白",
  ]);
  await menu.getByRole("menuitem", { name: "火山方舟" }).click();
  await expect(menu).toHaveCount(0);
  expect(await titles(page, "repeater-default")).toEqual(["deepseek", "qwen", "ark"]);
  const name = b.getByRole("group", { name: "ark" }).getByRole("textbox", { name: "名称" });
  await expect(name).toBeFocused();
  await expect(name).toHaveValue("ark");
});

test("a plain add focuses the new row's first field", async ({ page }) => {
  await open(page);
  const b = block(page, "repeater-rows");
  await b.getByRole("button", { name: "添加模型" }).click();
  const rows = b.locator('[data-part="repeater-item"]');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(2).getByRole("textbox", { name: "模型 ID" })).toBeFocused();
});

test("remove acts at once and 撤销 in the toast puts the item back", async ({ page }) => {
  await open(page);
  const b = block(page, "repeater-default");
  await b.getByRole("button", { name: "移除 qwen" }).click();
  expect(await titles(page, "repeater-default")).toEqual(["deepseek"]);
  const toast = page.locator(".cb-toast").filter({ hasText: "已移除「qwen」。" });
  await expect(toast).toBeVisible();
  // at min (1) the last item cannot be removed
  await expect(b.getByRole("button", { name: "移除 deepseek" })).toBeDisabled();
  await toast.getByRole("button", { name: "撤销" }).click();
  await expect(toast).toHaveCount(0);
  expect(await titles(page, "repeater-default")).toEqual(["deepseek", "qwen"]);
});

test("Alt+↑/↓ on a focused item moves it and keeps the focus", async ({ page }) => {
  await open(page);
  const b = block(page, "repeater-default");
  const name = b.getByRole("group", { name: "deepseek" }).getByRole("textbox", { name: "名称" });
  await name.focus();
  await page.keyboard.press("Alt+ArrowDown");
  await expect.poll(() => titles(page, "repeater-default")).toEqual(["qwen", "deepseek"]);
  await expect(name).toBeFocused();
  await page.keyboard.press("Alt+ArrowUp");
  await expect.poll(() => titles(page, "repeater-default")).toEqual(["deepseek", "qwen"]);
  await expect(name).toBeFocused();
});

test("a move button that becomes disabled hands focus to its sibling", async ({ page }) => {
  await open(page);
  const b = block(page, "repeater-default");
  await b.getByRole("button", { name: "上移 qwen" }).click();
  await expect.poll(() => titles(page, "repeater-default")).toEqual(["qwen", "deepseek"]);
  await expect(b.getByRole("button", { name: "上移 qwen" })).toBeDisabled();
  await expect(b.getByRole("button", { name: "下移 qwen" })).toBeFocused();
});
