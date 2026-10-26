import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { signIn } from "./support/sign-in";

/** 界面文案取自 zh 文案文件，避免与实现重复硬编码。 */
const zh = JSON.parse(
  readFileSync(new URL("../messages/zh.json", import.meta.url), "utf8"),
) as typeof import("../messages/zh.json");

/**
 * design 包里的 zh 文案（`packages/design/src/i18n.ts`，如 ActionRow 区域名 `shell.pending`）：按键从源码读出，
 * 不在用例里重复硬编码。
 */
const designZh = (key: string): string => {
  const src = readFileSync(
    new URL("../../../packages/design/src/i18n.ts", import.meta.url),
    "utf8",
  );
  const m = new RegExp(`"${key.replace(/\./g, "\\.")}":\\s*"([^"]*)"`).exec(src);
  if (!m?.[1]) throw new Error(`design message ${key} not found`);
  return m[1];
};

/** DataTable 行菜单的触发按钮名称（设计系统文案 table.rowActions，zh）。 */
const ROW_ACTIONS = "行操作";

/** 安装向导的 ActionRow（主操作 / 上一步都在这里）。 */
const actionRow = (page: Page) => page.getByRole("region", { name: designZh("shell.pending") });

/** 用安装向导装一个无需认证的 MCP 连接器，完成后打开连接器详情。 */
async function installMcp(page: Page, name: string, slug: string, url: string) {
  const w = zh.connectors.wizard;
  if (!/\/connectors\/install$/.test(page.url())) await page.goto("/zh/connectors/install");
  await expect(page.locator('[data-template="WizardPage"]')).toBeVisible();
  await actionRow(page).getByRole("button", { name: w.next }).click();
  await page.getByRole("textbox", { name: zh.connectors.form.nameLabel, exact: true }).fill(name);
  await page
    .getByRole("textbox", { name: new RegExp(`^${zh.connectors.form.slugLabel}`) })
    .fill(slug);
  await page.getByRole("textbox", { name: zh.connectors.form.urlLabel }).fill(url);
  await actionRow(page).getByRole("button", { name: w.next }).click();
  await expect(
    page.getByRole("combobox", { name: zh.connectors.form.authTypeLabel, exact: true }),
  ).toHaveValue("none");
  await actionRow(page).getByRole("button", { name: w.next }).click();
  await expect(page.getByRole("table", { name: w.toolsTitle })).toBeVisible();
  await actionRow(page).getByRole("button", { name: w.install }).click();
  await expect(page.getByText(w.doneTitle.replace("{name}", name))).toBeVisible();
  await actionRow(page).getByRole("button", { name: w.openConnector }).click();
  await expect(page).toHaveURL(/\/zh\/connectors\/[^/]+$/);
  await expect(page.locator('[data-template="DetailPage"]')).toBeVisible();
}

/** 新建引用某连接器全部工具的 agent（model-fake），从列表开始对话，返回输入框。 */
async function chatWithAgent(page: Page, agentName: string, connectorName: string) {
  await page.goto("/zh/agents/new");
  await page.getByRole("textbox", { name: zh.agents.form.nameLabel, exact: true }).fill(agentName);
  await page
    .getByRole("combobox", { name: zh.agents.form.modelLabel, exact: true })
    .selectOption("model-fake/fake-1");
  await page
    .getByRole("checkbox", { name: zh.agents.form.connectorTools.replace("{name}", connectorName) })
    .check();
  await page.getByRole("button", { name: zh.agents.form.submit }).click();
  await expect(page).toHaveURL(/\/zh\/agents$/);
  await page
    .getByRole("row")
    .filter({ hasText: agentName })
    .getByRole("button", { name: ROW_ACTIONS })
    .click();
  await page.getByRole("menuitem", { name: zh.agents.startChat }).click();
  await expect(page).toHaveURL(/\/zh\/chat\/[^/]+$/);
  return page.getByLabel(zh.chat.inputLabel);
}

