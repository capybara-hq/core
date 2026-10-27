import { expect, test } from "@playwright/test";
import { composer, toolGroup } from "./support/chat";
import { signIn } from "./support/sign-in";

/** 内核要求非安全方法带的 CSRF 头。 */
const CSRF = { "X-Capybara-Csrf": "1" };

test("扩展视图（假扩展 fake-tools-ui）：fake-tools-ui__write 之后右侧「条目」面板实时刷新，badge 为「已完成/总数」；时间线显示工具摘要", async ({
  page,
}) => {
  await signIn(page);
  // 页面的 Cookie 与 page.request 共用：经同源代理调内核 API 做准备工作
  const me = await page.request.get("/api/v1/me");
  expect(me.ok()).toBe(true);
  const orgId = ((await me.json()) as { currentOrgId: string }).currentOrgId;
  const base = `/api/v1/orgs/${orgId}`;
  const enable = await page.request.put(`${base}/extensions/fake-tools-ui`, {
    headers: CSRF,
    data: { enabled: true },
  });
  expect(enable.status(), await enable.text()).toBe(200);
  // 网页的 agent 表单不列插件工具：经 API 建一个引用 fake-tools-ui__write 的 agent
  const agent = await page.request.post(`${base}/agents`, {
    headers: CSRF,
    data: {
      definition: {
        name: "Planner",
        instructions: "Keep a task list.",
        model: { provider: "model-fake", model: "fake-1" },
        tools: [{ kind: "plugin", plugin: "fake-tools-ui", name: "write" }],
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
  // The extension's panel (its old `place: "conversation"`) is an icon in the title bar
  const icon = page.locator('[data-part="title-bar"]').getByRole("button", { name: "条目" });
  await expect(icon).toBeVisible();
  await icon.click();
  const panel = page.getByRole("complementary", { name: "条目" });
  // 空清单的 badge 为 0/0（在面板标题后）
  await expect(panel.locator('[data-part="panel-meta"]')).toHaveText("0/0");

  const items = {
    items: [
      { text: "Collect feedback", status: "completed" },
      { text: "Cluster topics", status: "in_progress" },
      { text: "Write the report", status: "pending" },
    ],
  };
  const input = composer(page);
  await input.fill(`tool:fake-tools-ui__write:${JSON.stringify(items)}`);
  await input.press("Enter");

  // 不刷新页面：event: ui 到达后重新取视图，badge 与清单实时更新
  await expect(panel.locator('[data-part="panel-meta"]')).toHaveText("1/3");
  await expect(panel.getByText("Collect feedback")).toBeVisible();
  // 进行中的条目以 aria-current 标出
  await expect(panel.locator('[aria-current="step"]')).toContainText("Cluster topics");

  // 时间线里这次调用是一行带摘要的工具调用，不再显示原样 JSON
  const row = toolGroup(page, "fake-tools-ui__write");
  await expect(row).toHaveAttribute("data-tool-status", "done");
  await expect(row).toContainText("更新条目（3 项）");

  // 刷新后面板仍开着（地址里的 #panel=），badge 由视图重建
  await expect(page).toHaveURL(/#panel=fake-tools-ui\/tasks$/);
  await page.reload();
  await expect(
    page.getByRole("complementary", { name: "条目" }).locator('[data-part="panel-meta"]'),
  ).toHaveText("1/3");
});
