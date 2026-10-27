import { expect, type Page, test } from "@playwright/test";
import {
  CSRF,
  composer,
  conversationIdOf,
  createAgent,
  createMcpConnector,
  currentOrg,
  designZh,
  eventsOf,
  replies,
  send,
  toolGroup,
  users,
  zh,
} from "./support/chat";
import { signIn } from "./support/sign-in";

/**
 * The anti-goal capabilities of the conversation page (UI refresh spec §2): everything the old page
 * could do still works on the new one. One test per capability group, each with its own agent.
 */

const LONG = "Capybaras are the largest living rodents and very calm swimmers. ".repeat(4).trim();

async function newChat(page: Page, agentId: string) {
  await page.goto(`/zh/chat?agent=${agentId}`);
  await expect(page.locator('[data-template="ConversationPage"]')).toBeVisible();
  // The agent is picked once the agents list loaded (the heading names it).
  await expect(page.locator('[data-part="new-conversation-body"] h2')).not.toHaveText("—");
}

const stopButton = (page: Page) => page.getByRole("button", { name: designZh("composer.stop") });
const statusBar = (page: Page) => page.locator('[data-part="conv-main"] .cb-statusbar');

test("a new conversation is created on the first send only; the title is generated; rename", async ({
  page,
}) => {
  await signIn(page);
  const orgId = await currentOrg(page);
  const agentId = await createAgent(page, orgId, "Cap first send");
  await newChat(page, agentId);
  await expect(page.getByRole("heading", { name: "Cap first send" })).toBeVisible();
  // Nothing exists before the first send.
  const before = await page.request.get(`/api/v1/orgs/${orgId}/conversations?agentId=${agentId}`);
  expect(((await before.json()) as { conversations: unknown[] }).conversations).toHaveLength(0);

  await send(page, "echo:hello capybara");
  await expect(replies(page).last()).toHaveText(/hello capybara/);
  const id = conversationIdOf(page);
  const sidebar = page.getByRole("region", { name: "会话" });
  // The title is generated after the first run (model-fake answers "You said: …").
  const title = page.locator('[data-part="title-bar"] [data-part="title"]');
  await expect(title).not.toHaveAttribute("data-untitled", "true", { timeout: 60_000 });
  await expect(sidebar.locator(`a[href$="/chat/${id}"]`)).not.toContainText(
    designZh("sidebar.untitled"),
  );

  // Rename from the title menu: the title bar and the sidebar follow.
  await title.click();
  await page.getByRole("menuitem", { name: zh.chat.rename }).click();
  const dialog = page.getByRole("dialog", { name: designZh("rename.title") });
  await dialog.getByRole("textbox").fill("Quarterly numbers");
  await dialog.getByRole("button", { name: designZh("rename.save") }).click();
  await expect(title).toHaveText("Quarterly numbers");
  await expect(sidebar.locator(`a[href$="/chat/${id}"]`)).toContainText("Quarterly numbers");
});

test("interject while running, queue with ⌘↵ / Ctrl+↵ (sent in order after the turn), stop", async ({
  page,
}) => {
  await signIn(page);
  const orgId = await currentOrg(page);
  const agentId = await createAgent(page, orgId, "Cap queue");
  await newChat(page, agentId);
  await send(page, `slow:500:${LONG}`);
  await expect(page.locator('[data-entry="prose"][data-streaming="true"]')).toBeVisible();
  // ↵ while running interjects; the hint says so.
  await expect(composer(page)).toHaveAttribute("placeholder", /↵/);
  await composer(page).fill("echo:now");
  await composer(page).press("Enter");
  await expect(users(page).filter({ hasText: "echo:now" })).toHaveCount(1);
  // ⌘↵ / Ctrl+↵ queues: dashed bubbles under the thread, not in the log yet.
  await composer(page).fill("echo:queued one");
  await composer(page).press("ControlOrMeta+Enter");
  const queue = page.locator('[data-entry="queue"]');
  await expect(queue.locator("[data-queue-item]")).toHaveCount(1);
  await composer(page).fill("echo:queued two");
  await composer(page).press("ControlOrMeta+Enter");
  await expect(queue.locator("[data-queue-item]")).toHaveCount(2);
  // After the turn the queued messages go out one at a time, in order.
  await expect(replies(page).filter({ hasText: /^queued two$/ })).toHaveCount(1, {
    timeout: 60_000,
  });
  await expect(queue).toHaveCount(0);
  const texts = await replies(page).allTextContents();
  expect(texts.map((t) => t.trim())).toEqual([LONG, "now", "queued one", "queued two"]);

  // Stop while running: the stop divider names who stopped.
  await send(page, `slow:300:${LONG}`);
  await expect(page.locator('[data-entry="prose"][data-streaming="true"]')).toBeVisible();
  await stopButton(page).click();
  await expect(page.locator('[data-divider="stopped"]')).toHaveCount(1);
  await expect(stopButton(page)).toHaveCount(0);
  await expect(statusBar(page)).toContainText(zh.chat.status.stopped);
});

