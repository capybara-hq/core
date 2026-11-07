import { expect, type Page, test } from "@playwright/test";
import { createAgent, currentOrg, designZh, send, startChat, zh } from "./support/chat";
import { signIn } from "./support/sign-in";

/**
 * The agent map (agent map spec §9): model-fake dispatches two background sub-agents in one step.
 * One hands back a report at once (`SubagentHandback`), the other streams slowly. The first's call
 * block opens it in the map (level 2), its transcript (level 3) is the conversation thread without
 * a composer, back leads to the tree, and the slow one is stopped from its summary.
 */

const call = (page: Page, description: string) =>
  page.locator('[data-part="agent-call-block"]').filter({ hasText: description });
const dialog = (page: Page, name: string) => page.getByRole("dialog", { name });

const HANDBACK = "Hand back";
const SLOW = "Slow job";
/** About 125 four-character chunks, 500 ms apart: a minute of streaming, enough to stop it. */
const WORDS = Array.from({ length: 120 }, (_, i) => `w${i}`).join(" ");
const DISPATCH = `tools:${JSON.stringify([
  {
    name: "Agent",
    input: {
      description: HANDBACK,
      prompt: `tool:SubagentHandback:${JSON.stringify({ message: "Docs are fine." })}`,
    },
  },
  { name: "Agent", input: { description: SLOW, prompt: `slow:500:${WORDS}` } },
])}`;

test("agent map: open a child from its call block, its transcript, back to the tree, stop the other", async ({
  page,
}) => {
  await signIn(page);
  const orgId = await currentOrg(page);
  await createAgent(page, orgId, "Lead with background helpers", [
    { kind: "builtin", name: "Agent" },
  ]);
  await startChat(page, "Lead with background helpers");
  await send(page, DISPATCH);

  // both calls are blocks; the slow one works in the background
  await expect(call(page, HANDBACK)).toBeVisible();
  await expect(call(page, SLOW)).toHaveAttribute("data-status", "running");
  await expect(call(page, SLOW)).toContainText(designZh("agentMap.call.runningIdle"));
  // the report reaches the parent as a notice line
  await expect(
    page
      .locator('[data-entry="delivery"]')
      .filter({ hasText: zh.chat.delivery.report.replace("{name}", HANDBACK) }),
  ).toBeVisible();

  // 1. the call block's action opens the child's summary (level 2)
  await call(page, HANDBACK)
    .getByRole("button", { name: designZh("agentMap.call.open") })
    .click();
  await expect(page).toHaveURL(/#agents=[^/]+$/);
  const detail = dialog(page, HANDBACK);
  await expect(detail.locator('[data-part="agent-call-tool"]').first()).toHaveText(
    "SubagentHandback",
  );
  // finished: only "Open transcript"
  await expect(detail.getByRole("button", { name: designZh("agentMap.stop") })).toHaveCount(0);

  // 2. its transcript (level 3): the task bubble from the parent, the handback as a tool block,
  // no composer
  await detail.getByRole("button", { name: designZh("agentMap.openTranscript") }).click();
  await expect(page).toHaveURL(/#agents=[^/]+\/transcript$/);
  const transcript = dialog(page, HANDBACK);
  await expect(transcript.locator('[data-entry="task"]')).toContainText("SubagentHandback");
  await expect(transcript.locator('[data-part="bubble-sender"]').first()).toBeVisible();
  await expect(transcript.locator('[data-entry="tools"]').first()).toHaveAttribute(
    "data-tool-keys",
    /SubagentHandback/,
  );
  await expect(transcript.getByRole("textbox")).toHaveCount(0);
  // no read-only copy (AC1): the missing composer says it
  await expect(transcript.getByText(/只读|转达/)).toHaveCount(0);

  // 3. back to its summary, back to the tree
  await transcript.getByRole("button", { name: designZh("agentMap.back") }).click();
  await expect(page).toHaveURL(/#agents=[^/]+$/);
  await dialog(page, HANDBACK)
    .getByRole("button", { name: designZh("agentMap.back") })
    .click();
  await expect(page).toHaveURL(/#agents$/);
  const map = dialog(page, designZh("agentMap.title"));
  await expect(map.getByText(SLOW)).toBeVisible();

  // 4. open the slow one and stop it (AC5): the request reaches the kernel (202), the agent's end
  // arrives through its stream, and Stop is gone
  await map.getByText(SLOW).click();
  const slow = dialog(page, SLOW);
  const stopButton = slow.getByRole("button", { name: designZh("agentMap.stop") });
  const aborted = page.waitForResponse(
    (r) => r.request().method() === "POST" && /\/conversations\/[^/]+\/abort$/.test(r.url()),
  );
  await stopButton.click();
  expect((await aborted).status()).toBe(202);
  await expect(stopButton).toHaveCount(0);
  await expect(slow.locator('[data-part="agent-meta"]').first()).toContainText(
    designZh("agentMap.status.aborted"),
  );
  await slow.getByRole("button", { name: designZh("overlay.close") }).click();
  await expect(page).not.toHaveURL(/#agents/);
  // both are done: the group folds; its header opens it again
  const group = page.locator('[data-entry="subagents"]').first();
  await group
    .getByRole("button", { name: new RegExp(`^${designZh("subagent.done").replace("{n}", "2")}`) })
    .click();
  await expect(call(page, SLOW)).toHaveAttribute("data-status", "aborted");
});
