import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { signIn } from "./support/sign-in";

/** UI copy from the zh message file (not repeated here). */
const zh = JSON.parse(
  readFileSync(new URL("../messages/zh.json", import.meta.url), "utf8"),
) as typeof import("../messages/zh.json");

const S = zh.agents.form.subagents;
/** The DataTable row menu trigger (design copy table.rowActions, zh). */
const ROW_ACTIONS = "行操作";

/** A new model-fake agent with the agent tool switched on in the Sub-agents section. */
async function createLead(page: Page, name: string) {
  await page.goto("/zh/agents/new");
  await expect(page.locator('[data-template="FormPage"]')).toBeVisible();
  await page.getByRole("textbox", { name: zh.agents.form.nameLabel, exact: true }).fill(name);
  await page
    .getByRole("combobox", { name: zh.agents.form.modelLabel, exact: true })
    .selectOption("model-fake/fake-1");
  const section = page.getByRole("region", { name: S.section });
  await section.getByRole("checkbox", { name: S.agentTool }).check();
  await expect(section.getByRole("checkbox", { name: S.general })).toBeChecked();
  await page.getByRole("button", { name: zh.agents.form.submit }).click();
  await expect(page).toHaveURL(/\/zh\/agents$/);
}

async function openAgent(page: Page, name: string) {
  await page.goto("/zh/agents");
  await page
    .getByRole("row")
    .filter({ hasText: name })
    .getByRole("button", { name: ROW_ACTIONS })
    .click();
  await page.getByRole("menuitem", { name: zh.agents.edit }).click();
  await expect(page.locator('[data-template="FormPage"]')).toBeVisible();
}

test("an agent dispatches a sub-agent: the group row, the read-only child view, the result", async ({
  page,
}) => {
  await signIn(page);
  await createLead(page, "Lead with helpers");
  await page
    .getByRole("row")
    .filter({ hasText: "Lead with helpers" })
    .getByRole("button", { name: ROW_ACTIONS })
    .click();
  await page.getByRole("menuitem", { name: zh.agents.startChat }).click();
  await expect(page).toHaveURL(/\/zh\/chat\/[^/?]+$/);

  // model-fake calls the tool named in the message; the child echoes its prompt
  const input = page.getByLabel(zh.chat.inputLabel);
  await input.fill('tool:agent:{"description":"Check the docs","prompt":"echo:child says hello"}');
  await input.press("Enter");

  const group = page.locator('[data-role="subagent-group"]');
  await expect(group).toContainText("1 个子代理已完成", {
    timeout: 30_000,
  });
  const row = group.locator('[data-role="subagent"]');
  await expect(row).toHaveAttribute("data-status", "done");
  await expect(row).toContainText("general-purpose");
  await expect(row).toContainText("Check the docs");
  // the parent got the child's reply as the tool result
  await expect(page.locator('[data-role="assistant"]').last()).toContainText("child says hello");

  // open the child read-only in the Inspector (the address keeps it)
  await row
    .getByRole("button", {
      name: zh.subagents.openLabel.replace("{description}", "Check the docs"),
    })
    .click();
  await expect(page).toHaveURL(/\?subagent=/);
  const view = page.getByRole("region", { name: zh.subagents.view.title });
  await expect(view).toBeVisible();
  await expect(view.locator('[data-role="assistant"]')).toContainText("child says hello");
  await expect(view.getByLabel(zh.chat.inputLabel)).toHaveCount(0);

  // a reload with ?subagent= opens it again; back closes it
  await page.reload();
  await expect(page.getByRole("region", { name: zh.subagents.view.title })).toBeVisible();
  await page
    .getByRole("region", { name: zh.subagents.view.title })
    .getByRole("button", { name: zh.subagents.view.back })
    .click();
  await expect(page).not.toHaveURL(/\?subagent=/);
});

test("the agent page's Sub-agents section: dispatchable and an allowlisted org agent", async ({
  page,
}) => {
  await signIn(page);
  // an agent others may dispatch
  await page.goto("/zh/agents/new");
  await page.getByRole("textbox", { name: zh.agents.form.nameLabel, exact: true }).fill("Analyst");
  await page
    .getByRole("combobox", { name: zh.agents.form.modelLabel, exact: true })
    .selectOption("model-fake/fake-1");
  await page.getByRole("switch", { name: S.dispatchable }).click();
  await page.getByRole("button", { name: zh.agents.form.submit }).click();
  await expect(page).toHaveURL(/\/zh\/agents$/);
  await openAgent(page, "Analyst");
  await expect(page.getByRole("switch", { name: S.dispatchable })).toHaveAttribute(
    "aria-checked",
    "true",
  );

  // a lead that allowlists it
  await createLead(page, "Team lead");
  await openAgent(page, "Team lead");
  const section = page.getByRole("region", { name: S.section });
  await section.getByRole("checkbox", { name: /Analyst/ }).check();
  await expect(section).toContainText(S.agentsWarning);
  await section
    .getByRole("textbox", { name: S.agentAs.replace("{name}", "Analyst") })
    .fill("analyst");
  await section
    .getByRole("textbox", { name: S.agentDescription.replace("{name}", "Analyst") })
    .fill("Answers data questions.");
  await page.getByRole("button", { name: zh.agents.form.submit }).click();
  await expect(page).toHaveURL(/\/zh\/agents$/);
  await openAgent(page, "Team lead");
  await expect(
    page.getByRole("region", { name: S.section }).getByRole("checkbox", { name: /Analyst/ }),
  ).toBeChecked();
});
