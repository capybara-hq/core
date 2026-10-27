import { expect, type Page, test } from "@playwright/test";
import {
  composer,
  conversationIdOf,
  createAgent,
  createMcpConnector,
  currentOrg,
  designZh,
  eventsOf,
  replies,
  send,
  startChat,
  users,
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
  // the Context section: the meter, the model line and the tokens with sub-agents (a number)
  await expect(props.locator('[data-part="meter"]')).toBeVisible();
  await expect(props).toContainText("fake-1");
  await expect(props.locator('[data-part="context-total"]')).toHaveText(
    new RegExp(`^${zh.subagents.contextTotal.replace("{n}", "[1-9][\\d,]*")}$`),
  );
  await props
    .getByRole("button", { name: designZh("subagent.completed").replace("{n}", "2") })
    .click();
  await expect(page).toHaveURL(/#subagent=/);
});

test("a sub-agent's approval waits in the parent and is decided there; a legacy ?subagent= link opens the child", async ({
  page,
}) => {
  await signIn(page);
  const orgId = await currentOrg(page);
  const connectorId = await createMcpConnector(page, orgId, "Cap Child", "capchild");
  await createAgent(page, orgId, "Lead with a tool", [
    { kind: "builtin", name: "agent" },
    { kind: "connector", connectorId, tools: "all" },
  ]);
  await startChat(page, "Lead with a tool");
  await send(page, dispatch("Delete via child", 'tool:capchild__delete_item:{"id":"c9"}'));
  // the child's approval shows in the parent, named by the sub-agent, and decides the child's call
  const wait = page.locator('[data-entry="subagent-wait"]');
  await expect(wait).toContainText(zh.subagents.askedBy.replace("{name}", "Delete via child"));
  await expect(wait.getByText("c9")).toBeVisible();
  await wait.getByRole("button", { name: designZh("hitl.approve"), exact: true }).click();
  await expect(replies(page).last()).toContainText("deleted c9");

  // an inbox or IM link written before the hash routes (?subagent=) opens that child
  const id = conversationIdOf(page);
  const listed = await page.request.get(`/api/v1/orgs/${orgId}/conversations/${id}/subagents`);
  expect(listed.ok(), await listed.text()).toBe(true);
  const child = ((await listed.json()) as { subagents: { id: string }[] }).subagents[0]?.id;
  expect(child).toBeTruthy();
  await page.goto(`/zh/chat/${id}?subagent=${child}`);
  await expect(panel(page, "Delete via child")).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/chat/${id}#subagent=${child}$`));
});

test("a failed run shows its notice; Retry repeats the message without a second bubble", async ({
  page,
}) => {
  await signIn(page);
  const orgId = await currentOrg(page);
  await createAgent(page, orgId, "Cap retry");
  await startChat(page, "Cap retry");
  await send(page, "fail:invalid_request");
  const failed = page.locator('[data-divider="failed"]');
  await expect(failed).toHaveCount(1);
  await failed.getByRole("button", { name: designZh("conv.retry") }).click();
  // the retry fails again (the same script): two notices, the first marked retried, one bubble
  await expect(failed).toHaveCount(2);
  await expect(failed.first()).toContainText(
    zh.chat.divider.failedRetried.split("{reason}")[1]?.trim() ?? "",
  );
  await expect(users(page)).toHaveCount(1);
  const events = await eventsOf(page, orgId, conversationIdOf(page));
  const messages = events.filter((e) => e.type === "user_message");
  expect(messages).toHaveLength(2);
  expect(typeof messages[1]?.payload.retryOf).toBe("number");
});
