import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { signIn } from "./support/sign-in";

/*
 * The OpenAPI connector's install wizard (the official connector-openapi extension: the spec's
 * securitySchemes prefill the auth step, the operations table). Split out of tools.spec.ts, whose
 * connector cases run on the core fake connector; this one exercises connector-openapi itself and
 * moves with that plugin.
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

/** DataTable 行菜单的触发按钮名称（设计系统文案 table.rowActions，zh）。 */
const ROW_ACTIONS = "行操作";

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
    .getByRole("checkbox", { name: zh.agents.form.connectorTools.replace("{name}", connectorName) })
    .check();
  await page.getByRole("button", { name: zh.agents.form.submit }).click();
  await expect(page).toHaveURL(/\/zh\/agents$/);
  await page
    .getByRole("row")
    .filter({ hasText: agentName })
    .getByRole("button", { name: ROW_ACTIONS })
    .click();
  await page.getByRole("menuitem", { name: zh.agents.startChat }).click();
  await expect(page).toHaveURL(/\/zh\/chat\/[^/]+$/);
  return page.getByLabel(zh.chat.inputLabel);
}

test("OpenAPI 连接器经安装向导接入（文档认证提示预填 API key、勾选操作）→ agent 调 POST 操作 → 审批 → 批准 → 回复含结果", async ({
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

  // 3. 工具：操作清单与按方法推导的默认策略；取消两个测试用操作
  const ops = page.getByRole("table", { name: w.operationsLabel });
  await expect(ops).toBeVisible();
  await expect(
    ops.getByRole("row").filter({ hasText: "POST /pets" }).getByText(zh.connectors.policy.ask),
  ).toBeVisible();
  await expect(
    ops.getByRole("row").filter({ hasText: "List pets" }).getByText(zh.connectors.policy.allow),
  ).toBeVisible();
  for (const label of ["GET /boom", "GET /moved"]) {
    await ops.getByRole("checkbox", { name: `选择 ${label}` }).uncheck();
  }
  await actionRow(page).getByRole("button", { name: w.install }).click();
  await expect(page.getByText(w.doneTitle.replace("{name}", "Pets"))).toBeVisible();
  await actionRow(page).getByRole("button", { name: w.openConnector }).click();
  await expect(page).toHaveURL(/\/zh\/connectors\/[^/]+$/);
  await expect(
    page.getByRole("combobox", {
      name: zh.connectors.tools.policyLabel.replace("{tool}", "pets__createPet"),
    }),
  ).toHaveValue("ask");
  await expect(page.getByText("pets__boom")).toHaveCount(0);

  // 4. agent 调 POST 操作 → 审批 → 批准 → 回复含接口返回
  const input = await chatWithAgent(page, "Pets agent", "Pets");
  await input.fill('tool:pets__createPet:{"body":{"name":"Rex"}}');
  await input.press("Enter");
  const approval = page.locator('[data-role="approval"]');
  await expect(approval).toHaveCount(1);
  await expect(approval.getByText("Pets")).toBeVisible();
  await approval.getByRole("button", { name: zh.approval.approve }).click();
  await expect(approval.getByText(zh.approval.decision.approved)).toBeVisible();
  await expect(page.locator('[data-role="tool"]')).toHaveAttribute("data-status", "done");
  await expect(page.locator('[data-role="assistant"] [data-part="body"]').last()).toHaveText(
    /"name":\s*"Rex"/,
  );
});
