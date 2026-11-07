import { expect, test } from "@playwright/test";
import { CSRF, composer, createAgent, currentOrg, replies, users, zh } from "./support/chat";
import { signIn } from "./support/sign-in";

/** The zap button's and its menu's accessible name in zh (the design package's own copy). */
const QUICK_ACTIONS = "常用任务";

/**
 * The new conversation page (agent profile design §4): the greeting, the selected agent's quick
 * actions (the composer's zap menu, spec §6.16.27) filling the composer, and the first send from
 * there (model-fake echoes).
 */

test("the new conversation page greets, a quick action fills the composer, and the send works", async ({
  page,
}) => {
  await signIn(page);
  const orgId = await currentOrg(page);
  const agentId = await createAgent(page, orgId, "Cap quick");
  // the quick actions are profile data, saved like the agent page saves them
  const read = await page.request.get(`/api/v1/orgs/${orgId}/agents/${agentId}`);
  expect(read.ok(), await read.text()).toBe(true);
  const { agent } = (await read.json()) as { agent: { profile: { updatedAt: string } } };
  const saved = await page.request.patch(`/api/v1/orgs/${orgId}/agents/${agentId}/profile`, {
    headers: CSRF,
    data: {
      quickActions: [{ title: "Say hello", body: "echo:hello from a quick action" }],
      expectedUpdatedAt: agent.profile.updatedAt,
    },
  });
  expect(saved.ok(), await saved.text()).toBe(true);
  const me = (await (await page.request.get("/api/v1/me")).json()) as {
    account: { displayName: string };
  };

  await page.goto(`/?agent=${agentId}`);
  // one line of the time-of-day sets, with the person's name where the line has one
  const lines = Object.entries(zh.chat.greeting)
    .filter(([k]) => k !== "sub")
    .flatMap(([, v]) => v as string[])
    .map((l) => l.replace("{name}", me.account.displayName));
  // the heading's name is the whole line (the typed copy is hidden from assistive tech)
  const greeting = page.locator('[data-part="new-conversation-body"] h2 .cb-sr-only');
  await expect
    .poll(async () => lines.includes(((await greeting.textContent()) ?? "").trim()))
    .toBe(true);
  await expect(page.getByText(zh.chat.greeting.sub)).toBeVisible();

  const input = composer(page);
  await expect(input).toHaveAttribute(
    "placeholder",
    zh.chat.newPlaceholder.replace("{agent}", "Cap quick"),
  );
  await input.fill("draft text");
  // the quick actions are a zap button in the composer's control row (design i18n "quick.label")
  await page.getByRole("button", { name: QUICK_ACTIONS }).click();
  await page.getByRole("menuitem", { name: "Say hello" }).click();
  await expect(input).toHaveValue("echo:hello from a quick action");
  await expect(input).toBeFocused();

  await input.press("Enter");
  await expect(users(page).filter({ hasText: "hello from a quick action" }).first()).toBeVisible();
  await expect(page).toHaveURL(/\/chat\/[^/?#]+(#.*)?$/);
  await expect(replies(page).last()).toHaveText(/hello from a quick action/, { timeout: 30_000 });
});

test("the old /chat redirects permanently to /, the new conversation, keeping its query", async ({
  page,
}) => {
  await signIn(page);
  const orgId = await currentOrg(page);
  const agentId = await createAgent(page, orgId, "Cap moved");
  // maintainer decision 2026-11-07: the new conversation is the home at `/`
  const res = await page.request.get(`/chat?agent=${agentId}`, { maxRedirects: 0 });
  expect(res.status()).toBe(308);
  expect(new URL(res.headers().location ?? "", page.url()).pathname).toBe("/");
  expect(new URL(res.headers().location ?? "", page.url()).search).toBe(`?agent=${agentId}`);
  await page.goto(`/chat?agent=${agentId}`);
  await expect(page).toHaveURL(new RegExp(`^https?://[^/]+/\\?agent=${agentId}$`));
  await expect(page.locator('[data-template="ConversationPage"]')).toBeVisible();
  await expect(composer(page)).toBeVisible();
});
