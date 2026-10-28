import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { composer, replies, startChat, toolGroup } from "./support/chat";
import { signIn } from "./support/sign-in";

/*
 * The install wizard's OpenAPI flow (connector kind `openapi`) on the core fake `fake-openapi` of
 * `@capybara-hq/testing`: the document's security schemes prefill the auth step, its operations
 * fill the operations table, the selection decides the tools, and an agent calls one through the
 * approval. connector-openapi's own parsing of OpenAPI documents is tested with that plugin (in
 * the plugins repository after the split).
 */

/** 界面文案取自 zh 文案文件，避免与实现重复硬编码。 */
const zh = JSON.parse(
  readFileSync(new URL("../messages/zh.json", import.meta.url), "utf8"),
) as typeof import("../messages/zh.json");

/**
 * design 包里的 zh 文案（`packages/design/src/i18n.ts`，如 ActionRow 区域名 `shell.pending`）：按键从源码读出，
 * 不在用例里重复硬编码。
 */
const designZh = (key: string): string => {
  const src = readFileSync(
    new URL("../../../packages/design/src/i18n.ts", import.meta.url),
    "utf8",
  );
  const m = new RegExp(`"${key.replace(/\./g, "\\.")}":\\s*"([^"]*)"`).exec(src);
  if (!m?.[1]) throw new Error(`design message ${key} not found`);
  return m[1];
};

/** 安装向导的 ActionRow（主操作 / 上一步都在这里）。 */
const actionRow = (page: Page) => page.getByRole("region", { name: designZh("shell.pending") });

/** 新建引用某连接器全部工具的 agent（model-fake），从列表开始对话，返回输入框。 */
async function chatWithAgent(page: Page, agentName: string, connectorName: string) {
  await page.goto("/zh/agents/new");
  await page.getByRole("textbox", { name: zh.agents.form.nameLabel, exact: true }).fill(agentName);
  await page
    .getByRole("combobox", { name: zh.agents.form.modelLabel, exact: true })
    .selectOption("model-fake/fake-1");
  await page
    .getByRole("checkbox", {
      name: zh.agents.form.connectorTools.replace("{name}", connectorName),
      exact: true,
    })
    .check();
  await page.getByRole("button", { name: zh.agents.form.submit }).click();
  await expect(page).toHaveURL(/\/zh\/agents$/);
  await startChat(page, agentName);
  return composer(page);
}

test("OpenAPI 连接器经安装向导接入（文档认证提示预填 API key、取消一个操作）→ agent 调 POST 操作 → 审批 → 批准 → 回复含结果", async ({
  page,
}) => {
  const specUrl = process.env.CAPYBARA_E2E_OPENAPI_SPEC_URL as string;
  const apiKey = process.env.CAPYBARA_E2E_OPENAPI_KEY as string;
  expect(specUrl, "global-setup 应写入 CAPYBARA_E2E_OPENAPI_SPEC_URL").toBeTruthy();
  const w = zh.connectors.wizard;
  await signIn(page);

  // 1. 类型：OpenAPI；端点：文档 URL
  await page.goto("/zh/connectors/install");
  await page.getByRole("radio", { name: new RegExp(w.connector.openapi) }).check();
  await actionRow(page).getByRole("button", { name: w.next }).click();
  await page.getByRole("textbox", { name: zh.connectors.form.nameLabel, exact: true }).fill("Pets");
  await page
    .getByRole("textbox", { name: new RegExp(`^${zh.connectors.form.slugLabel}`) })
    .fill("pets");
  await page.getByRole("textbox", { name: w.specUrlLabel }).fill(specUrl);
  await actionRow(page).getByRole("button", { name: w.next }).click();

  // 2. 认证：按文档的 securitySchemes 预填 API key（请求头 X-API-Key），填入 key
  await expect(
    page.getByRole("combobox", { name: zh.connectors.form.authTypeLabel, exact: true }),
  ).toHaveValue("api_key");
  await expect(page.getByRole("textbox", { name: zh.connectors.form.keyNameLabel })).toHaveValue(
    "X-API-Key",
  );
  await page.getByLabel(zh.connectors.form.tokenLabel).fill(apiKey);
  await actionRow(page).getByRole("button", { name: w.next }).click();

  // 3. Tools: the operations table with the default policy by method; deselect one operation
  const ops = page.getByRole("table", { name: w.operationsLabel });
  await expect(ops).toBeVisible();
  await expect(
    ops.getByRole("row").filter({ hasText: "POST /pets" }).getByText(zh.connectors.policy.ask),
  ).toBeVisible();
  await expect(
    ops.getByRole("row").filter({ hasText: "List pets" }).getByText(zh.connectors.policy.allow),
  ).toBeVisible();
  await ops.getByRole("checkbox", { name: "选择 DELETE /pets/1" }).uncheck();
  await actionRow(page).getByRole("button", { name: w.install }).click();
  await expect(page.getByText(w.doneTitle.replace("{name}", "Pets"))).toBeVisible();
  await actionRow(page).getByRole("button", { name: w.openConnector }).click();
  await expect(page).toHaveURL(/\/zh\/connectors\/[^/]+$/);
  await expect(
    page.getByRole("combobox", {
      name: zh.connectors.tools.policyLabel.replace("{tool}", "pets__createPet"),
    }),
  ).toHaveValue("ask");
  await expect(page.getByText("pets__deletePet")).toHaveCount(0);

  // 4. agent 调 POST 操作 → 审批 → 批准 → 回复含接口返回
  const input = await chatWithAgent(page, "Pets agent", "Pets");
  await input.fill('tool:pets__createPet:{"body":{"name":"Rex"}}');
  await input.press("Enter");
  const approval = page.locator('[data-role="approval"]');
  await expect(approval).toHaveCount(1);
  await expect(approval.locator('[data-part="tool-key"]')).toHaveText("pets__createPet");
  await approval.getByRole("button", { name: designZh("hitl.approve"), exact: true }).click();
  await expect(approval.getByText(/批准了/)).toBeVisible();
  await expect(toolGroup(page, "pets__createPet")).toHaveAttribute("data-tool-status", "done");
  await expect(replies(page).last()).toHaveText(/"name":\s*"Rex"/);
});
