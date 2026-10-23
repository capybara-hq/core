import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { LOGIN, ORG_NAME, PASSWORD } from "./support/sign-in";

/** 界面文案取自 zh 文案文件，避免与实现重复硬编码。 */
const zh = JSON.parse(
  readFileSync(new URL("../messages/zh.json", import.meta.url), "utf8"),
) as typeof import("../messages/zh.json");

/**
 * `setup` 项目（playwright.config.ts）：在全新内核上走一遍初始化向导，其余用例都依赖它先跑完
 * （之后它们用 `support/sign-in.ts` 登录）。初始化页的断言只在这里。
 */
test("初始化向导：未初始化的部署打开首页 → 初始化页（可切换语言）→ 建企业管理员与组织 → 进概览", async ({
  page,
}) => {
  await page.goto("/zh");
  await expect(page).toHaveURL(/\/zh\/setup$/);
  // 认证页也能切换语言
  await expect(page.getByRole("link", { name: zh.common.localeName.en })).toBeVisible();
  await page.getByLabel(zh.setup.loginLabel).fill(LOGIN);
  await page.getByLabel(zh.setup.passwordLabel).fill(PASSWORD);
  await page.getByLabel(zh.setup.displayNameLabel).fill("Admin");
  await page.getByLabel(zh.setup.orgNameLabel).fill(ORG_NAME);
  await page.getByRole("button", { name: zh.setup.submit }).click();

  await expect(page).toHaveURL(/\/zh$/);
  await expect(page.locator('[data-template="OverviewPage"]')).toBeVisible();
});
