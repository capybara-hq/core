import { expect, test } from "@playwright/test";
import { designZh, zh } from "./support/chat";
import { signIn } from "./support/sign-in";

const P = zh.admin.extensions;

/**
 * The hinted config form (extension config forms spec §9 e2e, step 1) on the fixture
 * `fake-config-form` (表单样例), which global-setup declares without config so it starts pending
 * configuration: an openai-compatible-shaped schema with an endpoint preset menu, an API key drawn
 * in each endpoint card (stored in the secret record `apiKeys` by endpoint name) and model rows.
 * The field labels are the fixture's hints (packages/testing/fixtures/extensions/fake-config-form).
 */
test("extension config form: the list shows the display name with the id as meta; add the DeepSeek preset, set its key, add a model row, save; after a reload the endpoint card shows the key as set", async ({
  page,
}) => {
  await signIn(page);

  // 1. The list row reads the display name; the id stays visible as meta
  await page.goto("/admin/extensions");
  await expect(page.locator('[data-template="ListPage"]')).toBeVisible();
  const link = page.getByRole("link", { name: "表单样例" });
  const row = page.locator("li").filter({ has: link });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("fake-config-form");
  await expect(row).toContainText(P.status.pending_config);

  // 2. The detail page opens on the config tab (pending configuration)
  await link.click();
  await expect(page).toHaveURL(/\/admin\/extensions\/fake-config-form$/);
  await expect(page.locator('[data-template="DetailPage"]')).toBeVisible();
  await page.getByRole("tab", { name: P.detail.tabs.config }).click();

  // 3. 添加端点 opens the presets plus 空白; DeepSeek fills name, base URL and dialect
  const endpoints = page.getByRole("group", { name: "端点", exact: true });
  await endpoints.getByRole("button", { name: "添加端点" }).click();
  await expect(page.getByRole("menuitem", { name: "通义千问（百炼）" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: designZh("repeater.blank") })).toBeVisible();
  await page.getByRole("menuitem", { name: "DeepSeek", exact: true }).click();
  const card = endpoints.getByRole("group", { name: "deepseek", exact: true });
  await expect(card).toBeVisible();
  await expect(card.getByLabel("名称", { exact: true })).toHaveValue("deepseek");
  await expect(card.getByLabel("接口地址", { exact: true })).toHaveValue(
    "https://api.deepseek.com",
  );

  // 4. The endpoint's API key (stored under apiKeys.deepseek) and one model row
  const key = card.getByLabel("API 密钥", { exact: true });
  await expect(key).toHaveAttribute("type", "password");
  await key.fill("sk-e2e-config-form");
  const models = card.getByRole("group", { name: "模型", exact: true });
  await models.getByRole("button", { name: "添加模型" }).click();
  await models.getByLabel("模型 ID", { exact: true }).fill("deepseek-chat");
  await models.getByLabel("上下文窗口", { exact: true }).fill("65536");
  await models.getByLabel("最大输出", { exact: true }).fill("8192");

  // 5. Save: the extension reloads with the new config
  const save = page.getByRole("button", { name: P.config.save });
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.getByText(P.config.saved)).toBeVisible();

  // 6. After a reload the card is there, its key shows as set (never the value), the row kept
  await page.reload();
  await page.getByRole("tab", { name: P.detail.tabs.config }).click();
  const saved = page
    .getByRole("group", { name: "端点", exact: true })
    .getByRole("group", { name: "deepseek", exact: true });
  await expect(saved).toBeVisible();
  const savedKey = saved.getByLabel("API 密钥", { exact: true });
  await expect(savedKey).toHaveValue("");
  await expect(savedKey).toHaveAttribute("placeholder", zh.configForm.secretSet);
  await expect(saved.getByLabel("模型 ID", { exact: true })).toHaveValue("deepseek-chat");
  await expect(page.getByText("sk-e2e-config-form")).toHaveCount(0);
});
