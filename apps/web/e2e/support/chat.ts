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

/** DataTable's row menu trigger (design `table.rowActions`, zh). */
export const ROW_ACTIONS = "行操作";

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
 * Opens a new conversation with the agent from the Agents list (row menu → Start chat): the page
 * is `/chat?agent=<id>` and nothing is created before the first send.
 */
export async function startChat(page: Page, agentName: string): Promise<void> {
  if (!/\/zh\/agents$/.test(page.url())) await page.goto("/zh/agents");
  await page
    .getByRole("row")
    .filter({ hasText: agentName })
    .getByRole("button", { name: ROW_ACTIONS })
    .click();
  await page.getByRole("menuitem", { name: zh.agents.startChat }).click();
  await expect(page).toHaveURL(/\/zh\/chat\?agent=[^&]+$/);
  await expect(page.locator('[data-template="ConversationPage"]')).toBeVisible();
  await expect(page.getByRole("heading", { name: agentName })).toBeVisible();
  await expect(composer(page)).toBeEnabled();
}

/** Sends with ↵ and waits for the bubble (the first send also creates the conversation). */
export async function send(page: Page, text: string): Promise<void> {
  const input = composer(page);
  await input.fill(text);
  await input.press("Enter");
  await expect(users(page).filter({ hasText: text }).first()).toBeVisible();
  await expect(page).toHaveURL(/\/zh\/chat\/[^/?#]+(#.*)?$/);
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
          { kind: "builtin", name: "ask_user" },
          { kind: "builtin", name: "read_tool_output" },
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
  await page.goto(`/zh/chat/${id}`);
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
