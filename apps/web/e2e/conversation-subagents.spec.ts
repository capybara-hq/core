import { expect, type Page, test } from "@playwright/test";
import {
  animationsDone,
  composer,
  conversationIdOf,
  createAgent,
  createMcpConnector,
  currentOrg,
  designZh,
  eventsOf,
  send,
  startChat,
  users,
  zh,
} from "./support/chat";
import { signIn } from "./support/sign-in";

/**
 * Sub-agents on the conversation page (UI refresh B Task 21, phase C; agent map spec §9.5): model-fake
 * calls the tool a message names, and a general-purpose child answers its prompt the same way. Each
 * `Agent` call is a call block whose status line follows the child in the background; the child's
 * end reaches the parent as a notice line with its reply; the properties panel lists the
 * sub-agents and opens one read-only on the right, where a running one can be stopped.
 */

const group = (page: Page) => page.locator('[data-entry="subagents"]');
const block = (page: Page, description: string) =>
  page.locator('[data-part="agent-call-block"]').filter({ hasText: description });
const panel = (page: Page, description: string) =>
  page.getByRole("complementary", { name: description });

/** A finished group is folded: its header button ("N 个子智能体已完成 · …") opens it. */
const unfold = async (page: Page, index: number, n: number) => {
  const g = group(page).nth(index);
  await g
    .getByRole("button", {
      name: new RegExp(`^${designZh("subagent.done").replace("{n}", `${n}`)}`),
    })
    .click();
  await animationsDone(g);
};

const dispatch = (description: string, prompt: string) =>
  `tool:Agent:${JSON.stringify({ description, prompt })}`;

test("sub-agents: the call block, the finish notice, the record on the right, stop, and the properties panel", async ({
  page,
}) => {
  await signIn(page);
  const orgId = await currentOrg(page);
  await createAgent(page, orgId, "Lead with helpers", [{ kind: "builtin", name: "Agent" }]);
  await startChat(page, "Lead with helpers");

  // 1. a sub-agent that answers at once: its group folds once it is done
  await send(page, dispatch("Check the docs", "echo:child says hello"));
  await expect(group(page).first().locator('[data-part="tool-line"]')).toContainText(
    designZh("subagent.done").replace("{n}", "1"),
  );
  await unfold(page, 0, 1);
  await expect(block(page, "Check the docs")).toHaveAttribute("data-status", "completed");
  // its end is a notice line in the parent whose text is the child's reply
  const finished = page
    .locator('[data-entry="delivery"]')
    .filter({ hasText: zh.chat.delivery.completed.replace("{name}", "Check the docs") });
  await expect(finished).toBeVisible();
  await finished.getByRole("button", { name: zh.chat.delivery.show }).click();
  await expect(finished).toContainText("child says hello");

  // 2. the properties panel lists it; it opens read-only on the right
  await page.getByRole("button", { name: designZh("titlebar.properties") }).click();
  const props = page.getByRole("complementary", { name: designZh("props.label") });
  await expect(props).toContainText(zh.subagents.background);
  await props
    .getByRole("button", { name: designZh("subagent.completed").replace("{n}", "1") })
    .click();
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

  // 3. a slow sub-agent works in the background; stop it from the properties panel
  const words = Array.from({ length: 120 }, (_, i) => `w${i}`).join(" ");
  await send(page, dispatch("Slow job", `slow:500:${words}`));
  await expect(block(page, "Slow job")).toHaveAttribute("data-status", "running");
  await expect(block(page, "Slow job")).toContainText(designZh("agentMap.call.runningIdle"));
  await expect(composer(page)).toBeEnabled();
  await page.getByRole("button", { name: designZh("titlebar.properties") }).click();
  await props
    .getByRole("button", { name: designZh("background.stop").replace("{name}", "Slow job") })
    .click();
  // done, its group folds; open it to see the stopped block
  await unfold(page, 1, 1);
  await expect(block(page, "Slow job")).toHaveAttribute("data-status", "aborted");
  await expect(props).toContainText(designZh("subagent.completed").replace("{n}", "2"));
  // the Context section: the meter, the model line and the tokens with sub-agents (a number)
  await expect(props.locator('[data-part="meter"]')).toBeVisible();
  await expect(props).toContainText("fake-1");
  await expect(props.locator('[data-part="context-total"]')).toHaveText(
    new RegExp(`^${zh.subagents.contextTotal.replace("{n}", "[1-9][\\d,]*")}$`),
  );
});

test("a sub-agent's approval waits in the parent and is decided there; a ?subagent= link opens the child in the agent map", async ({
  page,
}) => {
  await signIn(page);
  const orgId = await currentOrg(page);
  const connectorId = await createMcpConnector(page, orgId, "Cap Child", "capchild");
  await createAgent(page, orgId, "Lead with a tool", [
    { kind: "builtin", name: "Agent" },
    { kind: "connector", connectorId, tools: "all" },
  ]);
  await startChat(page, "Lead with a tool");
  await send(page, dispatch("Delete via child", 'tool:mcp__capchild__delete_item:{"id":"c9"}'));
  // the child's approval shows in the parent, named by the sub-agent, and decides the child's call
  const wait = page.locator('[data-entry="subagent-wait"]');
  await expect(wait).toContainText(zh.subagents.askedBy.replace("{name}", "Delete via child"));
  await expect(wait.getByText("c9")).toBeVisible();
  await wait.getByRole("button", { name: designZh("hitl.approve"), exact: true }).click();
  // the child runs the call; its end reaches the parent as a notice with its reply
  const done = page
    .locator('[data-entry="delivery"]')
    .filter({ hasText: zh.chat.delivery.completed.replace("{name}", "Delete via child") });
  await expect(done).toBeVisible();
  await done.getByRole("button", { name: zh.chat.delivery.show }).click();
  await expect(done).toContainText("deleted c9");

  // an inbox or IM link (?subagent=, any depth) opens that child in the agent map (level 2)
  const id = conversationIdOf(page);
  const listed = await page.request.get(`/api/v1/orgs/${orgId}/conversations/${id}/subagents`);
  expect(listed.ok(), await listed.text()).toBe(true);
  const child = ((await listed.json()) as { subagents: { id: string }[] }).subagents[0]?.id;
  expect(child).toBeTruthy();
  await page.goto(`/chat/${id}?subagent=${child}`);
  await expect(page.getByRole("dialog", { name: "Delete via child" })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/chat/${id}#agents=${child}$`));
});

test("a failed run shows its notice; Retry repeats the message without a second bubble", async ({
  page,
}) => {
  await signIn(page);
  const orgId = await currentOrg(page);
  await createAgent(page, orgId, "Cap retry");
  await startChat(page, "Cap retry");
  await send(page, "fail:invalid_request");
  const failed = page.locator('[data-run-status="failed"]');
  await expect(failed).toHaveCount(1);
  await failed.getByRole("button", { name: designZh("conv.retry") }).click();
  // the retry fails again (the same script): two notices, the first marked retried, one bubble
  await expect(failed).toHaveCount(2);
  await expect(failed.first()).toContainText(zh.chat.run.failedRetried);
  await expect(users(page)).toHaveCount(1);
  const events = await eventsOf(page, orgId, conversationIdOf(page));
  const messages = events.filter((e) => e.type === "user_message");
  expect(messages).toHaveLength(2);
  expect(typeof messages[1]?.payload.retryOf).toBe("number");
});
