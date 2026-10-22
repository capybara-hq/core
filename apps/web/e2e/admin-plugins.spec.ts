import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";

/** 界面文案取自 zh 文案文件，避免与实现重复硬编码。 */
const zh = JSON.parse(
  readFileSync(new URL("../messages/zh.json", import.meta.url), "utf8"),
) as typeof import("../messages/zh.json");

const LOGIN = "admin";
const PASSWORD = "correct-horse-battery";
/** 内核要求非安全方法带的 CSRF 头。 */
const CSRF = { "X-Capybara-Csrf": "1" };
const P = zh.admin.plugins;

/** 登录（未初始化时走初始化向导，初始化的账号是企业管理员）并选中组织 Acme。 */
async function signIn(page: Page) {
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
    await page.getByRole("button", { name: zh.login.submit, exact: true }).click();
  }
  await expect(page).toHaveURL(/\/zh$/);
  await page.getByRole("combobox", { name: zh.home.currentOrg }).selectOption({ label: "Acme" });
  await expect
    .poll(async () => {
      const me = await page.request.get("/api/v1/me");
      return me.ok() ? ((await me.json()) as { currentOrgId: string | null }).currentOrgId : null;
    })
    .not.toBeNull();
}

/** 在对话里让 model-fake 调用 greeter 的工具，返回这一轮工具行与助手回复。 */
async function callGreet(page: Page, convId: string) {
  await page.goto(`/zh/chat/${convId}`);
  const input = page.getByLabel(zh.chat.inputLabel);
  await input.fill("tool:greeter__greet:{}");
  await input.press("Enter");
  return {
    tool: page.locator('[data-role="tool"]').last(),
    reply: page.locator('[data-role="assistant"] [data-part="body"]').last(),
  };
}

test("后台插件：上传 tgz → 审阅（敏感项须确认）→ 安装、批准、启用 → 改部署配置 → 对话里调用工具 → 停用后工具不可用（不重启）", async ({
  page,
}) => {
  const tgz = process.env.CAPYBARA_E2E_GREETER_TGZ;
  expect(tgz, "global-setup 应写入 CAPYBARA_E2E_GREETER_TGZ").toBeTruthy();
  await signIn(page);

  // 1. 管理 → 插件 → 安装插件
  await page.goto("/zh/admin/plugins");
  await expect(page.locator('[data-template="ListPage"]')).toBeVisible();
  await page.getByRole("link", { name: P.install }).click();
  await expect(page).toHaveURL(/\/zh\/admin\/plugins\/install$/);
  await expect(page.locator('[data-template="WizardPage"]')).toBeVisible();

  // 2. 选文件上传（经同源代理流式透传）→ 审阅：工具是敏感项，高亮并写明原因
  await page.locator('input[type="file"]').setInputFiles({
    name: "greeter-1.0.0.tgz",
    mimeType: "application/gzip",
    buffer: readFileSync(tgz as string),
  });
  await page.getByRole("button", { name: P.wizard.upload }).click();
  const review = page.getByRole("region", {
    name: zh.plugins.permissionsLabel.replace("{plugin}", "greeter"),
  });
  await expect(review).toBeVisible();
  await expect(review.getByText(zh.plugins.review.reason.tools)).toBeVisible();
  await expect(review.getByText("· greet")).toBeVisible();
  await page.getByRole("button", { name: P.wizard.next }).click();

  // 3. 确认：勾选「我已了解敏感项」前不能安装；安装后立即启用（默认勾选）
  const install = page.getByRole("button", { name: P.wizard.install });
  await expect(install).toBeDisabled();
  await page.getByRole("checkbox", { name: P.wizard.ack }).check();
  await install.click();
  await expect(page).toHaveURL(/\/zh\/admin\/plugins\/greeter$/);
  await expect(page.locator('[data-template="DetailPage"]')).toBeVisible();
  // 各副本收敛后状态为已启用（页面在收敛中自动重读）
  await expect(page.getByText(P.status.enabled).first()).toBeVisible({ timeout: 60_000 });

  // 4. 配置标签：greeting 是即时生效的字段，改成 bonjour；密钥 token 未设置、不回显
  await page.getByRole("tab", { name: P.detail.tabs.config }).click();
  const greeting = page.getByLabel("greeting", { exact: true });
  await expect(greeting).toHaveValue("hello");
  const token = page.getByLabel("token", { exact: true });
  await expect(token).toHaveAttribute("type", "password");
  await expect(token).toHaveValue("");
  await greeting.fill("bonjour");
  await page.getByRole("button", { name: P.config.save }).click();
  await expect(page.getByText(P.config.saved)).toBeVisible();

  // 5. 组织启用插件，建引用 greeter 工具的 agent，对话里调用成功（读到刚保存的配置）
  const me = await page.request.get("/api/v1/me");
  const orgId = ((await me.json()) as { currentOrgId: string }).currentOrgId;
  const base = `/api/v1/orgs/${orgId}`;
  const enable = await page.request.put(`${base}/plugins/greeter`, {
    headers: CSRF,
    data: { enabled: true },
  });
  expect(enable.status(), await enable.text()).toBe(200);
  const agent = await page.request.post(`${base}/agents`, {
    headers: CSRF,
    data: {
      definition: {
        name: "Greeter agent",
        instructions: "Greet people.",
        model: { provider: "model-fake", model: "fake-1" },
        tools: [{ kind: "plugin", plugin: "greeter", name: "greet" }],
      },
      visibility: "private",
    },
  });
  expect(agent.status(), await agent.text()).toBe(201);
  const agentId = ((await agent.json()) as { agent: { id: string } }).agent.id;
  const conv = await page.request.post(`${base}/conversations`, {
    headers: CSRF,
    data: { agentId },
  });
  expect(conv.status(), await conv.text()).toBe(201);
  const convId = ((await conv.json()) as { conversation: { id: string } }).conversation.id;
  const first = await callGreet(page, convId);
  await expect(first.tool).toHaveAttribute("data-status", "done");
  await expect(first.reply).toHaveText(/bonjour from greeter/);

  // 6. 停用：确认框写明在途调用的等待时限；收敛后为已停用
  await page.goto("/zh/admin/plugins/greeter");
  await page.getByRole("button", { name: P.detail.actions.disable }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByText(P.detail.drainHint.replace("{seconds}", "30"), { exact: true }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: P.detail.disableConfirm.confirm }).click();
  await expect(page.getByText(P.status.disabled).first()).toBeVisible({ timeout: 60_000 });

  // 7. 再调用：工具已卸下，agent 拿到「工具不可用」的错误结果（没有重启内核）
  const second = await callGreet(page, convId);
  await expect(second.reply).toHaveText(/Unknown tool|no longer available|unavailable/);
  await expect(second.reply).not.toHaveText(/bonjour from greeter/);
});
