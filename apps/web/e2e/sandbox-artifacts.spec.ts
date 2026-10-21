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

/**
 * 登录（若尚未初始化则走初始化向导），并选中组织 Acme。未初始化时首页先到登录页再跳到初始化向导，
 * 所以等地址落到 /zh/setup 或 /zh/login 之后再判断（单独运行本文件时也成立）。
 */
async function signIn(page: Page) {
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

/** 经同源代理建一个带沙箱工具的 fake-1 agent 与会话，打开对话页。 */
async function openSandboxChat(page: Page): Promise<{ orgId: string; convId: string }> {
  await signIn(page);
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
        name: "Sandbox agent",
        instructions: "Use the sandbox.",
        model: { provider: "model-fake", model: "fake-1" },
        tools: ["sandbox_write", "sandbox_deliver"].map((name) => ({ kind: "builtin", name })),
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
  return { orgId: orgId as unknown as string, convId };
}

/** 发一条消息并等这一轮的回复（model-fake 在工具结果后回 `Tool result: …`）。 */
async function send(page: Page, text: string, replies: number) {
  const input = page.getByLabel(zh.chat.inputLabel);
  await input.fill(text);
  await input.press("Enter");
  await expect(page.locator('[data-role="assistant"]')).toHaveCount(replies);
}

test("sandbox_write + sandbox_deliver：产物标签实时出现（带数量），文本预览开头，能下载；上下文显示沙箱运行中", async ({
  page,
}) => {
  const { convId } = await openSandboxChat(page);
  const panel = page.getByRole("complementary");
  const artifactsTab = panel.getByRole("tab", { name: new RegExp(zh.chatPanel.artifacts) });
  // 还没有产物：没有这个标签
  await expect(panel.getByRole("tab", { name: new RegExp(zh.chatPanel.run) })).toBeVisible();
  await expect(artifactsTab).toHaveCount(0);

  const content = "name,qty\napple,3\npear,5\n";
  await send(
    page,
    `tool:sandbox_write:${JSON.stringify({ path: "/workspace/out/fruit.csv", content })}`,
    1,
  );
  await send(
    page,
    `tool:sandbox_deliver:${JSON.stringify({ path: "/workspace/out/fruit.csv" })}`,
    2,
  );

  // SSE 收到 artifact_created：不刷新页面，标签出现并带数量
  await expect(artifactsTab).toBeVisible();
  await expect(artifactsTab).toContainText("1");
  await artifactsTab.click();
  const card = panel.getByRole("group", { name: "fruit.csv" });
  await expect(card).toBeVisible();
  await expect(card.getByText("CSV", { exact: true })).toBeVisible();
  await expect(card.getByText(`${content.length} B`)).toBeVisible();
  // 文本类：显示开头几行（纯文本）
  await expect(card.locator("pre")).toContainText("apple,3");

  // 下载：同源地址 302 到预签名地址（attachment），内容就是写入的文件
  const link = card.getByRole("link").filter({ hasText: zh.chatPanel.download });
  const href = await link.getAttribute("href");
  expect(href).toMatch(new RegExp(`/conversations/${convId}/artifacts/[^/]+/download$`));
  const res = await page.request.get(href as string);
  expect(res.status()).toBe(200);
  expect(await res.text()).toBe(content);
  expect(res.headers()["content-disposition"]).toContain("attachment");
  expect(res.headers()["content-disposition"]).toContain("fruit.csv");

  // 上下文标签：沙箱运行中
  await panel.getByRole("tab", { name: new RegExp(zh.chatPanel.context) }).click();
  await expect(panel.getByText(zh.chatPanel.sandboxRunning)).toBeVisible();
  await expect(panel.getByText(zh.chatPanel.sandboxLastUsed)).toBeVisible();
});