test("approvals: once / this conversation / always; deny with a reason; stop while waiting", async ({
  page,
}) => {
  await signIn(page);
  const orgId = await currentOrg(page);
  const connectorId = await createMcpConnector(page, orgId, "Cap Fixture", "capfix");
  const agentId = await createAgent(page, orgId, "Cap approvals", [
    { kind: "connector", connectorId, tools: "all" },
  ]);
  const approval = page.locator('[data-role="approval"]');
  const ask = async (id: string) => {
    await send(page, `tool:capfix__delete_item:{"id":"${id}"}`);
  };

  // Approve for this conversation: the next call in it asks no more.
  await newChat(page, agentId);
  await ask("x1");
  await expect(approval).toHaveCount(1);
  await expect(approval.locator('[data-part="tool-key"]')).toHaveText("capfix__delete_item");
  await expect(approval.getByText("x1")).toBeVisible();
  await expect(statusBar(page)).toContainText(zh.chat.status.waiting);
  for (const s of ["hitl.approve", "hitl.approveSession", "hitl.approveAlways"]) {
    await expect(approval.getByRole("button", { name: designZh(s), exact: true })).toBeVisible();
  }
  await approval.getByRole("button", { name: designZh("hitl.approveSession") }).click();
  await expect(approval.getByText(/批准了/)).toBeVisible();
  await expect(replies(page).last()).toHaveText(/deleted x1/);
  await ask("x2");
  await expect(replies(page).last()).toHaveText(/deleted x2/);
  await expect(approval).toHaveCount(1);

  // Deny with a reason: the model sees it; the row fails.
  await newChat(page, agentId);
  await ask("x3");
  await approval.getByRole("button", { name: designZh("hitl.denyEllipsis") }).click();
  await approval.getByRole("textbox", { name: designZh("hitl.denyReason") }).fill("not today");
  await approval.getByRole("button", { name: designZh("hitl.deny"), exact: true }).click();
  await expect(approval.getByText(/「not today」/)).toBeVisible();
  await expect(toolGroup(page, "capfix__delete_item")).toHaveAttribute(
    "data-tool-status",
    "failed",
  );

  // Stop while waiting for an approval.
  await newChat(page, agentId);
  await ask("x4");
  await expect(
    approval.getByRole("button", { name: designZh("hitl.approve"), exact: true }),
  ).toBeVisible();
  await stopButton(page).click();
  await expect(page.locator('[data-divider="stopped"]')).toHaveCount(1);
  await expect(
    approval.getByRole("button", { name: designZh("hitl.approve"), exact: true }),
  ).toHaveCount(0);

  // Always approve: a new conversation with this agent asks no more.
  await newChat(page, agentId);
  await ask("x5");
  await approval.getByRole("button", { name: designZh("hitl.approveAlways") }).click();
  await expect(replies(page).last()).toHaveText(/deleted x5/);
  await newChat(page, agentId);
  await ask("x6");
  await expect(replies(page).last()).toHaveText(/deleted x6/);
  await expect(approval).toHaveCount(0);
});

test("questions with options and Other; URL elicitation; a connect card", async ({
  page,
  context,
}) => {
  await signIn(page);
  const orgId = await currentOrg(page);
  const open = await createMcpConnector(page, orgId, "Cap Verify", "capver");
  // A personal-credential connector: created with the creator's token, which is then removed, so
  // the person has not connected it.
  const personal = await createMcpConnector(
    page,
    orgId,
    "Cap Personal",
    "cappers",
    { type: "bearer", ownership: "personal" },
    { token: "t0k" },
  );
  const forget = await page.request.delete(
    `/api/v1/orgs/${orgId}/connectors/${personal}/credentials/me`,
    { headers: CSRF },
  );
  expect(forget.ok(), await forget.text()).toBe(true);
  const agentId = await createAgent(page, orgId, "Cap questions", [
    { kind: "connector", connectorId: open, tools: "all" },
    { kind: "connector", connectorId: personal, tools: "all" },
  ]);
  await newChat(page, agentId);
  const question = page.locator('[data-role="question"]');
  const askUser = {
    questions: [
      {
        question: "Which environment?",
        header: "Env",
        multiSelect: false,
        options: [
          { label: "staging", description: "the test one" },
          { label: "prod", description: "the live one" },
        ],
      },
    ],
  };
  await send(page, `tool:ask_user:${JSON.stringify(askUser)}`);
  await expect(question.getByText("Which environment?")).toBeVisible();
  await question.getByRole("radio", { name: designZh("hitl.other") }).click();
  await question.getByRole("textbox").fill("qa");
  await question.getByRole("button", { name: designZh("hitl.answer") }).click();
  await expect(question.getByText("qa")).toBeVisible();
  await expect(replies(page).last()).toHaveText(/qa/);

  // URL elicitation: the full address, opened in a new window, then "I'm done".
  await send(page, "tool:capver__verify:{}");
  const url = "https://example.com/verify?token=e2e";
  await expect(question.last().getByRole("link", { name: url })).toBeVisible();
  const popup = context.waitForEvent("page");
  await question
    .last()
    .getByRole("link", { name: designZh("hitl.openLink") })
    .click();
  await (await popup).close();
  // The kernel's URL form asks the person to confirm they finished on the page.
  await question.last().getByRole("switch").click();
  await question
    .last()
    .getByRole("button", { name: designZh("hitl.answer") })
    .click();
  await expect(replies(page).last()).toHaveText(/verify accept/);

  // A connector with personal credentials the person has not given: the connect card.
  await send(page, "tool:cappers__verify:{}");
  const connect = page.locator('[data-role="connect"]');
  await expect(connect).toBeVisible();
  await connect.getByRole("button", { name: designZh("hitl.connect") }).click();
  await expect(page).toHaveURL(new RegExp(`/settings/connections#connector-${personal}$`));
});

