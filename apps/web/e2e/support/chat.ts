import { readFileSync } from "node:fs";
import { expect, type Locator, type Page } from "@playwright/test";

/** 界面文案取自 zh 文案文件，避免与实现重复硬编码。 */
export const zh = JSON.parse(
  readFileSync(new URL("../../messages/zh.json", import.meta.url), "utf8"),
) as typeof import("../../messages/zh.json");

/** A design message (`packages/design/src/i18n.ts`, zh), read from the source by key. */
export function designZh(key: string): string {
  const src = readFileSync(
    new URL("../../../../packages/design/src/i18n.ts", import.meta.url),
    "utf8",
  );
  const m = new RegExp(`"${key.replace(/\./g, "\\.")}":\\s*"([^"]*)"`).exec(src);
  if (!m?.[1]) throw new Error(`design message ${key} not found`);
  return m[1];
}

/** Row menu trigger of a DataTable (record lists: members, orgs, models; design `table.rowActions`). */
export const RECORD_ROW_MENU = "行操作";
/** Row menu trigger of an ObjectRow (object lists: agents, skills, ...; design `shell.moreActions`). */
export const OBJECT_ROW_MENU = "更多操作";

/** The composer's textarea. */
export const composer = (page: Page): Locator =>
  page.getByRole("textbox", { name: zh.chat.inputLabel, exact: true });

/** User bubbles and assistant prose of the thread, in order. */
export const users = (page: Page): Locator =>
  page.locator('[data-entry="user"] [data-part="bubble"]');
export const replies = (page: Page): Locator =>
  page.locator('[data-entry="prose"] [data-part="prose"]');
/** The tool group that holds a call of `key`. */
export const toolGroup = (page: Page, key: string): Locator =>
  page.locator(`[data-entry="tools"][data-tool-keys~="${key}"]`);

/**
 * Opens a new conversation with the agent from the Agents list (the row action 对话): the page
 * is `/chat?agent=<id>` and nothing is created before the first send.
 */
export async function startChat(page: Page, agentName: string): Promise<void> {
  if (!/\/agents$/.test(page.url())) await page.goto("/agents");
  await page
    .getByRole("listitem")
    .filter({ hasText: agentName })
    .getByRole("button", { name: zh.agents.chat, exact: true })
    .click();
  await expect(page).toHaveURL(/\/chat\?agent=[^&]+$/);
  await expect(page.locator('[data-template="ConversationPage"]')).toBeVisible();
  // the agent is picked: the composer's placeholder names it
  await expect(composer(page)).toHaveAttribute(
    "placeholder",
    zh.chat.newPlaceholder.replace("{agent}", agentName),
  );
  await expect(composer(page)).toBeEnabled();
}

/**
 * Creates an agent through the short create form (agent profile design §2.4: a preselected
 * avatar, the name, the model fake-1, visibility private) and waits for the landing on its
 * page's prompt section (`/agents/<id>?s=prompt`); returns the agent id. Tools, skills and model
 * parameters are set afterwards in their sections ({@link openAgentSection}).
 */
