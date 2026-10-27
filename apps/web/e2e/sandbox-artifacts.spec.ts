import { expect, type Page, test } from "@playwright/test";
import { composer, currentOrg, designZh, replies, zh } from "./support/chat";
import { signIn } from "./support/sign-in";

/** 内核要求非安全方法带的 CSRF 头。 */
const CSRF = { "X-Capybara-Csrf": "1" };

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
  await expect(page.locator('[data-template="ConversationPage"]')).toBeVisible();
  return { orgId: orgId as unknown as string, convId };
}

/** 发一条消息并等这一轮的回复（model-fake 在工具结果后回 `Tool result: …`）。 */
async function send(page: Page, text: string, count: number) {
  const input = composer(page);
  await input.fill(text);
  await input.press("Enter");
  await expect(replies(page)).toHaveCount(count);
}

test("sandbox_write + sandbox_deliver：文件卡片实时出现，右侧预览为表格，能下载；属性面板列出文件与沙箱运行中", async ({
  page,
}) => {
  const { convId } = await openSandboxChat(page);
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

  // SSE 收到 artifact_created：不刷新页面，文件卡片出现在交付它的工具组之后
  const card = page.locator('[data-entry="files"]').getByRole("button", { name: /fruit\.csv/ });
  await expect(card).toBeVisible();
  await expect(card.getByText("CSV", { exact: true })).toBeVisible();
  await card.click();
  // 右侧文件面板：CSV 用内置表格预览
  const panel = page.getByRole("complementary", { name: "fruit.csv" });
  await expect(panel.getByRole("table")).toBeVisible();
  await expect(panel.getByText("apple")).toBeVisible();
  await expect(page).toHaveURL(/#file=/);

  // 下载：同源地址 302 到预签名地址（attachment），内容就是写入的文件
  const fileId = decodeURIComponent(new URL(page.url()).hash.replace("#file=", ""));
  const res = await page.request.get(
    `/api/v1/orgs/${await currentOrg(page)}/conversations/${convId}/artifacts/${fileId}/download`,
  );
  expect(res.status()).toBe(200);
  expect(await res.text()).toBe(content);
  expect(res.headers()["content-disposition"]).toContain("attachment");
  expect(res.headers()["content-disposition"]).toContain("fruit.csv");

  // 属性面板：文件与上下文（沙箱运行中）
  await page.getByRole("button", { name: designZh("titlebar.properties") }).click();
  const props = page.getByRole("complementary", { name: designZh("props.label") });
  await expect(props.getByText("fruit.csv")).toBeVisible();
  await expect(props.getByText(new RegExp(zh.chatPanel.sandboxRunning))).toBeVisible();
});
