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
