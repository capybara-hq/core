import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { signIn } from "./support/sign-in";

/** 界面文案取自 zh 文案文件，避免与实现重复硬编码。 */
const zh = JSON.parse(
  readFileSync(new URL("../messages/zh.json", import.meta.url), "utf8"),
) as typeof import("../messages/zh.json");

const LONG_TEXT = "Capybaras are the largest living rodents and very calm swimmers. "
  .repeat(4)
  .trim();
const SECOND_TEXT = "first answer arrives slowly";

const assistants = (page: Page) => page.locator('[data-role="assistant"]');
const users = (page: Page) => page.locator('[data-role="user"]');
/** 消息正文（MessageList 的 `[data-part="body"]`）。 */
const BODY = '[data-part="body"]';
/** DataTable 行菜单的触发按钮名称（设计系统文案 table.rowActions，zh）。 */
const ROW_ACTIONS = "行操作";

/** 在 Agents 列表里打开某个 agent 的行菜单并点「开始对话」。 */
async function startChat(page: Page, agentName: string) {
  await page
    .getByRole("row")
    .filter({ hasText: agentName })
    .getByRole("button", { name: ROW_ACTIONS })
    .click();
  await page.getByRole("menuitem", { name: zh.agents.startChat }).click();
}

async function send(page: Page, text: string) {
  const input = page.getByLabel(zh.chat.inputLabel);
  await input.fill(text);
  await input.press("Enter");
  await expect(users(page).filter({ hasText: text })).toHaveCount(1);
}

