import { expect, type Page, test } from "@playwright/test";
import { CSRF, createAgent, currentOrg } from "./support/chat";
import { hydrated } from "./support/nav";
import { signIn } from "./support/sign-in";

/**
 * Server-rendered times hydrate without a mismatch (CI failure of `ssr.spec.ts`, 2026-11-04: the
 * overview's 「接着上次的会话」 meta said 现在 on the server and 1分钟前 in the browser). The browser
 * runs 61 s ahead of the server, then also in a time zone no server uses (Pacific/Chatham,
 * UTC+12:45 / +13:45), so a relative age and an absolute `MM-DD HH:mm` differ between the two;
 * until it has mounted the page renders with the server's clock and zone, then with its own.
 */

/** Hydration errors and warnings the page logs (Next's dev overlay shows them too). */
function hydrationErrors(page: Page): string[] {
  const seen: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && /hydrat|didn't match/i.test(m.text())) seen.push(m.text());
  });
  page.on("pageerror", (e) => {
    if (/hydrat|didn't match/i.test(e.message)) seen.push(e.message);
  });
  return seen;
}

async function hydratesTimes(page: Page): Promise<void> {
  await signIn(page);
  const orgId = await currentOrg(page);
  const agentId = await createAgent(page, orgId, `Clock agent ${Date.now()}`);
  // an untitled conversation updated just now: the overview's recent list says 现在 on the server
  const conv = await page.request.post(`/api/v1/orgs/${orgId}/conversations`, {
    headers: CSRF,
    data: { agentId },
  });
  expect(conv.status(), await conv.text()).toBe(201);
  const id = ((await conv.json()) as { conversation: { id: string } }).conversation.id;

  const errors = hydrationErrors(page);
  await page.clock.install({ time: Date.now() + 61_000 });

  await page.goto("/");
  await hydrated(page);
  const recent = page.getByRole("list", { name: "接着上次的会话" });
  const row = recent.getByRole("listitem").filter({ has: page.locator(`a[href$="/chat/${id}"]`) });
  // after mount the browser's own clock: a minute has passed
  await expect(row).toContainText("1分钟前");

  await page.goto(`/chat/${id}`);
  await expect(page.locator('[data-template="ConversationPage"]')).toBeVisible();
  await hydrated(page);

  expect(errors).toEqual([]);
}

test("a browser clock a minute ahead of the server hydrates the server's relative ages", async ({
  page,
}) => {
  await hydratesTimes(page);
});

test.describe("in another time zone", () => {
  test.use({ timezoneId: "Pacific/Chatham" });

  test("a browser clock ahead and in another zone hydrates the server's times", async ({
    page,
  }) => {
    await hydratesTimes(page);
  });
});
