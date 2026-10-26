import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { signIn } from "./support/sign-in";

/** 界面文案取自 zh 文案文件，避免与实现重复硬编码。 */
const _zh = JSON.parse(
  readFileSync(new URL("../messages/zh.json", import.meta.url), "utf8"),
) as typeof import("../messages/zh.json");

/** 内核要求非安全方法带的 CSRF 头。 */
const CSRF = { "X-Capybara-Csrf": "1" };

test("example-board：「扩展」打开看板（沙箱 iframe、令牌校验通过），另一个浏览器上下文改状态后实时刷新；对话里有看板标签", async ({
  page,
  browser,
}) => {
  await signIn(page);
  const me = await page.request.get("/api/v1/me");
  const orgId = ((await me.json()) as { currentOrgId: string }).currentOrgId;
  const base = `/api/v1/orgs/${orgId}`;
  const enable = await page.request.put(`${base}/extensions/example-board`, {
    headers: CSRF,
    data: { enabled: true },
  });
  expect(enable.status(), await enable.text()).toBe(200);

  // 经同源代理、用嵌入令牌建一张卡（令牌不能调内核 /api）
  const issued = await page.request.post(`${base}/ui/embeds/example-board/board/token`, {
    headers: CSRF,
    data: {},
  });
  expect(issued.status(), await issued.text()).toBe(200);
  const { token, src } = (await issued.json()) as { token: string; src: string };
  expect(src).toBe("/plugin-ui/example-board/board");
  const title = `Ship ${Date.now()}`;
  const created = await page.request.post("/plugin-ui/example-board/cards", {
    headers: { authorization: `Bearer ${token}` },
    data: { title },
  });
  expect(created.status(), await created.text()).toBe(201);
  expect(created.headers()["content-security-policy"]).toContain("frame-ancestors 'self'");
  expect(created.headers()["set-cookie"]).toBeUndefined();
  const asApi = await page.request.fetch("/api/v1/me", {
    headers: { authorization: `Bearer ${token}`, cookie: "" },
  });
  expect(asApi.status()).toBe(401);

  // ---- sidebar Extensions → 看板 ----
  await page.goto("/zh");
  // The sidebar's Extensions group lists the page by its title
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("link", { name: "看板", exact: true })
    .click();
  await expect(page).toHaveURL(/\/zh\/p\/example-board\/board$/);
  const iframe = page.locator('iframe[title="看板"]');
  await expect(iframe).toHaveAttribute("sandbox", "allow-scripts allow-forms");
  await expect(iframe).toHaveAttribute("src", src);
  const board = page.frameLocator('iframe[title="看板"]');
  // 卡片读出来了：iframe 收到 init、带令牌经代理取数、插件校验通过
  const todo = board.getByRole("region", { name: "待办" });
  await expect(todo.getByRole("article", { name: title })).toBeVisible();
  await expect(board.getByRole("status")).toHaveText("实时");

  // ---- 第二个浏览器上下文改状态，第一个实时刷新 ----
  const other = await browser.newContext({ storageState: await page.context().storageState() });
  try {
    const page2 = await other.newPage();
    await page2.goto("/zh/p/example-board/board");
    const board2 = page2.frameLocator('iframe[title="看板"]');
    await board2.getByRole("button", { name: `${title}: 移到 进行中` }).click();
    await expect(
      board2.getByRole("region", { name: "进行中" }).getByRole("article", { name: title }),
    ).toBeVisible();
  } finally {
    await other.close();
  }
  await expect(
    board.getByRole("region", { name: "进行中" }).getByRole("article", { name: title }),
  ).toBeVisible();
  await expect(todo.getByRole("article", { name: title })).toHaveCount(0);

  // ---- 对话右侧的看板标签（board-conv） ----
  const agent = await page.request.post(`${base}/agents`, {
    headers: CSRF,
    data: {
      definition: {
        name: "Boarder",
        instructions: "Help with the board.",
        model: { provider: "model-fake", model: "fake-1" },
        tools: [],
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
  const panel = page.getByRole("complementary");
  const tab = panel.getByRole("tab", { name: "看板" });
  await expect(tab).toBeVisible();
  await tab.click();
  const convFrame = panel.locator('iframe[title="看板"]');
  await expect(convFrame).toHaveAttribute("sandbox", "allow-scripts allow-forms");
  await expect(convFrame).toHaveAttribute("src", "/plugin-ui/example-board/board-conv");
  const convBoard = panel.frameLocator('iframe[title="看板"]');
  // 对话里的看板只看这个对话的卡片：组织页面建的卡片不在这里
  await expect(convBoard.getByRole("status")).toHaveText("实时");
  await expect(convBoard.getByRole("article", { name: title })).toHaveCount(0);
  await convBoard.getByRole("textbox", { name: "新卡片标题" }).fill("Conversation card");
  await convBoard.getByRole("button", { name: "添加卡片" }).click();
  await expect(
    convBoard
      .getByRole("region", { name: "待办" })
      .getByRole("article", { name: "Conversation card" }),
  ).toBeVisible();
  // iframe 发来的提示由外层显示
  await expect(page.getByText("已添加卡片")).toBeVisible();
});
