import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { newAgent, openAgentSection, saveSection } from "./support/chat";
import { signIn } from "./support/sign-in";

/** UI copy from the zh message file (not repeated here). */
const zh = JSON.parse(
  readFileSync(new URL("../messages/zh.json", import.meta.url), "utf8"),
) as typeof import("../messages/zh.json");

const S = zh.agents.form.subagents;

/** A new model-fake agent: the agent tool is on by default (tools default-on). */
async function createLead(page: Page, name: string) {
  await newAgent(page, name);
  await openAgentSection(page, "subagents");
  const section = page.getByRole("region", { name: S.section });
  await expect(section.getByRole("checkbox", { name: S.agentTool })).toBeChecked();
  await expect(section.getByRole("checkbox", { name: S.general })).toBeChecked();
}

/** Opens the agent's page from the Agents list (the name links to it) at its Sub-agents section. */
async function openAgent(page: Page, name: string) {
  await page.goto("/agents");
  await page.getByRole("listitem").filter({ hasText: name }).getByRole("link", { name }).click();
  await expect(page.locator('[data-template="SettingsPage"]')).toBeVisible();
  await openAgentSection(page, "subagents");
}

test("the agent page's Sub-agents section: dispatchable and an allowlisted org agent", async ({
  page,
}) => {
  await signIn(page);
  // an agent others may dispatch
  await newAgent(page, "Analyst");
  await openAgentSection(page, "subagents");
  await page.getByRole("switch", { name: S.dispatchable }).click();
  await saveSection(page);
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
  await saveSection(page);
  await openAgent(page, "Team lead");
  await expect(
    page.getByRole("region", { name: S.section }).getByRole("checkbox", { name: /Analyst/ }),
  ).toBeChecked();
});
