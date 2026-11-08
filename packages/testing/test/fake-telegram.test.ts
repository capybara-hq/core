import { afterEach, describe, expect, it } from "vitest";
import {
  type FakeTelegramServer,
  findTelegramButton,
  startFakeTelegram,
  type TgUser,
  telegramCallback,
  telegramGroupMessage,
  telegramPrivateMessage,
  telegramWebhookHeaders,
} from "../src/fake-telegram.js";

/** The fake Telegram Bot API: routing, the methods a channel plugin uses, long polling, failures. */

let tg: FakeTelegramServer | undefined;

afterEach(async () => {
  await tg?.close();
  tg = undefined;
});

const ALICE: TgUser = { id: 1001, first_name: "Alice", username: "alice" };

type Envelope = {
  ok: boolean;
  result?: unknown;
  error_code?: number;
  description?: string;
  parameters?: Record<string, unknown>;
};

async function call(
  s: FakeTelegramServer,
  method: string,
  params: Record<string, unknown> = {},
  token = s.bot.token,
  signal?: AbortSignal,
): Promise<{ status: number; body: Envelope }> {
  const res = await fetch(`${s.apiUrl}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
    ...(signal && { signal }),
  });
  return { status: res.status, body: (await res.json()) as Envelope };
}

const waitFor = async (fn: () => boolean, what: string, ms = 5000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("fake Telegram Bot API", () => {
  it("routes POST and GET /bot<token>/<method> and answers an unknown token with 401", async () => {
    tg = await startFakeTelegram();
    expect(tg.apiUrl).toBe(tg.url);
    const viaGet = await fetch(`${tg.apiUrl}/bot${tg.bot.token}/getMe`);
    expect(viaGet.status).toBe(200);
    expect(((await viaGet.json()) as Envelope).ok).toBe(true);
    const viaForm = await fetch(`${tg.apiUrl}/bot${tg.bot.token}/getMe`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "",
    });
    expect(viaForm.status).toBe(200);
    const bad = await call(tg, "getMe", {}, "999:nope");
    expect(bad).toEqual({
      status: 401,
      body: { ok: false, error_code: 401, description: "Unauthorized" },
    });
    expect(tg.calls.map((c) => c.method)).toEqual(["getMe", "getMe"]);
  });

  it("getMe reports the bot, including can_read_all_group_messages and has_topics_enabled", async () => {
    tg = await startFakeTelegram({
      bots: [
        {
          token: "42:abc",
          id: 42,
          username: "cap_bot",
          firstName: "Cap",
          canReadAllGroupMessages: true,
          hasTopicsEnabled: true,
        },
        { token: "43:def", id: 43, username: "other_bot" },
      ],
    });
    expect(tg.bots).toHaveLength(2);
    const me = await call(tg, "getMe");
    expect(me.body.result).toEqual({
      id: 42,
      is_bot: true,
      first_name: "Cap",
      username: "cap_bot",
      can_join_groups: true,
      can_read_all_group_messages: true,
      supports_inline_queries: false,
      has_topics_enabled: true,
    });
    const other = await call(tg, "getMe", {}, "43:def");
    expect(other.body.result).toMatchObject({
      id: 43,
      username: "other_bot",
      can_read_all_group_messages: false,
      has_topics_enabled: false,
    });
  });

  it("getWebhookInfo reports the url set with setWebhook", async () => {
    tg = await startFakeTelegram();
    const none = await call(tg, "getWebhookInfo");
    expect(none.body.result).toMatchObject({ url: "", pending_update_count: 0 });
    tg.setWebhook("https://example.test/hook");
    tg.push(telegramPrivateMessage(ALICE, "hi"));
    const set = await call(tg, "getWebhookInfo");
    expect(set.body.result).toMatchObject({
      url: "https://example.test/hook",
      has_custom_certificate: false,
      pending_update_count: 1,
    });
  });

  it("getUpdates returns pushed updates, and an offset confirms the lower ids", async () => {
    tg = await startFakeTelegram();
    const a = tg.push(telegramPrivateMessage(ALICE, "one"));
    const b = tg.push(telegramPrivateMessage(ALICE, "two"));
    expect(b).toBe(a + 1);
    const first = await call(tg, "getUpdates");
    const ids = (first.body.result as { update_id: number }[]).map((u) => u.update_id);
    expect(ids).toEqual([a, b]);
    expect(tg.pending()).toBe(2);
    const second = await call(tg, "getUpdates", { offset: b });
    expect((second.body.result as { update_id: number }[]).map((u) => u.update_id)).toEqual([b]);
    expect(tg.confirmedOffset()).toBe(b);
    expect(tg.pending()).toBe(1);
    const third = await call(tg, "getUpdates", { offset: b + 1 });
    expect(third.body.result).toEqual([]);
    expect(tg.pending()).toBe(0);
    expect(tg.confirmedOffset()).toBe(b + 1);
  });

  it("getUpdates with a timeout long-polls until a push", async () => {
    tg = await startFakeTelegram();
    const s = tg;
    const poll = call(s, "getUpdates", { timeout: 10 });
    await waitFor(() => s.activePollers() === 1, "the poller");
    expect(s.pollerPeerPorts()).toHaveLength(1);
    const id = s.push(telegramPrivateMessage(ALICE, "wake"));
    const r = await poll;
    expect((r.body.result as { update_id: number }[]).map((u) => u.update_id)).toEqual([id]);
    expect(s.activePollers()).toBe(0);
    expect(s.maxConcurrentPollers()).toBe(1);
  });

  it("getUpdates with a timeout and no push answers an empty list when it expires", async () => {
    tg = await startFakeTelegram();
    const started = Date.now();
    const r = await call(tg, "getUpdates", { timeout: 1 });
    expect(r.body).toEqual({ ok: true, result: [] });
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  it("getUpdates filters by allowed_updates", async () => {
    tg = await startFakeTelegram();
    tg.push(telegramPrivateMessage(ALICE, "text"));
    const cb = tg.push(telegramCallback(ALICE, { chatId: ALICE.id, messageId: 5 }, "x"));
    const r = await call(tg, "getUpdates", { allowed_updates: ["callback_query"] });
    const got = r.body.result as { update_id: number; callback_query?: unknown }[];
    expect(got.map((u) => u.update_id)).toEqual([cb]);
    expect(got[0]?.callback_query).toBeDefined();
  });

  it("getUpdates while a webhook is set answers 409", async () => {
    tg = await startFakeTelegram();
    tg.setWebhook("https://example.test/hook");
    const r = await call(tg, "getUpdates");
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ ok: false, error_code: 409 });
    expect(r.body.description).toContain("can't use getUpdates method while webhook is active");
    tg.setWebhook(null);
    expect((await call(tg, "getUpdates")).status).toBe(200);
  });

  it("a second getUpdates for the same token ends the first with 409", async () => {
    tg = await startFakeTelegram({
      bots: [
        { token: "1:a", id: 1, username: "a_bot" },
        { token: "2:b", id: 2, username: "b_bot" },
      ],
    });
    const s = tg;
    const first = call(s, "getUpdates", { timeout: 10 });
    const otherBot = call(s, "getUpdates", { timeout: 10 }, "2:b");
    await waitFor(() => s.activePollers() === 1 && s.activePollers("2:b") === 1, "the pollers");
    const second = call(s, "getUpdates", { timeout: 10 });
    const r1 = await first;
    expect(r1).toEqual({
      status: 409,
      body: {
        ok: false,
        error_code: 409,
        description: "Conflict: terminated by other getUpdates request",
      },
    });
    await waitFor(() => s.activePollers() === 1, "the second poller");
    expect(s.maxConcurrentPollers()).toBe(2);
    expect(s.maxConcurrentPollers("2:b")).toBe(1);
    const id = s.push(telegramPrivateMessage(ALICE, "hi"));
    expect(((await second).body.result as { update_id: number }[])[0]?.update_id).toBe(id);
    const otherId = s.push(telegramPrivateMessage(ALICE, "hi b"), "2:b");
    expect(((await otherBot).body.result as { update_id: number }[])[0]?.update_id).toBe(otherId);
  });

  it("sendMessage assigns increasing message ids per chat and rejects text over 4096", async () => {
    tg = await startFakeTelegram();
    const markup = { inline_keyboard: [[{ text: "Approve", callback_data: "ap:1" }]] };
    const m1 = await call(tg, "sendMessage", {
      chat_id: 7,
      text: "hello",
      parse_mode: "HTML",
      reply_markup: markup,
      message_thread_id: 3,
      reply_parameters: { message_id: 9 },
    });
    const m2 = await call(tg, "sendMessage", { chat_id: 7, text: "again" });
    const other = await call(tg, "sendMessage", { chat_id: -100, text: "group" });
    const id = (r: { body: Envelope }) => (r.body.result as { message_id: number }).message_id;
    expect(id(m2)).toBe(id(m1) + 1);
    expect(id(other)).toBe(1);
    expect(m1.body.result).toMatchObject({
      chat: { id: 7 },
      from: { id: tg.bot.id, is_bot: true },
      text: "hello",
      message_thread_id: 3,
    });
    expect(tg.messages[0]).toMatchObject({
      chatId: 7,
      messageId: id(m1),
      text: "hello",
      parseMode: "HTML",
      replyMarkup: markup,
      messageThreadId: 3,
      replyToMessageId: 9,
    });
    expect(findTelegramButton(tg.messages[0]?.replyMarkup, (b) => b.text === "Approve")).toEqual({
      text: "Approve",
      callback_data: "ap:1",
    });
    const long = await call(tg, "sendMessage", { chat_id: 7, text: "x".repeat(4097) });
    expect(long).toEqual({
      status: 400,
      body: { ok: false, error_code: 400, description: "Bad Request: message is too long" },
    });
    expect(tg.messages).toHaveLength(3);
  });

  it("editMessageText records edits and answers 400 when the text is not modified", async () => {
    tg = await startFakeTelegram();
    const sent = await call(tg, "sendMessage", { chat_id: 7, text: "draft" });
    const messageId = (sent.body.result as { message_id: number }).message_id;
    const ok = await call(tg, "editMessageText", {
      chat_id: 7,
      message_id: messageId,
      text: "final",
    });
    expect(ok.body.result).toMatchObject({ message_id: messageId, text: "final" });
    expect(tg.edits).toEqual([expect.objectContaining({ chatId: 7, messageId, text: "final" })]);
    const same = await call(tg, "editMessageText", {
      chat_id: 7,
      message_id: messageId,
      text: "final",
    });
    expect(same).toEqual({
      status: 400,
      body: { ok: false, error_code: 400, description: "Bad Request: message is not modified" },
    });
    expect(tg.edits).toHaveLength(1);
  });

  it("answerCallbackQuery records the callback query id", async () => {
    tg = await startFakeTelegram();
    const r = await call(tg, "answerCallbackQuery", { callback_query_id: "cbq-1" });
    expect(r.body).toEqual({ ok: true, result: true });
    expect(tg.callbackAnswers).toEqual(["cbq-1"]);
  });

  it("failNext returns the failure envelope with retry_after / migrate_to_chat_id", async () => {
    tg = await startFakeTelegram();
    tg.failNext(
      "sendMessage",
      { status: 429, description: "Too Many Requests: retry after 3", retryAfter: 3 },
      2,
    );
    for (let i = 0; i < 2; i++) {
      const r = await call(tg, "sendMessage", { chat_id: 7, text: "x" });
      expect(r).toEqual({
        status: 429,
        body: {
          ok: false,
          error_code: 429,
          description: "Too Many Requests: retry after 3",
          parameters: { retry_after: 3 },
        },
      });
    }
    expect((await call(tg, "sendMessage", { chat_id: 7, text: "x" })).status).toBe(200);
    tg.failNext("sendMessage", {
      status: 400,
      description: "Bad Request: group chat was upgraded to a supergroup chat",
      migrateToChatId: -1001234,
    });
    const migrated = await call(tg, "sendMessage", { chat_id: -5, text: "x" });
    expect(migrated.body).toEqual({
      ok: false,
      error_code: 400,
      description: "Bad Request: group chat was upgraded to a supergroup chat",
      parameters: { migrate_to_chat_id: -1001234 },
    });
    expect(tg.messages).toHaveLength(1);
  });

  it("delay holds a method's responses", async () => {
    tg = await startFakeTelegram();
    tg.delay("getMe", 200);
    const started = Date.now();
    await call(tg, "getMe");
    expect(Date.now() - started).toBeGreaterThanOrEqual(180);
  });

  it("close ends an in-flight long poll", async () => {
    const s = await startFakeTelegram();
    const poll = call(s, "getUpdates", { timeout: 30 }).catch((e: unknown) => e);
    await waitFor(() => s.activePollers() === 1, "the poller");
    await s.close();
    await poll;
    expect(s.activePollers()).toBe(0);
  });
});

describe("Telegram update builders", () => {
  const GROUP = { id: -1001, type: "supergroup" as const, title: "Team", is_forum: true };
  const BOT = { token: "9:x", id: 9, username: "cap_bot", firstName: "Cap" };

  it("telegramPrivateMessage builds a private message", () => {
    const u = telegramPrivateMessage(ALICE, "/start now", { messageId: 5, date: 1700 });
    expect(u).toEqual({
      message: {
        message_id: 5,
        date: 1700,
        chat: { id: 1001, type: "private", first_name: "Alice", username: "alice" },
        from: { id: 1001, is_bot: false, first_name: "Alice", username: "alice" },
        text: "/start now",
        entities: [{ type: "bot_command", offset: 0, length: 6 }],
      },
    });
  });

  it("telegramGroupMessage adds a mention entity with UTF-16 offset and length", () => {
    const u = telegramGroupMessage(GROUP, ALICE, "😀 hi @cap_bot there", { mention: "cap_bot" });
    const m = u.message as Record<string, unknown>;
    expect(m.chat).toEqual(GROUP);
    expect(m.entities).toEqual([{ type: "mention", offset: 6, length: 8 }]);
    const prefixed = telegramGroupMessage(GROUP, ALICE, "hello", { mention: "@cap_bot" });
    expect((prefixed.message as Record<string, unknown>).text).toBe("@cap_bot hello");
  });

  it("telegramGroupMessage builds replies to the bot, topic messages and photo captions", () => {
    const u = telegramGroupMessage(GROUP, ALICE, "more", {
      messageId: 11,
      replyTo: { messageId: 10, fromBot: BOT, text: "earlier" },
      messageThreadId: 4,
    });
    const m = u.message as Record<string, unknown>;
    expect(m).toMatchObject({ message_id: 11, message_thread_id: 4, is_topic_message: true });
    expect(m.reply_to_message).toMatchObject({
      message_id: 10,
      text: "earlier",
      chat: GROUP,
      from: { id: 9, is_bot: true, first_name: "Cap", username: "cap_bot" },
    });
    const photo = telegramGroupMessage(GROUP, ALICE, "look", { mention: "cap_bot", caption: true });
    const p = photo.message as Record<string, unknown>;
    expect(p.text).toBeUndefined();
    expect(p.entities).toBeUndefined();
    expect(p.caption).toBe("@cap_bot look");
    expect(p.caption_entities).toEqual([{ type: "mention", offset: 0, length: 8 }]);
    expect(Array.isArray(p.photo) && p.photo.length > 0).toBe(true);
  });

  it("telegramCallback builds a callback query on a bot message", () => {
    const u = telegramCallback(ALICE, { chatId: -1001, messageId: 3, messageThreadId: 4 }, "ap:1", {
      id: "cbq-9",
    });
    expect(u).toEqual({
      callback_query: {
        id: "cbq-9",
        from: { id: 1001, is_bot: false, first_name: "Alice", username: "alice" },
        chat_instance: expect.any(String),
        data: "ap:1",
        message: {
          message_id: 3,
          date: expect.any(Number),
          chat: { id: -1001, type: "supergroup" },
          message_thread_id: 4,
        },
      },
    });
  });

  it("telegramWebhookHeaders carries the secret token header", () => {
    expect(telegramWebhookHeaders("s3cret")).toEqual({
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": "s3cret",
    });
  });
});
