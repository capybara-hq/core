import { expect, type Page, test } from "@playwright/test";
import { designZh, replies, send, startChat, zh } from "./support/chat";
import { signIn } from "./support/sign-in";

const LONG_TEXT = "Capybaras are the largest living rodents and very calm swimmers. "
  .repeat(4)
  .trim();
const SECOND_TEXT = "first answer arrives slowly";

/** Assistant prose (`data-streaming` on its entry while it streams). */
const assistants = replies;
const stopButton = (page: Page) => page.getByRole("button", { name: designZh("composer.stop") });

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
  // 2. echo → 页面出现回复（第一条消息才创建会话）
  await send(page, "echo:hello capybara");
  await expect(assistants(page).last()).toHaveText(/hello capybara/);
  await expect(stopButton(page)).toHaveCount(0);
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

  // 3. slow 长文本：流式草稿逐步出现，运行中点「停止」→「已停止」，部分文本保留
  await send(page, `slow:300:${LONG_TEXT}`);
  const draft = page.locator('[data-entry="prose"][data-streaming="true"] [data-part="prose"]');
  await expect(draft).toHaveText(/.{8,}/);
  const early = (await draft.textContent()) ?? "";
  await expect(draft).not.toHaveText(early); // 继续增长：逐步出现
  // 运行中「发送」变成「停止」
  await stopButton(page).click();
  const stopped = page.locator('[data-divider="stopped"]');
  await expect(stopped).toHaveCount(1);
  const partial = ((await assistants(page).last().textContent()) ?? "").trim();
  expect(partial.length).toBeGreaterThan(0);
  expect(partial.length).toBeLessThan(LONG_TEXT.length);
  expect(LONG_TEXT.startsWith(partial)).toBe(true);
  await expect(stopButton(page)).toHaveCount(0);

  // 4. slow 回复进行中插话：两条都得到回复，插话的回复在第一条之后
  await send(page, `slow:200:${SECOND_TEXT}`);
  await expect(draft).toHaveText(/.+/);
  await expect(page.getByRole("textbox", { name: zh.chat.inputLabel })).toBeEnabled();
  await send(page, "echo:interject");
  await expect(assistants(page).filter({ hasText: SECOND_TEXT })).toHaveCount(1);
  await expect(assistants(page).filter({ hasText: /^.*interject$/ })).toHaveCount(1);
  await expect(stopButton(page)).toHaveCount(0);
  await expect(page.locator('[data-streaming="true"]')).toHaveCount(0);

  const snapshot = async () =>
    page
      .locator('[data-entry="user"], [data-entry="prose"]')
      .evaluateAll((els) =>
        els.map((el) =>
          el.getAttribute("data-entry") === "user"
            ? `user:${el.querySelector('[data-part="bubble"]')?.textContent}`
            : `assistant:${el.querySelector('[data-part="prose"]')?.textContent?.trim()}`,
        ),
      );
  const before = await snapshot();
  const firstIdx = before.indexOf(`assistant:${SECOND_TEXT}`);
  const interjectIdx = before.indexOf("assistant:interject");
  expect(firstIdx).toBeGreaterThanOrEqual(0);
  expect(interjectIdx).toBeGreaterThan(firstIdx);

  // 5. 刷新 → 历史完整（含「已停止」分隔线）
  await page.reload();
  await expect(assistants(page)).toHaveCount(
    before.filter((s) => s.startsWith("assistant:")).length,
  );
  expect(await snapshot()).toEqual(before);
  await expect(stopped).toHaveCount(1);
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
  await send(page, "echo:quiet please");
  await expect(assistants(page).last()).toHaveText("QUIET PLEASE");

  // 7. 未匹配的路径：HTTP 404，App Shell 内的 StatusPage 404
  const missing = await page.goto("/zh/nope");
  expect(missing?.status()).toBe(404);
  await expect(page.locator('[data-template="StatusPage"][data-kind="404"]')).toBeVisible();
  await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible();
  await expect(page.getByText(zh.notFound.title).first()).toBeVisible();
});