test("reconnect: events after a dropped stream still arrive", async ({ page }) => {
  await signIn(page);
  const orgId = await currentOrg(page);
  const agentId = await createAgent(page, orgId, "Cap reconnect");
  await newChat(page, agentId);
  await send(page, "echo:first");
  await expect(replies(page).last()).toHaveText("first");
  // Drop the next stream connections twice: the page reopens from the last seq it saw.
  let dropped = 0;
  await page.route("**/conversations/*/stream?*", (route) => {
    if (dropped < 2) {
      dropped += 1;
      return route.abort();
    }
    return route.continue();
  });
  await page.reload();
  await expect(replies(page).last()).toHaveText("first");
  await send(page, "echo:after the gap");
  await expect(replies(page).last()).toHaveText("after the gap");
  expect(dropped).toBe(2);
});

test("a policy hook: a denied tool row names the extension; a denied run shows the notice", async ({
  page,
}) => {
  await signIn(page);
  const orgId = await currentOrg(page);
  const kernel = process.env.CAPYBARA_E2E_KERNEL_URL as string;
  const enable = (enabled: boolean) =>
    page.request.put(`/api/v1/orgs/${orgId}/extensions/hooks-probe`, {
      headers: CSRF,
      data: { enabled },
    });
  const probe = (cfg: Record<string, unknown>) =>
    page.request.post(`${kernel}/plugins/hooks-probe/config`, { data: { orgId, ...cfg } });
  expect((await enable(true)).status()).toBe(200);
  try {
    expect((await probe({ denyTools: ["hooks-probe__probe_echo"] })).ok()).toBe(true);
    const agentId = await createAgent(page, orgId, "Cap hooks", [
      { kind: "plugin", plugin: "hooks-probe", name: "probe_echo" },
    ]);
    await newChat(page, agentId);
    await send(page, 'tool:hooks-probe__probe_echo:{"text":"x"}');
    const row = toolGroup(page, "hooks-probe__probe_echo");
    await expect(row).toHaveAttribute("data-tool-status", "failed");
    await expect(row).toContainText("hooks-probe");

    expect((await probe({ denyModel: true })).ok()).toBe(true);
    await send(page, "echo:blocked");
    const notice = page.locator('[data-divider="hook-denied"]');
    await expect(notice).toContainText(
      zh.errors.run.hook_denied.replace("{plugin}", "hooks-probe"),
    );
  } finally {
    await probe({});
    await enable(false);
  }
});

test("View all of an archived output; a model switch is logged and used", async ({ page }) => {
  await signIn(page);
  const orgId = await currentOrg(page);
  const agentId = await createAgent(page, orgId, "Cap output", [
    { kind: "builtin", name: "sandbox_bash" },
  ]);
  await newChat(page, agentId);
  await send(
    page,
    `tool:sandbox_bash:${JSON.stringify({ command: "seq 1 60000", description: "Count to 60000" })}`,
  );
  const group = toolGroup(page, "sandbox_bash");
  await expect(group).toHaveAttribute("data-tool-status", "done");
  await group.getByRole("button", { name: /Count to 60000/ }).click();
  await group.getByRole("button", { name: designZh("tool.viewAll") }).click();
  const panel = page.getByRole("complementary", { name: zh.chat.fullOutput });
  await expect(panel.getByText(/^59999$/m)).toBeVisible();
  await expect(page).toHaveURL(/#output=/);

  // Switch to fake-2 in the composer: logged with the next message and used by its run.
  await page.getByRole("button", { name: new RegExp(`^${zh.chat.pickModel}`) }).click();
  await page.getByRole("menuitemradio", { name: /fake-2/ }).click();
  await send(page, "echo:on the other model");
  await expect(replies(page).last()).toHaveText("on the other model");
  const events = await eventsOf(page, orgId, conversationIdOf(page));
  const switched = events.filter((e) => e.type === "model_switched");
  expect(switched).toHaveLength(1);
  expect(switched[0]?.payload).toMatchObject({
    model: { provider: "model-fake", model: "fake-2" },
  });
  const runs = events.filter((e) => e.type === "run_started");
  expect(runs.at(-1)?.payload).toMatchObject({ model: { model: "fake-2" } });
});
