import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";

/** 界面文案取自 zh 文案文件，避免与实现重复硬编码。 */
const zh = JSON.parse(
  readFileSync(new URL("../messages/zh.json", import.meta.url), "utf8"),
) as typeof import("../messages/zh.json");

const LOGIN = "admin";
const PASSWORD = "correct-horse-battery";
/** 内核要求非安全方法带的 CSRF 头。 */
const CSRF = { "X-Capybara-Csrf": "1" };

/** 登录（若尚未初始化则走初始化向导），并选中组织 Acme。 */
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
}

/** 登录后经同源代理建一个 fake-1 的 agent 与会话，打开对话页，返回输入框所在的表单。 */
async function openChat(page: Page, agentName: string) {
  await signIn(page);
  // 选组织是异步的：等 /me 里出现当前组织
  let orgId: string | null = null;
  await expect
    .poll(async () => {
      const me = await page.request.get("/api/v1/me");
      orgId = me.ok() ? ((await me.json()) as { currentOrgId: string | null }).currentOrgId : null;
      return orgId;
    })
    .not.toBeNull();
  const base = `/api/v1/orgs/${orgId}`;
  const agent = await page.request.post(`${base}/agents`, {
    headers: CSRF,
    data: {
      definition: {
        name: agentName,
        instructions: "Look at the attached files.",
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
  await page.goto(`/zh/chat/${convId}`);
  await expect(page.locator('[data-template="PlaygroundPage"]')).toBeVisible();
  return page.locator("form").filter({ has: page.getByLabel(zh.chat.inputLabel) });
}

/**
 * 测试工具包的媒体样本（按路径加载源码，与 global-setup 加载假服务一样，不作为 apps/web 的包依赖）。
 */
const mediaSamples = fileURLToPath(
  new URL("../../../packages/testing/src/media-samples.ts", import.meta.url),
);

test("上传 PNG：进度后就绪、随消息发送；时间线显示缩略图，模型收到 image 块", async ({ page }) => {
  const composer = await openChat(page, "Vision agent");

  // 选文件：经隐藏的 file input（「添加文件」按钮打开的就是它）
  const { solidPngBase64 } = (await import(mediaSamples)) as {
    solidPngBase64: (rgb: [number, number, number], size?: number) => string;
  };
  const png = Buffer.from(solidPngBase64([255, 0, 0], 32), "base64");
  await composer.locator('input[type="file"]').setInputFiles({
    name: "red.png",
    mimeType: "image/png",
    buffer: png,
  });
  const files = composer.getByRole("group", { name: zh.chat.files });
  await expect(files.getByText("red.png")).toBeVisible();
  // 直传到 S3（跨源）并 finalize 后进度条消失、可以发送
  await expect(files.getByRole("progressbar")).toHaveCount(0);
  await expect(files.getByRole("alert")).toHaveCount(0);

  const input = page.getByLabel(zh.chat.inputLabel);
  await input.fill("media:");
  await expect(composer.getByRole("button", { name: zh.chat.send })).toBeEnabled();
  await input.press("Enter");

  // 发送后输入框的文件清空；时间线里的用户消息显示缩略图，图片经 download 302 加载成功
  await expect(files).toHaveCount(0);
  const user = page.locator('[data-role="user"]').filter({ hasText: "media:" });
  const thumb = user.getByRole("img", { name: "red.png" });
  await expect(thumb).toBeVisible();
  await expect(thumb).toHaveAttribute(
    "src",
    /\/api\/v1\/orgs\/[^/]+\/attachments\/[^/]+\/download$/,
  );
  await expect
    .poll(() => thumb.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth))
    .toBe(32);

  // model-fake 的 media: 指令回显它收到的媒体块：是 image 块且带着原字节（不是文字占位）
  const reply = page.locator('[data-role="assistant"]').last();
  await expect(reply).toHaveText(
    new RegExp(`Media: image image/png ${png.length} bytes red\\.png`),
  );
});

test("前端拦下不允许的类型：显示与内核错误码一致的文案，不能发送，移除后恢复", async ({ page }) => {
  const composer = await openChat(page, "Files agent");
  await composer.locator('input[type="file"]').setInputFiles({
    name: "a.zip",
    mimeType: "application/zip",
    buffer: Buffer.from("PK"),
  });
  const files = composer.getByRole("group", { name: zh.chat.files });
  await expect(files.getByRole("alert")).toHaveText(zh.errors.attachment.type_not_allowed);
  await page.getByLabel(zh.chat.inputLabel).fill("echo:hi");
  await expect(composer.getByRole("button", { name: zh.chat.send })).toBeDisabled();
  await files.getByRole("button", { name: "移除 a.zip" }).click();
  await expect(files).toHaveCount(0);
  await expect(composer.getByRole("button", { name: zh.chat.send })).toBeEnabled();
});
