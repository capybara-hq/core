import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { signIn } from "./support/sign-in";

/** 界面文案取自 zh 文案文件，避免与实现重复硬编码。 */
const zh = JSON.parse(
  readFileSync(new URL("../messages/zh.json", import.meta.url), "utf8"),
) as typeof import("../messages/zh.json");

/** 内核要求非安全方法带的 CSRF 头。 */
const CSRF = { "X-Capybara-Csrf": "1" };

test("扩展视图（假扩展 fake-tools-ui）：fake-tools-ui__write 之后右侧「条目」标签实时刷新，badge 为「已完成/总数」；时间线显示工具摘要", async ({
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
  await expect(page.locator('[data-template="PlaygroundPage"]')).toBeVisible();
  const panel = page.getByRole("complementary");
  // 插件对话视图排在第一个；空清单的 badge 为 0/0
  const tasks = panel.getByRole("tab", { name: /条目/ });
  await expect(tasks).toBeVisible();
  await expect(tasks).toContainText("0/0");
  await expect(tasks).toHaveAttribute("aria-selected", "true");

  const items = {
    items: [
      { text: "Collect feedback", status: "completed" },
      { text: "Cluster topics", status: "in_progress" },
      { text: "Write the report", status: "pending" },
    ],
  };
  const input = page.getByLabel(zh.chat.inputLabel);
  await input.fill(`tool:fake-tools-ui__write:${JSON.stringify(items)}`);
  await input.press("Enter");

  // 不刷新页面：event: ui 到达后重新取视图，badge 与清单实时更新
  await expect(tasks).toContainText("1/3");
  const tabpanel = panel.getByRole("tabpanel");
  await expect(tabpanel.getByText("Collect feedback")).toBeVisible();
  // 进行中的条目以 aria-current 标出
  await expect(tabpanel.locator('[aria-current="step"]')).toContainText("Cluster topics");

  // 时间线里这次调用是一行带摘要的工具调用，不再显示原样 JSON
  const row = page.locator('[data-role="tool"]').filter({ hasText: "fake-tools-ui__write" });
  await expect(row).toHaveAttribute("data-status", "done");
  await expect(row.getByText("更新条目（3 项）")).toBeVisible();

  // 运行标签列出这次调用
  await panel.getByRole("tab", { name: new RegExp(zh.chatPanel.run) }).click();
  await expect(
    panel.locator('[data-role="run-call"]').getByRole("button", { name: /fake-tools-ui__write/ }),
  ).toBeVisible();

  // 刷新后记住所选标签（运行），条目标签的 badge 由视图重建
  await page.reload();
  await expect(
    page.getByRole("complementary").getByRole("tab", { name: new RegExp(zh.chatPanel.run) }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("complementary").getByRole("tab", { name: /条目/ })).toContainText(
    "1/3",
  );
});
