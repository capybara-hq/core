import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";

/** 界面文案取自 zh 文案文件，避免与实现重复硬编码。 */
const zh = JSON.parse(
  readFileSync(new URL("../messages/zh.json", import.meta.url), "utf8"),
) as typeof import("../messages/zh.json");

const LONG_TEXT = "Capybaras are the largest living rodents and very calm swimmers. "
  .repeat(4)
  .trim();
const SECOND_TEXT = "first answer arrives slowly";

const assistants = (page: Page) => page.locator('li[data-role="assistant"]');
const users = (page: Page) => page.locator('li[data-role="user"]');

async function send(page: Page, text: string) {
  const input = page.getByLabel(zh.chat.inputLabel);
  await input.fill(text);
  await input.press("Enter");
  await expect(users(page).filter({ hasText: text })).toHaveCount(1);
}

test("初始化 → 新建 agent → 流式回复、停止、插话、刷新后历史完整", async ({ page }) => {
  // 1. 初始化向导（同时建组织）→ 选当前组织 → 新建 agent（model-fake / fake-1）
  await page.goto("/zh");
  await expect(page).toHaveURL(/\/zh\/setup$/);
  await page.getByLabel(zh.setup.loginLabel).fill("admin");
  await page.getByLabel(zh.setup.passwordLabel).fill("correct-horse-battery");
  await page.getByLabel(zh.setup.displayNameLabel).fill("Admin");
  await page.getByLabel(zh.setup.orgNameLabel).fill("Acme");
  await page.getByRole("button", { name: zh.setup.submit }).click();

  await expect(page).toHaveURL(/\/zh$/);
  await page.getByLabel(zh.home.currentOrg).selectOption({ label: "Acme" });
  await page.getByRole("link", { name: zh.home.openAgents }).click();
  await expect(page).toHaveURL(/\/zh\/agents$/);
  await page.getByRole("link", { name: zh.agents.new }).click();

  await page.getByLabel(zh.agents.form.nameLabel).fill("Echo agent");
  await page
    .getByLabel(zh.agents.form.modelLabel, { exact: true })
    .selectOption("model-fake/fake-1");
  await page.getByRole("button", { name: zh.agents.form.submit }).click();
  await expect(page).toHaveURL(/\/zh\/agents$/);
  await expect(page.getByText("Echo agent")).toBeVisible();
  await page.getByRole("button", { name: zh.agents.startChat }).click();
  await expect(page).toHaveURL(/\/zh\/chat\/[^/]+$/);

  // 2. echo → 页面出现回复
  await send(page, "echo:hello capybara");
  await expect(assistants(page).last()).toHaveText(/hello capybara/);
  await expect(page.getByRole("button", { name: zh.chat.stop })).toHaveCount(0);

  // 3. slow 长文本：流式草稿逐步出现，运行中点「停止」→「已停止」，部分文本保留
  await send(page, `slow:300:${LONG_TEXT}`);
  const draft = page.locator('li[data-role="assistant"][data-streaming="true"] .body');
  await expect(draft).toHaveText(/.{8,}/);
  const early = (await draft.textContent()) ?? "";
  await expect(draft).not.toHaveText(early); // 继续增长：逐步出现
  await page.getByRole("button", { name: zh.chat.stop }).click();
  const stopped = page.locator('li[data-role="assistant"][data-stop-reason="aborted"]');
  await expect(stopped).toHaveCount(1);
  await expect(stopped.getByText(zh.chat.stopped)).toBeVisible();
  const partial = (await stopped.locator(".body").textContent()) ?? "";
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
  await expect(page.locator('li[data-streaming="true"]')).toHaveCount(0);

  const snapshot = async () =>
    page
      .locator('li[data-role="user"], li[data-role="assistant"]')
      .evaluateAll((els) =>
        els.map(
          (el) => `${el.getAttribute("data-role")}:${el.querySelector(".body")?.textContent}`,
        ),
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
});