test("登录 → 新建 agent → 流式回复、停止、插话、刷新后历史完整", async ({ page }) => {
  // 1. 登录（初始化由 setup 项目完成）→ 选当前组织 → 新建 agent（model-fake / fake-1）
  await signIn(page);
  await expect(page.locator('[data-template="OverviewPage"]')).toBeVisible();
  await page.getByRole("link", { name: zh.home.openAgents }).click();
  await expect(page).toHaveURL(/\/zh\/agents$/);
  await expect(page.locator('[data-template="ListPage"]')).toBeVisible();
  await page.getByRole("link", { name: zh.agents.new }).click();

  await expect(page.locator('[data-template="FormPage"]')).toBeVisible();
  await page
    .getByRole("textbox", { name: zh.agents.form.nameLabel, exact: true })
    .fill("Echo agent");
  await page
    .getByRole("combobox", { name: zh.agents.form.modelLabel, exact: true })
    .selectOption("model-fake/fake-1");
  await page.getByRole("button", { name: zh.agents.form.submit }).click();
  await expect(page).toHaveURL(/\/zh\/agents$/);
  await expect(page.getByText("Echo agent")).toBeVisible();
  await startChat(page, "Echo agent");
  await expect(page).toHaveURL(/\/zh\/chat\/[^/]+$/);
  await expect(page.locator('[data-template="PlaygroundPage"]')).toBeVisible();
  // The sidebar lists the new conversation under its agent group, as the current row (the
  // conversation-groups endpoint, the web glue and the shell together; review m8).
  const sidebarConversations = page.getByRole("region", { name: "会话" });
  await expect(
    sidebarConversations.getByRole("button", { name: "Echo agent", exact: true }),
  ).toBeVisible();
  const conversationId = new URL(page.url()).pathname.split("/").at(-1) ?? "";
  await expect(sidebarConversations.locator(`a[href$="/chat/${conversationId}"]`)).toHaveAttribute(
    "aria-current",
    "page",
  );

  // 2. echo → 页面出现回复
  await send(page, "echo:hello capybara");
  await expect(assistants(page).last()).toHaveText(/hello capybara/);
  await expect(page.getByRole("button", { name: zh.chat.stop })).toHaveCount(0);

  // 3. slow 长文本：流式草稿逐步出现，运行中点「停止」→「已停止」，部分文本保留
  await send(page, `slow:300:${LONG_TEXT}`);
  const draft = page.locator(`[data-role="assistant"][data-streaming="true"] ${BODY}`);
  await expect(draft).toHaveText(/.{8,}/);
  const early = (await draft.textContent()) ?? "";
  await expect(draft).not.toHaveText(early); // 继续增长：逐步出现
  // 运行中输入框旁与 inspector 各有一个「停止」：点输入框旁的
  await page
    .locator("form")
    .filter({ has: page.getByLabel(zh.chat.inputLabel) })
    .getByRole("button", { name: zh.chat.stop })
    .click();
  const stopped = page.locator('[data-role="assistant"][data-stop-reason="aborted"]');
  await expect(stopped).toHaveCount(1);
  await expect(stopped.getByText(zh.chat.stopped)).toBeVisible();
  const partial = (await stopped.locator(BODY).textContent()) ?? "";
  expect(partial.length).toBeGreaterThan(0);
  expect(partial.length).toBeLessThan(LONG_TEXT.length);
  expect(LONG_TEXT.startsWith(partial)).toBe(true);
  await expect(page.getByRole("button", { name: zh.chat.stop })).toHaveCount(0);

  // 4. slow 回复进行中插话：两条都得到回复，插话的回复在第一条之后
  await send(page, `slow:200:${SECOND_TEXT}`);
  await expect(draft).toHaveText(/.+/);
  await expect(page.getByLabel(zh.chat.inputLabel)).toBeEnabled();
  await send(page, "echo:interject");
  await expect(assistants(page).filter({ hasText: SECOND_TEXT })).toHaveCount(1);
  await expect(assistants(page).filter({ hasText: /^.*interject$/ })).toHaveCount(1);
  await expect(page.getByRole("button", { name: zh.chat.stop })).toHaveCount(0);
  await expect(page.locator('[data-streaming="true"]')).toHaveCount(0);

  const snapshot = async () =>
    page
      .locator('[data-role="user"], [data-role="assistant"]')
      .evaluateAll(
        (els, body) =>
          els.map((el) => `${el.getAttribute("data-role")}:${el.querySelector(body)?.textContent}`),
        BODY,
      );
  const before = await snapshot();
  const firstIdx = before.indexOf(`assistant:${SECOND_TEXT}`);
  const interjectIdx = before.indexOf("assistant:interject");
  expect(firstIdx).toBeGreaterThanOrEqual(0);
  expect(interjectIdx).toBeGreaterThan(firstIdx);

  // 5. 刷新 → 历史完整（含「已停止」标记）
  await page.reload();
  await expect(assistants(page)).toHaveCount(
    before.filter((s) => s.startsWith("assistant:")).length,
  );
  expect(await snapshot()).toEqual(before);
  await expect(stopped.getByText(zh.chat.stopped)).toBeVisible();
  expect(before).toEqual([
    "user:echo:hello capybara",
    "assistant:hello capybara",
    `user:slow:300:${LONG_TEXT}`,
    `assistant:${partial}`,
    `user:slow:200:${SECOND_TEXT}`,
    "user:echo:interject",
    `assistant:${SECOND_TEXT}`,
    "assistant:interject",
  ]);

  // 6. 新建 agent 时按模型声明设置参数：model-fake.style = shout → 回复为大写
  await page.goto("/zh/agents");
  await page.getByRole("link", { name: zh.agents.new }).click();
  await page
    .getByRole("textbox", { name: zh.agents.form.nameLabel, exact: true })
    .fill("Shout agent");
  await page
    .getByRole("combobox", { name: zh.agents.form.modelLabel, exact: true })
    .selectOption("model-fake/fake-1");
  const params = page.getByRole("region", { name: zh.agents.form.modelParamsTitle, exact: true });
  // 文案来自插件声明（zh）
  await params.getByRole("combobox", { name: "回复风格" }).selectOption("shout");
  await page.getByRole("button", { name: zh.agents.form.submit }).click();
  await expect(page).toHaveURL(/\/zh\/agents$/);
  await startChat(page, "Shout agent");
  await expect(page).toHaveURL(/\/zh\/chat\/[^/]+$/);
  await send(page, "echo:quiet please");
  await expect(assistants(page).last().locator(BODY)).toHaveText("QUIET PLEASE");

  // 7. 未匹配的路径：HTTP 404，App Shell 内的 StatusPage 404
  const missing = await page.goto("/zh/nope");
  expect(missing?.status()).toBe(404);
  await expect(page.locator('[data-template="StatusPage"][data-kind="404"]')).toBeVisible();
  await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible();
  await expect(page.getByText(zh.notFound.title).first()).toBeVisible();
});