export async function newAgent(page: Page, name: string): Promise<string> {
  await page.goto("/agents/new");
  await expect(page.locator('[data-template="FormPage"]')).toBeVisible();
  await page.getByRole("textbox", { name: zh.agents.form.nameLabel, exact: true }).fill(name);
  await page
    .getByRole("combobox", { name: zh.agents.form.modelLabel, exact: true })
    .selectOption("model-fake/fake-1");
  await page.getByRole("button", { name: zh.agents.form.submit }).click();
  await expect(page).toHaveURL(/\/agents\/[^/?#]+\?s=prompt$/);
  await expect(page.locator('[data-template="SettingsPage"]')).toBeVisible();
  return decodeURIComponent(new URL(page.url()).pathname.split("/").at(-1) ?? "");
}

/** Opens a section of the agent page (`?s=<section>`) through its section nav. */
export async function openAgentSection(
  page: Page,
  section: keyof typeof zh.agents.page.sections,
): Promise<void> {
  await page
    .locator('[data-part="settings-nav"]')
    .getByRole("link", { name: zh.agents.page.sections[section], exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`[?&]s=${section}$`));
}

/**
 * Saves the open section of the agent page (its ActionRow's 保存) and waits until the save went
 * through: the row goes once nothing is unsaved, failed or pending.
 */
export async function saveSection(page: Page): Promise<void> {
  const row = page.locator('[data-part="action-row"]');
  await row.getByRole("button", { name: zh.agents.form.submit, exact: true }).click();
  await expect(row).toHaveCount(0);
}

/**
 * Sends with ↵ and waits for the bubble (the first send also creates the conversation). While a
 * run is going ↵ queues instead (conversation send design D1): use {@link interject} there.
 */
export async function send(page: Page, text: string, keys = "Enter"): Promise<void> {
  const input = composer(page);
  await input.fill(text);
  await input.press(keys);
  await expect(users(page).filter({ hasText: text }).first()).toBeVisible();
  await expect(page).toHaveURL(/\/chat\/[^/?#]+(#.*)?$/);
}

/** Sends now while a run is going (an interjection: ⌘↵ / Ctrl+↵) and waits for the bubble. */
export const interject = (page: Page, text: string): Promise<void> =>
  send(page, text, "ControlOrMeta+Enter");

/**
 * Waits until the CSS animations on `target` and inside it have finished (an expand opens with a
 * height animation under `overflow: hidden`). A control inside an expanding block keeps its box
 * while it is clipped, so Playwright finds it stable and scrolls the clipping box to reach it;
 * when the animation ends the scroll resets and the click lands on whatever moved there.
 */
export async function animationsDone(target: Locator): Promise<void> {
  await target.evaluate((el) =>
    Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)),
  );
}

/** 内核要求非安全方法带的 CSRF 头。 */
export const CSRF = { "X-Capybara-Csrf": "1" };

/** The current org id (selecting the org right after sign-in is asynchronous). */
export async function currentOrg(page: Page): Promise<string> {
  let orgId: string | null = null;
  await expect
    .poll(async () => {
      const me = await page.request.get("/api/v1/me");
      orgId = me.ok() ? ((await me.json()) as { currentOrgId: string | null }).currentOrgId : null;
      return orgId;
    })
    .not.toBeNull();
  return orgId as unknown as string;
}

/** Creates a private fake-1 agent through the same-origin proxy; returns its id. */
export async function createAgent(
  page: Page,
  orgId: string,
  name: string,
  tools: unknown[] = [],
): Promise<string> {
  const res = await page.request.post(`/api/v1/orgs/${orgId}/agents`, {
    headers: CSRF,
    data: {
      definition: {
        name,
        instructions: "Help.",
        model: { provider: "model-fake", model: "fake-1" },
        tools: [
          { kind: "builtin", name: "AskUserQuestion" },
          { kind: "builtin", name: "ReadToolOutput" },
          ...tools,
        ],
      },
      visibility: "private",
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  return ((await res.json()) as { agent: { id: string } }).agent.id;
}

/** Creates an empty conversation (API clients may; the web creates on first send) and opens it. */
export async function openConversation(
  page: Page,
  orgId: string,
  agentId: string,
): Promise<string> {
  const conv = await page.request.post(`/api/v1/orgs/${orgId}/conversations`, {
    headers: CSRF,
    data: { agentId },
  });
  expect(conv.status(), await conv.text()).toBe(201);
  const id = ((await conv.json()) as { conversation: { id: string } }).conversation.id;
  await page.goto(`/chat/${id}`);
  await expect(page.locator('[data-template="ConversationPage"]')).toBeVisible();
  return id;
}

/** Installs the fake MCP server as a connector through the API; returns its id. */
export async function createMcpConnector(
  page: Page,
  orgId: string,
  name: string,
  slug: string,
  auth: Record<string, unknown> = { type: "none" },
  credential?: Record<string, unknown>,
): Promise<string> {
  const url = process.env.CAPYBARA_E2E_MCP_URL as string;
  const res = await page.request.post(`/api/v1/orgs/${orgId}/connectors`, {
    headers: CSRF,
    data: {
      name,
      slug,
      connector: "mcp",
      endpoint: { url },
      auth,
      ...(credential !== undefined && { credential }),
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  return ((await res.json()) as { connector: { id: string } }).connector.id;
}

/** The conversation's events (to check what the log recorded). */
export async function eventsOf(
  page: Page,
  orgId: string,
  conversationId: string,
): Promise<{ type: string; payload: Record<string, unknown>; runId: string | null }[]> {
  const res = await page.request.get(
    `/api/v1/orgs/${orgId}/conversations/${conversationId}/events?limit=500`,
  );
  expect(res.ok()).toBe(true);
  return ((await res.json()) as { events: never[] }).events;
}

/** The conversation id of the current `/chat/<id>` URL. */
export const conversationIdOf = (page: Page): string =>
  new URL(page.url()).pathname.split("/").at(-1) ?? "";
