import { expect, test } from "@playwright/test";
import {
  createAgent,
  currentOrg,
  designZh,
  eventsOf,
  openConversation,
  replies,
  send,
  toolGroup,
  users,
  zh,
} from "./support/chat";
import { hydrated } from "./support/nav";
import { signIn } from "./support/sign-in";

/**
 * Background Bash on the conversation page (spec 2026-11-05-background-bash-design §2, §3, §5):
 * model-fake calls `Bash` with `run_in_background` and answers with the launch result; the task
 * runs in sandbox-fake, the properties panel lists it while it runs, its output panel shows the
 * output once it finished, the thread shows the finished notice, and the finish wakes the idle
 * conversation: a second reply arrives without a person's message.
 */

const DESCRIPTION = "Wait then print";
const BASH = `tool:Bash:${JSON.stringify({
  command: "sleep 20; echo ready",
  description: DESCRIPTION,
  run_in_background: true,
})}`;
/**
 * The task runs 20 s, past the time the page needs to show it running under load; the poll
 * (`sandbox.background.pollSeconds`, 10 s) notices the finish up to 10 s later. Allow for both.
 */
const FINISH_TIMEOUT = 90_000;

test("background Bash: the running task, its output, the finished notice and the wake run", async ({
  page,
}) => {
  await signIn(page);
  const orgId = await currentOrg(page);
  // the builtin Bash is on by default (tools default-on)
  const agentId = await createAgent(page, orgId, "Background worker");
  const convId = await openConversation(page, orgId, agentId);

  await hydrated(page);
  // the properties panel is open before the send, so the running task shows as soon as it starts
  await page.getByRole("button", { name: designZh("titlebar.properties") }).click();
  const props = page.getByRole("complementary", { name: designZh("props.label") });
  await expect(props).toBeVisible();

  await send(page, BASH);
  // the launch returns at once: the reply quotes the launch result
  await expect(replies(page)).toHaveCount(1);
  await expect(replies(page).first()).toContainText("Started background task");
  await expect(toolGroup(page, "Bash")).toContainText(zh.background.inBackground);

  // 1. the background section lists the running task with its stop button
  await expect(props.getByText(zh.subagents.background, { exact: true })).toBeVisible();
  const row = props.locator('[data-part="task-row"]').filter({ hasText: DESCRIPTION });
  await expect(row).toBeVisible();
  await expect(
    row.getByRole("button", { name: designZh("background.stop").replace("{name}", DESCRIPTION) }),
  ).toBeVisible();

  // 2. opening it shows the output panel; once the task finished, its output reads "ready"
  await row.getByRole("button", { name: DESCRIPTION, exact: true }).click();
  await expect(page).toHaveURL(/#bg-bt_/);
  const panel = page.getByRole("complementary", { name: DESCRIPTION });
  await expect(panel.locator('[data-part="task-command"]')).toContainText("sleep 20; echo ready");
  await expect(panel.locator('[data-part="task-output-status"]')).toContainText(
    zh.background.status.completed,
    { timeout: FINISH_TIMEOUT },
  );
  await expect(panel.locator('[data-part="task-output"]')).toContainText("ready");

  // 3. the thread shows the finished notice, which opens the task
  const notice = page.locator('[data-part="run-divider"][data-kind="notice"]');
  await expect(notice).toContainText(DESCRIPTION, { timeout: FINISH_TIMEOUT });
  await expect(notice).toContainText(zh.background.status.completed);

  // 4. the finish woke the idle conversation: a second reply, still one person's message
  await expect(replies(page)).toHaveCount(2, { timeout: FINISH_TIMEOUT });
  await expect(users(page)).toHaveCount(1);
  const events = await eventsOf(page, orgId, convId);
  const finished = events.filter((e) => e.type === "background_task_finished");
  expect(finished).toHaveLength(1);
  expect(finished[0]?.payload).toMatchObject({ status: "completed", exitCode: 0 });
  const starts = events.filter((e) => e.type === "run_started");
  expect(starts).toHaveLength(2);
  expect(starts[1]?.payload).toMatchObject({ trigger: "background_task" });
  expect(events.filter((e) => e.type === "user_message")).toHaveLength(1);
});
