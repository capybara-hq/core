import { expect, type Page, test } from "@playwright/test";
import {
  designZh,
  interject,
  openAgentSection,
  replies,
  saveSection,
  send,
  startChat,
  zh,
} from "./support/chat";
import { selectOption } from "./support/select";
import { signIn } from "./support/sign-in";

const LONG_TEXT = "Capybaras are the largest living rodents and very calm swimmers. "
  .repeat(4)
  .trim();
const SECOND_TEXT = "first answer arrives slowly";

/** Assistant prose (`data-streaming` on its entry while it streams). */
const assistants = replies;
// exact: a stopped run's row is named "… 已停止 …" too
const stopButton = (page: Page) =>
  page.getByRole("button", { name: designZh("composer.stop"), exact: true });

test("登录 → 新建 agent → 流式回复、停止、插话、刷新后历史完整", async ({ page }) => {
  // 1. 登录（初始化由 setup 项目完成）→ 选当前组织 → 新建 agent（model-fake / fake-1）
  await signIn(page);
  await expect(page.locator('[data-template="OverviewPage"]')).toBeVisible();
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("link", { name: zh.nav.agents })
    .click();
  await expect(page).toHaveURL(/\/agents$/);
  await expect(page.locator('[data-template="ListPage"]')).toBeVisible();
  await page.getByRole("link", { name: zh.agents.new }).click();

  await expect(page.locator('[data-template="FormPage"]')).toBeVisible();
  await page
    .getByRole("textbox", { name: zh.agents.form.nameLabel, exact: true })
    .fill("Echo agent");
  await selectOption(
    page.getByRole("combobox", { name: zh.agents.form.modelLabel, exact: true }),
    "model-fake/fake-1",
  );
  await page.getByRole("button", { name: zh.agents.form.submit }).click();
  // a new agent lands on its page's prompt section (agent profile design §2.4)
  await expect(page).toHaveURL(/\/agents\/[^/?#]+\?s=prompt$/);
  await expect(page.getByRole("heading", { name: "Echo agent" })).toBeVisible();
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
  const stopped = page.locator('[data-run-status="stopped"]');
  await expect(stopped).toHaveCount(1);
  const partial = ((await assistants(page).last().textContent()) ?? "").trim();
  expect(partial.length).toBeGreaterThan(0);
  expect(partial.length).toBeLessThan(LONG_TEXT.length);
  expect(LONG_TEXT.startsWith(partial)).toBe(true);
  await expect(stopButton(page)).toHaveCount(0);

  // 4. slow 回复进行中插话（↵ 与 ⌘↵ 相同，没有队列）：两条都得到回复，插话排在它被接收的位置，
  // 即第一条回复之后（run input spec D4）
  await send(page, `slow:200:${SECOND_TEXT}`);
  await expect(draft).toHaveText(/.+/);
  await expect(page.getByRole("textbox", { name: zh.chat.inputLabel })).toBeEnabled();
  await interject(page, "echo:interject");
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
    `assistant:${SECOND_TEXT}`,
    "user:echo:interject",
    "assistant:interject",
  ]);

  // 6. 按模型声明设置参数（agent 页面的「模型」分组）：model-fake.style = shout → 回复为大写
  await page.goto("/agents");
  await page.getByRole("link", { name: zh.agents.new }).click();
  await page
    .getByRole("textbox", { name: zh.agents.form.nameLabel, exact: true })
    .fill("Shout agent");
  await selectOption(
    page.getByRole("combobox", { name: zh.agents.form.modelLabel, exact: true }),
    "model-fake/fake-1",
  );
  await page.getByRole("button", { name: zh.agents.form.submit }).click();
  await expect(page).toHaveURL(/\/agents\/[^/?#]+\?s=prompt$/);
  await openAgentSection(page, "model");
  const params = page.getByRole("region", { name: zh.agents.form.modelParamsTitle, exact: true });
  // 文案来自插件声明（zh）
  await selectOption(params.getByRole("combobox", { name: "回复风格" }), "shout");
  await saveSection(page);
  await startChat(page, "Shout agent");
  await send(page, "echo:quiet please");
  await expect(assistants(page).last()).toHaveText("QUIET PLEASE");

  // 7. 未匹配的路径：HTTP 404，App Shell 内的 StatusPage 404
  const missing = await page.goto("/nope");
  expect(missing?.status()).toBe(404);
  await expect(page.locator('[data-template="StatusPage"][data-kind="404"]')).toBeVisible();
  await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible();
  await expect(page.getByText(zh.notFound.title).first()).toBeVisible();

  // 8. A missing object (a conversation that does not exist) is the not-found state inside the
  //    App Shell with HTTP 200 (web query cache spec §3.3); only an unknown route is a 404
  const gone = await page.goto("/chat/00000000-0000-4000-8000-000000000000");
  expect(gone?.status()).toBe(200);
  await expect(page.locator('[data-template="StatusPage"][data-kind="404"]')).toBeVisible();
  await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible();
});
