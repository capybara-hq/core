import { expect, test } from "@playwright/test";
import { composer, createAgent, currentOrg, replies } from "./support/chat";
import { signIn } from "./support/sign-in";

/**
 * The send experience (conversation send spec 2026-11-04 §4): from `/chat` the composer clears at
 * once, the working line shows before the first token, and the reply streams.
 */

const LONG = "Capybaras are the largest living rodents and very calm swimmers. ".repeat(4).trim();

test("send from /chat: the composer clears at once, the working line, then a streaming reply", async ({
  page,
}) => {
  await signIn(page);
  const orgId = await currentOrg(page);
  const agentId = await createAgent(page, orgId, "Cap send");
  await page.goto(`/chat?agent=${agentId}`);
  await expect(page.locator('[data-part="new-conversation-body"] h2')).not.toHaveText("—");
  const input = composer(page);
  await input.fill(`slow:200:${LONG}`);
  await input.press("Enter");
  // the composer is empty within 100 ms, long before the create answers
  await expect(input).toHaveValue("", { timeout: 100 });
  // the working line shows before the first token
  const line = page.locator('[data-part="working-line"]');
  await expect(line).toBeVisible();
  await expect(replies(page)).toHaveCount(0);
  // the reply streams: at least two growth steps before it is whole
  const lengths = new Set<number>();
  await expect
    .poll(
      async () => {
        const text =
          (await replies(page)
            .last()
            .textContent({ timeout: 50 })
            .catch(() => "")) ?? "";
        if (text !== "" && text.trim() !== LONG) lengths.add(text.length);
        return text.trim() === LONG;
      },
      { intervals: [50], timeout: 30_000 },
    )
    .toBe(true);
  expect(lengths.size).toBeGreaterThanOrEqual(2);
  await expect(line).toHaveCount(0);
  await expect(page).toHaveURL(/\/chat\/[^/?#]+(#.*)?$/);
});
