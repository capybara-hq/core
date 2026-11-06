import { readFileSync } from "node:fs";
import { expect, type Page } from "@playwright/test";
import { hydrated } from "./nav";

/** 界面文案取自 zh 文案文件，避免与实现重复硬编码。 */
const zh = JSON.parse(
  readFileSync(new URL("../../messages/zh.json", import.meta.url), "utf8"),
) as typeof import("../../messages/zh.json");

/** 全部用例共用的超级管理员账号（`setup.spec.ts` 在初始化向导里创建；初始化的账号是超级管理员）。 */
export const LOGIN = "admin";
export const PASSWORD = "correct-horse-battery";
export const ORG_NAME = "Acme";

const CSRF = { "X-Capybara-Csrf": "1" };

/**
 * Makes sure the current org has an agent, so the workspace renders the shell instead of the
 * setup layout (web-order spec §3.8): creates a private model-fake agent "E2E agent" when the
 * readiness endpoint counts none. The deployment's model-fake provider is loaded by the e2e stack.
 */
export async function ensureAgent(page: Page, orgId: string): Promise<void> {
  const r = await page.request.get(`/api/v1/orgs/${orgId}/readiness`);
  expect(r.ok(), await r.text()).toBe(true);
  if (((await r.json()) as { agents: number }).agents > 0) return;
  const res = await page.request.post(`/api/v1/orgs/${orgId}/agents`, {
    headers: CSRF,
    data: {
      definition: {
        name: "E2E agent",
        instructions: "Help.",
        model: { provider: "model-fake", model: "fake-1" },
      },
      visibility: "private",
    },
  });
  expect(res.status(), await res.text()).toBe(201);
}

/**
 * Idempotent sign-in: the setup wizard when not set up yet (it creates the org Acme), else the login
 * page. A new session starts in the org last chosen (or the only one); when the org chooser covers
 * the app instead, open Acme there. With `org` (the default) it then waits until `/me` names the
 * current org and, with `agent` (the default), makes sure an agent exists ({@link ensureAgent})
 * and that the shell (not the setup layout) is on screen. It returns once the page is hydrated
 * ({@link hydrated}). Normally the `setup` project
 * (`setup.spec.ts`) has already set up; a spec run alone sets up itself.
 */
export async function signIn(
  page: Page,
  { org = true, agent = true }: { org?: boolean; agent?: boolean } = {},
): Promise<void> {
  // the home: the new conversation (`/` redirects there too)
  await page.goto("/chat");
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
  await expect(page).toHaveURL(/\/chat$/);
  const chooser = page.getByRole("list", { name: zh.orgChooser.listLabel });
  const home = page.locator('[data-template="ConversationPage"]');
  // an org without an agent shows the setup layout instead of the shell
  const setup = page.locator('[data-template="SetupPage"]');
  const landed = home.or(setup);
  await expect(chooser.or(landed)).toBeVisible();
  if (await chooser.isVisible()) {
    await chooser
      .getByRole("listitem")
      .filter({ hasText: ORG_NAME })
      .getByRole("button", { name: zh.orgChooser.enter })
      .click();
    await expect(landed).toBeVisible();
  }
  if (!org) return hydrated(page);
  let orgId: string | null = null;
  await expect
    .poll(async () => {
      const me = await page.request.get("/api/v1/me");
      orgId = me.ok() ? ((await me.json()) as { currentOrgId: string | null }).currentOrgId : null;
      return orgId;
    })
    .not.toBeNull();
  if (!agent) return hydrated(page);
  await ensureAgent(page, orgId as unknown as string);
  if (await setup.isVisible()) {
    // a fresh page load reads readiness again: the org can run now
    await page.goto("/chat");
    await expect(home).toBeVisible();
  }
  // until hydration the sidebar draws two panels and nothing on the page answers a click yet
  await hydrated(page);
}
