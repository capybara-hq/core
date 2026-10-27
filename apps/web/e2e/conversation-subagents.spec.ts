import { expect, type Page, test } from "@playwright/test";
import {
  composer,
  createAgent,
  currentOrg,
  designZh,
  replies,
  send,
  startChat,
  zh,
} from "./support/chat";
import { signIn } from "./support/sign-in";

/**
 * Sub-agents on the conversation page (UI refresh B Task 21, phase C): model-fake calls the tool a
 * message names, and a general-purpose child answers its prompt the same way. A finished sub-agent
 * is a row that expands to its result and opens its record on the right; a running one streams in
 * the right panel, Stop ends it and the parent goes on; the properties panel lists them.
 */

const group = (page: Page) => page.locator('[data-entry="subagents"]');
const row = (page: Page, description: string) =>
  page.locator('[data-part="subagent-row"]').filter({ hasText: description });
const panel = (page: Page, description: string) =>
  page.getByRole("complementary", { name: description });

const dispatch = (description: string, prompt: string) =>
  `tool:agent:${JSON.stringify({ description, prompt })}`;

test("sub-agents: the group, the record on the right, stop, and the properties panel", async ({
  page,
}) => {
  await signIn(page);
  const orgId = await currentOrg(page);
  await createAgent(page, orgId, "Lead with helpers", [{ kind: "builtin", name: "agent" }]);
  await startChat(page, "Lead with helpers");

  // 1. a sub-agent that answers at once: a done row, its result folded into the parent's reply
  await send(page, dispatch("Check the docs", "echo:child says hello"));
  await expect(group(page).first()).toContainText(designZh("subagent.done").replace("{n}", "1"));
  // a finished group is folded: its line opens it
  await group(page).first().locator('[data-part="tool-line"]').click();
  const done = row(page, "Check the docs");
  await expect(done).toHaveAttribute("data-status", "completed");
  await expect(done).toContainText("general-purpose");
  await expect(replies(page).last()).toContainText("child says hello");

  // the row expands in place to the result; "open the full record" opens it on the right
  await done.click();
  await page.getByRole("button", { name: designZh("subagent.openRecord") }).click();
  await expect(page).toHaveURL(/#subagent=/);
  const record = panel(page, "Check the docs");
  await expect(record.locator('[data-part="subagent-task"]')).toContainText(
    "echo:child says hello",
  );
  await expect(record.locator('[data-part="prose"]').last()).toContainText("child says hello");
  await expect(record).toContainText(zh.subagents.view.readOnly);
  await expect(record.getByRole("textbox")).toHaveCount(0);
  // a reload keeps it open; close drops the hash
  await page.reload();
  await expect(panel(page, "Check the docs")).toBeVisible();
  await panel(page, "Check the docs")
    .getByRole("button", { name: designZh("overlay.close") })
    .click();
  await expect(page).not.toHaveURL(/#subagent=/);

  // 2. a slow sub-agent: open it while it runs, watch it stream, stop it; the parent goes on
  const words = Array.from({ length: 120 }, (_, i) => `w${i}`).join(" ");
  await send(page, dispatch("Slow job", `slow:250:${words}`));
  const slow = row(page, "Slow job");
  await expect(slow).toHaveAttribute("data-status", "running");
  await slow.click();
  await expect(slow).toHaveAttribute("aria-current", "true");
  const live = panel(page, "Slow job");
  await expect(live.locator('[data-streaming="true"]')).toBeVisible();
  await live.getByRole("button", { name: zh.subagents.view.stop }).click();
  // done, its group folds; open it again to see the stopped row
  const second = group(page).nth(1).locator('[data-part="tool-line"]');
  await expect(second).toContainText(designZh("subagent.done").replace("{n}", "1"));
  await second.click();
  await expect(slow).toHaveAttribute("data-status", "aborted");
  await expect(live.getByRole("button", { name: zh.subagents.view.stop })).toHaveCount(0);
  await live.getByRole("button", { name: designZh("overlay.close") }).click();
  await expect(replies(page).last()).toContainText("Tool result:");
  await expect(composer(page)).toBeEnabled();

  // 3. the properties panel: no running ones, two completed; the total with sub-agents
  await page.getByRole("button", { name: designZh("titlebar.properties") }).click();
  const props = page.getByRole("complementary", { name: designZh("props.label") });
  await expect(props).toContainText(zh.subagents.background);
  await expect(props).toContainText(designZh("subagent.completed").replace("{n}", "2"));
  await expect(props).toContainText(zh.subagents.contextTotal);
  await props
    .getByRole("button", { name: designZh("subagent.completed").replace("{n}", "2") })
    .click();
  await expect(page).toHaveURL(/#subagent=/);
});
