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

/**
 * 登录（与 chat.spec 共用同一个内核：若尚未初始化则走初始化向导），并选中组织 Acme。
 * 每个用例是新的浏览器上下文，所以总要先登录。
 */
async function signIn(page: Page) {
  // 未登录访问首页：已初始化 → 登录页；未初始化 → 初始化向导（登录页也会再跳一次）
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
    await page.getByRole("button", { name: zh.login.submit }).click();
  }
  await expect(page).toHaveURL(/\/zh$/);
  await page.getByRole("combobox", { name: zh.home.currentOrg }).selectOption({ label: "Acme" });
}

test("MCP 应用 → agent 引用 → destructive 工具触发审批 → 批准 → 回复含工具结果", async ({
  page,
}) => {
  const mcpUrl = process.env.CAPYBARA_E2E_MCP_URL;
  expect(mcpUrl, "global-setup 应写入 CAPYBARA_E2E_MCP_URL").toBeTruthy();
  await signIn(page);

  // 1. 安装应用（MCP，无需认证）→ 详情页的工具页签列出 destructive 工具，默认策略为「需审批」
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("link", { name: zh.nav.apps })
    .click();
  await expect(page).toHaveURL(/\/zh\/apps$/);
  await page.getByRole("link", { name: zh.apps.new }).click();
  await expect(page.locator('[data-template="FormPage"]')).toBeVisible();
  await page.getByRole("textbox", { name: zh.apps.form.nameLabel, exact: true }).fill("Fixture");
  await page
    .getByRole("textbox", { name: new RegExp(`^${zh.apps.form.slugLabel}`) })
    .fill("fixture");
  await page.getByRole("textbox", { name: zh.apps.form.urlLabel }).fill(mcpUrl as string);
  await page.getByRole("button", { name: zh.apps.form.submit }).click();
  await expect(page).toHaveURL(/\/zh\/apps\/[^/]+$/);
  await expect(page.locator('[data-template="DetailPage"]')).toBeVisible();
  const policy = page.getByRole("combobox", {
    name: zh.apps.tools.policyLabel.replace("{tool}", "fixture__delete_item"),
  });
  await expect(policy).toHaveValue("ask");

  // 2. 新建 agent，引用该应用的全部工具
  await page.goto("/zh/agents/new");
  await page
    .getByRole("textbox", { name: zh.agents.form.nameLabel, exact: true })
    .fill("Tool agent");
  await page
    .getByRole("combobox", { name: zh.agents.form.modelLabel, exact: true })
    .selectOption("model-fake/fake-1");
  await page
    .getByRole("checkbox", { name: zh.agents.form.appTools.replace("{name}", "Fixture") })
    .check();
  await page.getByRole("button", { name: zh.agents.form.submit }).click();
  await expect(page).toHaveURL(/\/zh\/agents$/);

  // 3. 开始对话：model-fake 按指令调用 destructive 工具 → 出现审批卡片，运行等人处理
  await page
    .getByRole("row")
    .filter({ hasText: "Tool agent" })
    .getByRole("button", { name: ROW_ACTIONS })
    .click();
  await page.getByRole("menuitem", { name: zh.agents.startChat }).click();
  await expect(page).toHaveURL(/\/zh\/chat\/[^/]+$/);
  const input = page.getByLabel(zh.chat.inputLabel);
  await input.fill('tool:fixture__delete_item:{"id":"x1"}');
  await input.press("Enter");

  const approval = page.locator('[data-role="approval"]');
  await expect(approval).toHaveCount(1);
  await expect(approval.getByText("Fixture")).toBeVisible();
  await expect(approval.getByText(zh.approval.otherApprover)).toHaveCount(0);
  await expect(page.getByRole("complementary").getByText(zh.chat.waiting)).toBeVisible();
  const tool = page.locator('[data-role="tool"]');
  await expect(tool).toHaveAttribute("data-status", "pending");

  // 4. 批准（仅本次）→ 卡片显示已批准；工具执行完成；回复包含工具结果
  await approval.getByRole("button", { name: zh.approval.approve }).click();
  await expect(approval.getByText(zh.approval.decision.approved)).toBeVisible();
  await expect(tool).toHaveAttribute("data-status", "done");
  await expect(page.locator('[data-role="assistant"] [data-part="body"]').last()).toHaveText(
    /deleted x1/,
  );

  // 5. 刷新后由日志重建：审批卡片仍为已批准，工具结果可展开查看
  await page.reload();
  await expect(
    page.locator('[data-role="approval"]').getByText(zh.approval.decision.approved),
  ).toBeVisible();
  await page.locator('[data-role="tool"]').getByText(zh.tools.details).click();
  await expect(page.getByRole("textbox", { name: zh.tools.result })).toHaveValue("deleted x1");
});

