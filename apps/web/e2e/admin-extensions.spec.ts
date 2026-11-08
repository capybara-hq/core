import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { composer, replies, toolGroup } from "./support/chat";
import { signIn } from "./support/sign-in";

/** 界面文案取自 zh 文案文件，避免与实现重复硬编码。 */
const zh = JSON.parse(
  readFileSync(new URL("../messages/zh.json", import.meta.url), "utf8"),
) as typeof import("../messages/zh.json");

/** 内核要求非安全方法带的 CSRF 头。 */
const CSRF = { "X-Capybara-Csrf": "1" };
const P = zh.admin.extensions;

/** 在对话里让 model-fake 调用 greeter 的工具，返回这一轮工具行与助手回复。 */
async function callGreet(page: Page, convId: string) {
  await page.goto(`/chat/${convId}`);
  const input = composer(page);
  await input.fill("tool:plugin__greeter__greet:{}");
  await input.press("Enter");
  return {
    tool: toolGroup(page, "plugin__greeter__greet").last(),
    reply: replies(page).last(),
  };
}

test("admin extensions: import the plugin tgz -> review (acknowledge sensitive items) -> confirm installs and enables the extension -> edit deployment config -> call the tool in a conversation -> tool unavailable after disabling (no restart)", async ({
  page,
}) => {
  const tgz = process.env.CAPYBARA_E2E_GREETER_TGZ;
  expect(tgz, "global-setup 应写入 CAPYBARA_E2E_GREETER_TGZ").toBeTruthy();
  await signIn(page);

  // 1. Admin -> Plugins -> import a plugin package (uploads go through the plugin import page)
  await page.goto("/admin/extensions");
  await expect(page.locator('[data-template="ListPage"]')).toBeVisible();
  await page.goto("/admin/plugins/import");
  await expect(page.locator('[data-template="WizardPage"]')).toBeVisible();

  // 2. Choose the file (streamed through the same-origin proxy) -> review: the tool is a sensitive
  // item, highlighted with its reason
  await page.locator('input[type="file"]').setInputFiles({
    name: "greeter-1.0.0.tgz",
    mimeType: "application/gzip",
    buffer: readFileSync(tgz as string),
  });
  await page.getByRole("button", { name: zh.catalog.admin.review.fetch }).click();
  const review = page.getByRole("region", {
    name: zh.extensions.permissionsLabel.replace("{plugin}", "greeter"),
  });
  await expect(review).toBeVisible();
  await expect(review.getByText(zh.extensions.review.reason.tools)).toBeVisible();
  await expect(review.getByText("· greet")).toBeVisible();
  await page.getByRole("button", { name: P.wizard.next }).click();

  // 3. Confirm: not possible before the sensitive ack; confirming installs and enables the
  // extension on the deployment
  const confirm = page.getByRole("button", { name: zh.catalog.admin.review.confirm });
  await expect(confirm).toBeDisabled();
  await page.getByRole("checkbox", { name: zh.catalog.admin.review.ack }).check();
  await confirm.click();
  // A successful confirm opens the plugin's page; wait for it before leaving
  await expect(page).toHaveURL(/\/admin\/plugins\/[0-9a-f-]{36}$/);
  await page.goto("/admin/extensions/greeter");
  await expect(page.locator('[data-template="DetailPage"]')).toBeVisible();
  // Replicas converge to enabled (the page re-reads while converging)
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

  // 5. The org enables the extension; a new agent has its tool (tools default-on) and the call
  // succeeds in a conversation (reading the config just saved)
  const me = await page.request.get("/api/v1/me");
  const orgId = ((await me.json()) as { currentOrgId: string }).currentOrgId;
  const base = `/api/v1/orgs/${orgId}`;
  const enable = await page.request.put(`${base}/extensions/greeter`, {
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
  await expect(first.tool).toHaveAttribute("data-tool-status", "done");
  await expect(first.reply).toHaveText(/bonjour from greeter/);

  // 6. 停用：确认框写明在途调用的等待时限；收敛后为已停用
  await page.goto("/admin/extensions/greeter");
  await page.getByRole("button", { name: P.detail.actions.disable }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByText(P.detail.drainHint.replace("{seconds}", "30"), { exact: true }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: P.detail.disableConfirm.confirm }).click();
  await expect(page.getByText(P.status.disabled).first()).toBeVisible({ timeout: 60_000 });

  // 7. Call again: the tool is unloaded, so the agent no longer has it and gets the unknown-tool
  // error result (no kernel restart). Tools default-on: the agent never referenced the tool, so it
  // is simply gone from its tools (tools/pipeline.ts unknownToolText)
  const second = await callGreet(page, convId);
  await expect(second.tool).toHaveAttribute("data-tool-status", "failed");
  await expect(second.reply).toHaveText(
    /^Tool result: Unknown tool "plugin__greeter__greet"\. Available tools: /,
  );
});