test("MCP 连接器 → agent 引用 → destructive 工具触发审批 → 批准 → 回复含工具结果", async ({
  page,
}) => {
  const mcpUrl = process.env.CAPYBARA_E2E_MCP_URL;
  expect(mcpUrl, "global-setup 应写入 CAPYBARA_E2E_MCP_URL").toBeTruthy();
  await signIn(page);

  // 1. 安装连接器（MCP，无需认证）→ 详情页的工具页签列出 destructive 工具，默认策略为「需审批」
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("link", { name: zh.nav.connectors })
    .click();
  await expect(page).toHaveURL(/\/zh\/connectors$/);
  await page.getByRole("link", { name: zh.connectors.new }).click();
  await expect(page).toHaveURL(/\/zh\/connectors\/install$/);
  await installMcp(page, "Fixture", "fixture", mcpUrl as string);
  const policy = page.getByRole("combobox", {
    name: zh.connectors.tools.policyLabel.replace("{tool}", "fixture__delete_item"),
  });
  await expect(policy).toHaveValue("ask");

  // 2. 新建 agent，引用该连接器的全部工具
  await page.goto("/zh/agents/new");
  await page
    .getByRole("textbox", { name: zh.agents.form.nameLabel, exact: true })
    .fill("Tool agent");
  await page
    .getByRole("combobox", { name: zh.agents.form.modelLabel, exact: true })
    .selectOption("model-fake/fake-1");
  await page
    .getByRole("checkbox", { name: zh.agents.form.connectorTools.replace("{name}", "Fixture") })
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
  // 工具调用是时间线里的一行（默认折叠）：点开看 IN / OUT
  const row = page
    .locator('[data-role="tool"]')
    .getByRole("button", { name: /fixture__delete_item/ });
  await expect(row).toHaveAttribute("aria-expanded", "false");
  await row.click();
  await expect(
    page.locator('[data-role="tool"]').getByText("deleted x1", { exact: true }),
  ).toBeVisible();
});

test("MCP：/ 斜杠命令插入渲染后的提示；@ 资源随消息附带；elicitation 表单回答后工具继续", async ({
  page,
}) => {
  const mcpUrl = process.env.CAPYBARA_E2E_MCP_URL as string;
  await signIn(page);

  // 安装连接器（slug docs）并新建引用它的 agent
  await installMcp(page, "Docs", "docs", mcpUrl);
  const input = await chatWithAgent(page, "Docs agent", "Docs");

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
  // 同一个假服务也被上一个用例装成了 Fixture：按连接器分组取 Docs 的那条
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

test("带工具的对话结束后，管理员打开运行记录：瀑布里有模型与工具 span，详情含审批链", async ({
  page,
}) => {
  const mcpUrl = process.env.CAPYBARA_E2E_MCP_URL as string;
  await signIn(page);

  // 1. 带工具的对话：destructive 工具 → 审批 → 批准 → 回复
  await installMcp(page, "Trace", "trace", mcpUrl);
  const input = await chatWithAgent(page, "Trace agent", "Trace");
  await input.fill('tool:trace__delete_item:{"id":"t1"}');
  await input.press("Enter");
  const approval = page.locator('[data-role="approval"]');
  await expect(approval).toHaveCount(1);
  await approval.getByRole("button", { name: zh.approval.approve }).click();
  await expect(page.locator('[data-role="assistant"] [data-part="body"]').last()).toHaveText(
    /deleted t1/,
  );

  // 2. 顶栏「评测」→「运行记录」→ 按 agent 筛选 → 运行结束后打开该对话
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("link", { name: zh.nav.evals })
    .click();
  await expect(page).toHaveURL(/\/zh\/evals$/);
  await page.getByRole("link", { name: zh.evals.runHistory }).click();
  await expect(page).toHaveURL(/\/zh\/trajectories$/);
  await expect(page.locator('[data-template="ListPage"]')).toBeVisible();
  await page
    .getByRole("combobox", { name: zh.trajectories.filters.agent })
    .selectOption({ label: "Trace agent" });
  const table = page.getByRole("table", { name: zh.trajectories.title });
  await expect(table.getByRole("row")).toHaveCount(2); // 表头 + 一个对话
  await expect(async () => {
    await page.reload();
    await page
      .getByRole("combobox", { name: zh.trajectories.filters.agent })
      .selectOption({ label: "Trace agent" });
    await expect(table.getByText(`✓ ${zh.trajectories.status.completed}`)).toBeVisible({
      timeout: 2000,
    });
  }).toPass();
  await table.getByRole("row").nth(1).click();
  await expect(page).toHaveURL(/\/zh\/trajectories\/[^/]+$/);

  // 3. 轨迹页：模型与工具 span；选中工具 span 显示结果与审批链；有审计提示与「加入评测集」
  await expect(page.locator('[data-template="TracePage"]')).toBeVisible();
  const tree = page.getByRole("tree", { name: zh.trajectories.detail.waterfall });
  await expect(tree.locator('[data-kind="model"]').first()).toContainText("model-fake/fake-1");
  const tool = tree.locator('[data-kind="tool"]');
  await expect(tool).toHaveCount(1);
  await expect(tool).toContainText("trace__delete_item");
  await expect(tree.locator('[data-kind="wait"]')).toHaveCount(1);
  await expect(page.getByText(zh.trajectories.detail.audited)).toBeVisible();
  await expect(page.getByRole("button", { name: zh.trajectories.addToSet.action })).toBeVisible();
  await tool.click();
  const detail = page.getByRole("region", { name: zh.trajectories.detail.region });
  await expect(detail.getByText("deleted t1", { exact: true })).toBeVisible();
  await expect(detail.getByText(zh.trajectories.detail.tool.decisions.approved)).toBeVisible();
});
