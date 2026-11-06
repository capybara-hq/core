import { expect, test } from "@playwright/test";
import { composer, createAgent, currentOrg, replies, send, users } from "./support/chat";
import { signIn } from "./support/sign-in";

/**
 * Messages during a run and live drafts (run input spec 2026-11-07): a message sent while a reply
 * streams is an interjection placed below it, a reload mid-stream resumes the draft without a gap
 * or a duplicate, and two running conversations each keep a complete draft when switched back and
 * forth. model-fake's `slow:<ms>:<text>` streams a few characters per `<ms>`.
 */

const sentence = (word: string): string => `${word} are calm and the largest living rodents. `;
const A_TEXT = sentence("Capybaras").repeat(6).trim();
const B_TEXT = sentence("Otters").repeat(6).trim();

/** The text of the last reply, "" when there is none yet. */
async function lastReply(page: import("@playwright/test").Page): Promise<string> {
  return (
    (await replies(page)
      .last()
      .textContent({ timeout: 50 })
      .catch(() => "")) ?? ""
  ).trim();
}

test("a message during a streaming reply is a bubble below the reply", async ({ page }) => {
  await signIn(page);
  const orgId = await currentOrg(page);
  const agentId = await createAgent(page, orgId, "Live interject");
  await page.goto(`/chat?agent=${agentId}`);
  await send(page, `slow:150:${A_TEXT}`);
  // the reply is under way, not whole
  await expect.poll(() => lastReply(page), { intervals: [50] }).not.toBe("");
  expect(await lastReply(page)).not.toBe(A_TEXT);
  await send(page, "Please keep it short.");
  const bubble = users(page).filter({ hasText: "Please keep it short." });
  await expect(bubble).toHaveCount(1);
  const reply = replies(page).first();
  const replyBox = await reply.boundingBox();
  const bubbleBox = await bubble.boundingBox();
  expect(replyBox).not.toBeNull();
  expect(bubbleBox).not.toBeNull();
  expect((bubbleBox?.y ?? 0) > (replyBox?.y ?? 0)).toBe(true);
  // the composer stays usable and the first reply still completes whole
  await expect(composer(page)).toBeEnabled();
  await expect(reply).toHaveText(A_TEXT, { timeout: 30_000 });
});

test("a reload mid-stream resumes the draft with no gap and no duplicate", async ({ page }) => {
  await signIn(page);
  const orgId = await currentOrg(page);
  const agentId = await createAgent(page, orgId, "Live reload");
  await page.goto(`/chat?agent=${agentId}`);
  await send(page, `slow:150:${A_TEXT}`);
  await expect.poll(() => lastReply(page), { intervals: [50] }).not.toBe("");
  expect(await lastReply(page)).not.toBe(A_TEXT);
  await page.reload();
  await expect(page.locator('[data-template="ConversationPage"]')).toBeVisible();
  // never longer than the text, never a different prefix, while it grows
  await expect
    .poll(
      async () => {
        const text = await lastReply(page);
        expect(A_TEXT.startsWith(text), `unexpected text: ${text}`).toBe(true);
        return text === A_TEXT;
      },
      { intervals: [50], timeout: 30_000 },
    )
    .toBe(true);
  // exactly one reply and one user bubble, the final message and not also a draft
  await expect(replies(page)).toHaveCount(1);
  await expect(users(page)).toHaveCount(1);
});

test("two running conversations switched back and forth keep complete drafts", async ({ page }) => {
  await signIn(page);
  const orgId = await currentOrg(page);
  const agentId = await createAgent(page, orgId, "Live switch");
  await page.goto(`/chat?agent=${agentId}`);
  await send(page, `slow:200:${A_TEXT}`);
  const urlA = page.url();
  await expect.poll(() => lastReply(page), { intervals: [50] }).not.toBe("");
  await page.goto(`/chat?agent=${agentId}`);
  await send(page, `slow:200:${B_TEXT}`);
  const urlB = page.url();
  expect(urlB).not.toBe(urlA);
  for (const [url, expected] of [
    [urlA, A_TEXT],
    [urlB, B_TEXT],
    [urlA, A_TEXT],
  ] as const) {
    await page.goto(url);
    await expect(page.locator('[data-template="ConversationPage"]')).toBeVisible();
    await expect
      .poll(
        async () => {
          const text = await lastReply(page);
          expect(expected.startsWith(text), `unexpected text: ${text}`).toBe(true);
          return text.length;
        },
        { intervals: [50] },
      )
      .toBeGreaterThan(0);
  }
  // both finish whole
  await page.goto(urlB);
  await expect(replies(page).first()).toHaveText(B_TEXT, { timeout: 30_000 });
  await page.goto(urlA);
  await expect(replies(page).first()).toHaveText(A_TEXT, { timeout: 30_000 });
  await expect(replies(page)).toHaveCount(1);
});
