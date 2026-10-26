import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { signIn } from "./support/sign-in";

/** 界面文案取自 zh 文案文件，避免与实现重复硬编码。 */
const zh = JSON.parse(
  readFileSync(new URL("../messages/zh.json", import.meta.url), "utf8"),
) as typeof import("../messages/zh.json");

/** DataTable 行菜单的触发按钮名称（设计系统文案 table.rowActions，zh）。 */
const ROW_ACTIONS = "行操作";
const E = zh.evals;

const fill = (s: string, vars: Record<string, string | number>) =>
  s.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k]));

/** A stat card under the header (`label` is the metric name). */
const metric = (page: Page, label: string) =>
  page.locator('[data-part="stat-card"]').filter({ has: page.getByText(label, { exact: true }) });

test("建评测集 → 从对话抽样 → 单步运行 → 标注，汇总随之更新", async ({ page }) => {
  await signIn(page);

  // 1. 新建 agent（model-fake），对话一轮，等运行结束
  const agentName = `Eval agent ${Date.now()}`;
  await page.goto("/zh/agents/new");
  await page.getByRole("textbox", { name: zh.agents.form.nameLabel, exact: true }).fill(agentName);
  await page
    .getByRole("combobox", { name: zh.agents.form.modelLabel, exact: true })
    .selectOption("model-fake/fake-1");
  await page.getByRole("button", { name: zh.agents.form.submit }).click();
  await expect(page).toHaveURL(/\/zh\/agents$/);
  await page
    .getByRole("row")
    .filter({ hasText: agentName })
    .getByRole("button", { name: ROW_ACTIONS })
    .click();
  await page.getByRole("menuitem", { name: zh.agents.startChat }).click();
  await expect(page).toHaveURL(/\/zh\/chat\/[^/]+$/);
  const input = page.getByLabel(zh.chat.inputLabel);
  await input.fill("echo:eval me please");
  await input.press("Enter");
  await expect(page.locator('[data-role="assistant"]').last()).toHaveText(/eval me please/);
  await expect(page.getByRole("button", { name: zh.chat.stop })).toHaveCount(0);

  // 2. 顶栏「评测」→ 新建评测集
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("link", { name: zh.nav.evals })
    .click();
  await expect(page).toHaveURL(/\/zh\/evals$/);
  await expect(page.getByRole("link", { name: E.runHistory })).toBeVisible();
  await page.getByRole("link", { name: E.new }).click();
  await expect(page.locator('[data-template="FormPage"]')).toBeVisible();
  await page.getByRole("combobox", { name: E.form.agentLabel }).selectOption({ label: agentName });
  await page.getByRole("textbox", { name: E.form.nameLabel }).fill("E2E set");
  await page.getByRole("button", { name: E.form.submit }).click();
  await expect(page).toHaveURL(/\/zh\/evals\/[^/]+$/);
  await expect(page.locator('[data-template="DetailPage"]')).toBeVisible();
  const setUrl = page.url();

  // 3. 从对话抽样：该 agent 只有一次已完成的运行
  await page.getByRole("button", { name: E.set.sample }).click();
  const dialog = page.getByRole("dialog", { name: E.sample.title });
  await dialog.getByRole("button", { name: E.sample.submit }).click();
  await expect(page.getByText(fill(E.sample.done, { added: 1, skipped: 0 }))).toBeVisible();
  const cases = page.getByRole("table", { name: E.set.casesLabel });
  await expect(cases.getByRole("row").filter({ hasText: "echo:eval me please" })).toHaveCount(1);

  // 4. 运行评测（单步，候选不改）：看估算后开始
  await page.getByRole("link", { name: E.set.run }).click();
  await expect(page.locator('[data-template="WizardPage"]')).toBeVisible();
  const actions = page.locator(".cb-actionrow");
  await actions.getByRole("button", { name: E.wizard.next }).click();
  await expect(page.getByRole("switch", { name: E.wizard.judge })).toBeVisible();
  await actions.getByRole("button", { name: E.wizard.next }).click();
  const estimate = page.getByRole("region", { name: E.wizard.estimate.title });
  await expect(
    estimate.locator(".cb-kv-row").filter({ hasText: E.wizard.estimate.cases }),
  ).toContainText("1");
  await expect(
    estimate.locator(".cb-kv-row").filter({ hasText: E.wizard.estimate.modelRequests }),
  ).toContainText("1");
  // 上限留空：显示生效的部署默认上限（evals.defaultTokenCap）
  await expect(
    estimate.locator(".cb-kv-row").filter({ hasText: E.wizard.estimate.tokenCap }),
  ).toContainText("1,000,000");
  await actions.getByRole("button", { name: E.wizard.start }).click();
  await expect(page).toHaveURL(/\/zh\/evals\/runs\/[^/]+$/);

  // 5. 运行页每 5 秒轮询，直到完成
  await expect(page.getByText(`${E.runStatus.completed}`).first()).toBeVisible({
    timeout: 60_000,
  });
  await expect(metric(page, E.run.metrics.progress)).toContainText("1/1");
  await expect(metric(page, E.run.metrics.humanPass)).toContainText("—");

  // 6. 打开结果 → 标注「通过」→ 页头的人工通过率变成 100%
  const results = page.getByRole("table", { name: E.run.resultsLabel });
  await results.getByRole("row").filter({ hasText: "echo:eval me please" }).click();
  const inspector = page.getByRole("region", { name: E.run.inspector.title });
  await expect(inspector.getByText(E.run.inspector.noTextDiff)).toBeVisible();
  await inspector.getByRole("button", { name: E.run.inspector.pass, exact: true }).click();
  await expect(metric(page, E.run.metrics.humanPass)).toContainText("100%");
  await expect(results.getByRole("row").filter({ hasText: E.run.verdict.pass })).toHaveCount(1);

  // 评测集的「运行」标签页列出这次运行
  await page.goto(setUrl);
  await page.getByRole("tab", { name: new RegExp(E.set.tabs.runs) }).click();
  await expect(
    page.getByRole("table", { name: E.set.runsLabel }).getByText(E.mode.step),
  ).toBeVisible();
});
