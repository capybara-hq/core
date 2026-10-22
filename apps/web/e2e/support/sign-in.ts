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
 * 幂等登录：未初始化时走初始化向导（同时建组织 Acme），已初始化时走登录页；然后默认选中组织 Acme，
 * 并等 `/me` 里出现当前组织（选组织是异步请求，紧接着读 `/me` 可能还是 null）。
 * 正常情况下 `setup` 项目（`setup.spec.ts`）已经完成初始化，这里走登录；单独跑某个用例时也能自己初始化。
 */
export async function signIn(page: Page, { org = true }: { org?: boolean } = {}): Promise<void> {
  await page.goto("/zh");
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
  await expect(page).toHaveURL(/\/zh$/);
  if (!org) return;
  await page.getByRole("combobox", { name: zh.home.currentOrg }).selectOption({ label: ORG_NAME });
  await expect
    .poll(async () => {
      const me = await page.request.get("/api/v1/me");
      return me.ok() ? ((await me.json()) as { currentOrgId: string | null }).currentOrgId : null;
    })
    .not.toBeNull();
}
