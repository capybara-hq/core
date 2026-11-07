import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { designZh } from "./support/chat";
import { HOME_URL, hydrated, NEW_CHAT_URL } from "./support/nav";
import { selectOption } from "./support/select";
import { LOGIN, ORG_NAME, PASSWORD } from "./support/sign-in";

/** 界面文案取自 zh 文案文件，避免与实现重复硬编码。 */
const zh = JSON.parse(
  readFileSync(new URL("../messages/zh.json", import.meta.url), "utf8"),
) as typeof import("../messages/zh.json");

/**
 * `setup` 项目（playwright.config.ts）：在全新内核上走一遍初始化向导，其余用例都依赖它先跑完
 * （之后它们用 `support/sign-in.ts` 登录）。初始化页的断言只在这里。
 */
test("setup wizard: a fresh deployment opens / → the setup page (language switch) → super admin and org → guided setup → new agent → conversation", async ({
  page,
}) => {
  // `/` redirects to the home (the new conversation), which sends a fresh deployment to /setup
  await page.goto("/");
  await expect(page).toHaveURL(/\/setup$/);
  // the auth pages switch language and theme too
  await expect(page.getByRole("combobox", { name: zh.common.language })).toBeVisible();
  await expect(page.getByRole("radiogroup", { name: zh.common.theme })).toBeVisible();
  await page.getByLabel(zh.setup.loginLabel).fill(LOGIN);
  await page.getByLabel(zh.setup.passwordLabel).fill(PASSWORD);
  await page.getByLabel(zh.setup.displayNameLabel).fill("Admin");
  await page.getByLabel(zh.setup.orgNameLabel).fill(ORG_NAME);
  await page.getByRole("button", { name: zh.setup.submit }).click();

  // setting up lands home, the new conversation; a new org has no agent: the setup layout there
  // (the setup sidebar, not the workspace's; web-order §3.8, web-SSR §4)
  await expect(page).toHaveURL(HOME_URL);
  const setup = page.locator('[data-template="SetupPage"]');
  await expect(setup).toBeVisible();
  await expect(page.locator('[data-part="sidebar"][data-context="work"]')).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1, name: zh.chat.setup.title })).toBeVisible();
  // the e2e stack loads model-fake: the model step is done, creating an agent is next. The step's
  // action is a button: a click lands only once the page is hydrated (a cold `next dev` compile can
  // keep the first document's script from running for a while)
  await hydrated(page);
  const agentStep = page.getByRole("listitem").filter({ hasText: zh.setupLayout.steps.agent });
  await agentStep.getByRole("link", { name: zh.chat.setup.agent.action }).click();
  await expect(page).toHaveURL(/\/agents\/new$/);
  // the step page renders inside the setup frame; the sidebar's setup home is the way back
  await expect(setup).toBeVisible();
  const setupSidebar = page.locator('[data-part="sidebar"][data-context="setup"]');
  await expect(
    setupSidebar.getByRole("link", { name: designZh("sidebar.setupHome"), exact: true }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: zh.agents.form.nameLabel, exact: true })
    .fill("Setup agent");
  await selectOption(
    page.getByRole("combobox", { name: zh.agents.form.modelLabel, exact: true }),
    "model-fake/fake-1",
  );
  await page.getByRole("button", { name: zh.agents.form.submit }).click();
  // the new agent makes the org ready: a new conversation with it, in the shell
  await expect(page).toHaveURL(NEW_CHAT_URL);
  await expect(page.locator('[data-template="ConversationPage"]')).toBeVisible();
  await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible();
});