test("MCP：/ 斜杠命令插入渲染后的提示；@ 资源随消息附带；elicitation 表单回答后工具继续", async ({
  page,
}) => {
  const mcpUrl = process.env.CAPYBARA_E2E_MCP_URL as string;
  await signIn(page);

  // 安装应用（slug docs）并新建引用它的 agent
  await page.goto("/zh/apps/new");
  await page.getByRole("textbox", { name: zh.apps.form.nameLabel, exact: true }).fill("Docs");
  await page.getByRole("textbox", { name: new RegExp(`^${zh.apps.form.slugLabel}`) }).fill("docs");
  await page.getByRole("textbox", { name: zh.apps.form.urlLabel }).fill(mcpUrl);
  await page.getByRole("button", { name: zh.apps.form.submit }).click();
  await expect(page).toHaveURL(/\/zh\/apps\/[^/]+$/);
  await page.goto("/zh/agents/new");
  await page
    .getByRole("textbox", { name: zh.agents.form.nameLabel, exact: true })
    .fill("Docs agent");
  await page
    .getByRole("combobox", { name: zh.agents.form.modelLabel, exact: true })
    .selectOption("model-fake/fake-1");
  await page
    .getByRole("checkbox", { name: zh.agents.form.appTools.replace("{name}", "Docs") })
    .check();
  await page.getByRole("button", { name: zh.agents.form.submit }).click();
  await expect(page).toHaveURL(/\/zh\/agents$/);
  await page
    .getByRole("row")
    .filter({ hasText: "Docs agent" })
    .getByRole("button", { name: ROW_ACTIONS })
    .click();
  await page.getByRole("menuitem", { name: zh.agents.startChat }).click();
  await expect(page).toHaveURL(/\/zh\/chat\/[^/]+$/);
  const input = page.getByLabel(zh.chat.inputLabel);

  // 1. `/` → 面板 → /docs:summarize → 填参数 → 渲染结果进入输入框（不自动发送）
  await input.press("/");
  await page.getByRole("option", { name: "/docs:summarize — Summarize a topic" }).click();
  const dialog = page.getByRole("dialog", { name: "/docs:summarize" });
  await dialog.getByLabel(/topic/).fill("cats");
  await dialog.getByRole("button", { name: zh.chat.insertPrompt }).click();
  await expect(input).toHaveValue("Summarize cats");
  await input.fill("");

  // 2. `@` → 资源 → 附件条目 → 发送：消息显示附件，模型收到资源正文（model-fake 的 echo 原样回显）
  await input.pressSequentially("echo:got ");
  await input.press("@");
  // 同一个假服务也被上一个用例装成了 Fixture：按应用分组取 Docs 的那条
  await page
    .getByRole("group", { name: "Docs" })
    .getByRole("option", { name: "Handbook · docs://handbook" })
    .click();
  await expect(page.getByRole("group", { name: zh.chat.attachments })).toContainText("@Handbook");
  await input.press("Enter");
  await expect(page.locator('[data-role="user"]').last()).toContainText("@Handbook · Docs");
  await expect(page.locator('[data-role="assistant"] [data-part="body"]').last()).toContainText(
    "# Handbook",
  );

  // 3. elicitation：工具调用途中请用户填表 → 回答后工具重新发起并拿到答案
  await input.fill("tool:docs__signup:{}");
  await input.press("Enter");
  const question = page.locator('[data-role="question"]');
  await expect(question).toHaveCount(1);
  await expect(question.getByText("Sign up")).toBeVisible();
  await question.getByRole("textbox").fill("Ada");
  await question.getByRole("button", { name: zh.question.submit }).click();
  await expect(page.locator('[data-role="assistant"] [data-part="body"]').last()).toHaveText(
    /welcome Ada/,
  );
});
