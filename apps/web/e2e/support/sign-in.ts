import { readFileSync } from "node:fs";
import { expect, type Page } from "@playwright/test";

/** 界面文案取自 zh 文案文件，避免与实现重复硬编码。 */
const zh = JSON.parse(
  readFileSync(new URL("../../messages/zh.json", import.meta.url), "utf8"),
) as typeof import("../../messages/zh.json");

/** 全部用例共用的企业管理员账号（`setup.spec.ts` 在初始化向导里创建；初始化的账号是企业管理员）。 */
export const LOGIN = "admin";
export const PASSWORD = "correct-horse-battery";
export const ORG_NAME = "Acme";

/**
 * Idempotent sign-in: the setup wizard when not set up yet (it creates the org Acme), else the login
 * page. A new session starts in the org last chosen (or the only one); when the org chooser covers
 * the app instead, open Acme there. With `org` (the default) it then waits until `/me` names the
 * current org. Normally the `setup` project (`setup.spec.ts`) has already set up; a spec run alone
 * sets up itself.
 */
export async function signIn(page: Page, { org = true }: { org?: boolean } = {}): Promise<void> {
  await page.goto("/");
  const setupButton = page.getByRole("button", { name: zh.setup.submit });
  const loginButton = page.getByRole("button", { name: zh.login.submit, exact: true });
  await expect(setupButton.or(loginButton)).toBeVisible();
  // 登录页会再查一次是否已初始化：给它跳转的时间
  await page.waitForLoadState("networkidle");
  if (await setupButton.isVisible()) {
    await page.getByLabel(zh.setup.loginLabel).fill(LOGIN);
    await page.getByLabel(zh.setup.passwordLabel).fill(PASSWORD);
    await page.getByLabel(zh.setup.displayNameLabel).fill("Admin");
    await page.getByLabel(zh.setup.orgNameLabel).fill(ORG_NAME);
    await page.getByRole("button", { name: zh.setup.submit }).click();
  } else {
    await page.getByLabel(zh.login.loginLabel).fill(LOGIN);
    await page.getByLabel(zh.login.passwordLabel).fill(PASSWORD);
    await page.getByRole("button", { name: zh.login.submit, exact: true }).click();
  }
  await expect(page).toHaveURL(/\/$/);
  const chooser = page.getByRole("list", { name: zh.orgChooser.listLabel });
  const overview = page.locator('[data-template="OverviewPage"]');
  await expect(chooser.or(overview)).toBeVisible();
  if (await chooser.isVisible()) {
    await chooser
      .getByRole("listitem")
      .filter({ hasText: ORG_NAME })
      .getByRole("button", { name: zh.orgChooser.enter })
      .click();
    await expect(overview).toBeVisible();
  }
  if (!org) return;
  await expect
    .poll(async () => {
      const me = await page.request.get("/api/v1/me");
      return me.ok() ? ((await me.json()) as { currentOrgId: string | null }).currentOrgId : null;
    })
    .not.toBeNull();
}
