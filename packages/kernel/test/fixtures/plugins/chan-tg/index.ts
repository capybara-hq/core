import { type Channel, ChannelSendError, defineExtension, secret } from "@capybara-hq/plugin-sdk";
import { z } from "zod";

/**
 * A minimal Telegram channel for kernel tests (not the official `telegram` plugin, which lives in
 * capybara-hq/plugins and core tests may not load): it sends plain text through the Bot API of
 * `startFakeTelegram` (`<apiUrl>/bot<token>/sendMessage`); its long connection polls `getUpdates`
 * and hands private text messages to the kernel (confirming each only after `onEvent` resolves;
 * tests seed the identities). Features: no cards, no edits, no threads.
 * Bot API errors map to `ChannelSendError` as the real plugin maps them: 401 `auth`, 403 and
 * "chat not found" `target_gone`, 429 / 5xx retryable, others `rejected`.
 */
const Connection = z.object({
  apiUrl: z.string().url(),
  botToken: secret(z.string().min(1)),
});
type Conn = z.infer<typeof Connection>;

interface BotReply {
  ok: boolean;
  result?: { id?: number; username?: string; message_id?: number };
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

interface TgUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number; type: string };
    from?: { id: number };
    text?: string;
  };
}

async function call(
  c: Conn,
  method: string,
  params: Record<string, unknown>,
  signal: AbortSignal,
): Promise<NonNullable<BotReply["result"]>> {
  const res = await fetch(`${c.apiUrl}/bot${c.botToken}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
    signal,
  });
  const body = (await res.json().catch(() => ({ ok: false }))) as BotReply;
  if (body.ok && body.result) return body.result;
  const code = body.error_code ?? res.status;
  const step = `telegram ${method} failed: ${code}`;
  if (code === 429 || code >= 500) {
    const after = body.parameters?.retry_after;
    throw new ChannelSendError(step, {
      retryable: true,
      ...(after !== undefined && { retryAfterMs: after * 1000 }),
    });
  }
  const gone = code === 403 || /chat not found/i.test(body.description ?? "");
  throw new ChannelSendError(step, {
    retryable: false,
    reason: code === 401 ? "auth" : gone ? "target_gone" : "rejected",
  });
}

const channel: Channel = {
  connectionSchema: Connection,
  features: { cards: false, edit: false, threads: false },
  async verify({ config, signal }) {
    const me = await call(config as Conn, "getMe", {}, signal);
    return {
      botUserId: String(me.id),
      botName: me.username ?? "bot",
      tenantId: String(me.id),
    };
  },
  async connect({ config, onEvent, signal }) {
    const c = config as Conn;
    const tenantId = c.botToken.split(":")[0] ?? "";
    let offset = 0;
    while (!signal.aborted) {
      let updates: TgUpdate[];
      try {
        updates = (await call(
          c,
          "getUpdates",
          { offset, timeout: 1, allowed_updates: ["message"] },
          signal,
        )) as unknown as TgUpdate[];
      } catch (e) {
        if (signal.aborted) return;
        // the kernel reconnects
        throw e;
      }
      for (const u of updates) {
        const m = u.message;
        if (m?.chat.type === "private" && m.from !== undefined && typeof m.text === "string") {
          await onEvent({
            type: "message",
            messageId: String(m.message_id),
            target: { chatId: String(m.chat.id), chatType: "dm" },
            sender: { externalId: String(m.from.id), tenantId },
            text: m.text,
            mentionsBot: false,
          });
        }
        offset = u.update_id + 1;
      }
    }
  },
  async send({ config, target, message, signal }) {
    const sent = await call(
      config as Conn,
      "sendMessage",
      { chat_id: Number(target.chatId), text: message.text },
      signal,
    );
    return { messageId: String(sent.message_id) };
  },
  async update() {
    throw new ChannelSendError("chan-tg cannot edit", { retryable: false, reason: "rejected" });
  },
};

export default defineExtension({
  name: "chan-tg",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: ["channel@1"],
  setup(ctx) {
    ctx.provide("channel@1", channel);
  },
});
