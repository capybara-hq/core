import { expect, test } from "@playwright/test";
import {
  composer,
  conversationIdOf,
  createAgent,
  currentOrg,
  replies,
  send,
  users,
} from "./support/chat";
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
  await page.goto(`/?agent=${agentId}`);
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
  await page.goto(`/?agent=${agentId}`);
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

test("two running conversations switched in the app keep complete drafts", async ({ page }) => {
  await signIn(page);
  const orgId = await currentOrg(page);
  const agentId = await createAgent(page, orgId, "Live switch");
  await page.goto(`/?agent=${agentId}`);
  await send(page, `slow:200:${A_TEXT}`);
  const idA = conversationIdOf(page);
  await expect.poll(() => lastReply(page), { intervals: [50] }).not.toBe("");
  // a second conversation starts from the sidebar's new-conversation flow of the same agent
  await page.goto(`/?agent=${agentId}`);
  await send(page, `slow:200:${B_TEXT}`);
  const idB = conversationIdOf(page);
  expect(idB).not.toBe(idA);
  // switching is in-app (the sidebar's links), so the query cache keeps the old state
  const sidebar = page.getByRole("region", { name: "会话" });
  const open = async (id: string, expected: string): Promise<void> => {
    await sidebar.locator(`a[href$="/chat/${id}"]`).click();
    await expect(page).toHaveURL(new RegExp(`/chat/${id}(#.*)?$`));
    await expect
      .poll(
        async () => {
          const text = await lastReply(page);
          // the draft is a prefix of the whole reply, never another conversation's text
          expect(expected.startsWith(text), `unexpected text: ${text}`).toBe(true);
          return text.length;
        },
        { intervals: [50] },
      )
      .toBeGreaterThan(0);
  };
  await open(idA, A_TEXT);
  await open(idB, B_TEXT);
  await open(idA, A_TEXT);
  await open(idB, B_TEXT);
  await open(idA, A_TEXT);
  // both finish whole, one reply each
  await expect(replies(page).first()).toHaveText(A_TEXT, { timeout: 30_000 });
  await expect(replies(page)).toHaveCount(1);
  await open(idB, B_TEXT);
  await expect(replies(page).first()).toHaveText(B_TEXT, { timeout: 30_000 });
  await expect(replies(page)).toHaveCount(1);
  // a full load of either shows the same whole replies
  await page.goto(`/chat/${idA}`);
  await expect(replies(page).first()).toHaveText(A_TEXT);
  await expect(replies(page)).toHaveCount(1);
});
