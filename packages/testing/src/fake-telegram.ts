import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A programmable fake Telegram Bot API (for the Telegram channel plugin's tests).
 *
 * - **Routing**: `GET|POST /bot<token>/<method>` (method names are case-insensitive, like Telegram);
 *   parameters come from the query string and a JSON or form-urlencoded body. Every answer is the
 *   Bot API envelope: `{ ok: true, result }` or `{ ok: false, error_code, description, parameters? }`.
 *   An unknown token → 401 `Unauthorized`; an unknown method → 404 `Not Found`. Point a client at
 *   `apiUrl` (it appends `/bot<token>/<method>`).
 * - **Methods**: `getMe`, `getWebhookInfo` (the url given to {@link FakeTelegramServer.setWebhook}),
 *   `getUpdates`, `sendMessage`, `editMessageText`, `answerCallbackQuery`.
 * - **Long polling**: {@link FakeTelegramServer.push} queues an update per bot and assigns its
 *   `update_id`. `getUpdates` with `offset` confirms (drops) the lower ids; with `timeout` it waits
 *   until a push or the timeout; `allowed_updates` is remembered per bot like Telegram and updates of
 *   other types are dropped. While a webhook is set `getUpdates` answers 409; a second concurrent
 *   `getUpdates` for the same token ends the earlier one with 409 "Conflict: terminated by other
 *   getUpdates request", as Telegram does.
 * - **Several bots**: {@link FakeTelegramOptions.bots}; each token has its own queue, offset, webhook
 *   and pollers.
 * - **Failures**: {@link FakeTelegramServer.failNext} answers a method with an error envelope
 *   (`parameters.retry_after` / `migrate_to_chat_id`), {@link FakeTelegramServer.delay} holds it.
 *
 * Records: `messages` (sendMessage), `edits` (successful editMessageText), `calls` (every call with
 * a known token), `callbackAnswers` (answerCallbackQuery ids).
 */

export interface FakeTelegramBot {
  /** `<id>:<secret>`, as BotFather issues it. */
  token: string;
  id: number;
  username: string;
  firstName?: string;
  /** getMe `can_read_all_group_messages` (privacy mode off); default false. */
  canReadAllGroupMessages?: boolean;
  /** getMe `has_topics_enabled` (forum topics in private chats); default false. */
  hasTopicsEnabled?: boolean;
}

/** One Bot API call with a known token (parameters merged from query string and body). */
export interface FakeTelegramCall {
  method: string;
  token: string;
  params: Record<string, unknown>;
  at: number;
}

/** A message the bot sent (`sendMessage`) or an edit of one (`editMessageText`). */
export interface FakeTelegramMessage {
  chatId: number;
  messageId: number;
  text: string;
  parseMode?: string;
  replyMarkup?: unknown;
  messageThreadId?: number;
  replyToMessageId?: number;
  at: number;
}

/** An injected error answer: `status` is the HTTP status, `errorCode` defaults to it. */
export interface FakeTelegramFailure {
  status: number;
  errorCode?: number;
  description: string;
  retryAfter?: number;
  migrateToChatId?: number;
}

export interface FakeTelegramOptions {
  /** The bots this fake serves; default one bot (`123456:fake-telegram-token`, `capybara_bot`). */
  bots?: FakeTelegramBot[];
}

export interface FakeTelegramServer {
  url: string;
  /** Same as `url`: the client appends `/bot<token>/<method>`. */
  apiUrl: string;
  /** The first bot (the default for every `token?` argument). */
  bot: FakeTelegramBot;
  bots: FakeTelegramBot[];
  /** sendMessage results, in order. */
  messages: FakeTelegramMessage[];
  /** Successful editMessageText calls, in order. */
  edits: FakeTelegramMessage[];
  calls: FakeTelegramCall[];
  /** answerCallbackQuery `callback_query_id`s, in order. */
  callbackAnswers: string[];
  /** Queues an update for the bot, assigns its `update_id` and returns it; wakes a long poll. */
  push(update: Record<string, unknown>, token?: string): number;
  /** The highest offset passed to getUpdates (0 before any). */
  confirmedOffset(token?: string): number;
  /** Updates pushed and not yet confirmed. */
  pending(token?: string): number;
  /** In-flight getUpdates requests. */
  activePollers(token?: string): number;
  /**
   * The peak number of overlapping getUpdates requests: a request that arrives while another is in
   * flight counts as concurrent with it, although it ends the earlier one with 409.
   */
  maxConcurrentPollers(token?: string): number;
  /**
   * The client TCP ports of the in-flight getUpdates requests; dual-replica tests map them to the
   * replica process holding the poll.
   */
  pollerPeerPorts(token?: string): number[];
  /** Sets (or clears with null) the webhook getWebhookInfo reports; while set, getUpdates is 409. */
  setWebhook(url: string | null, token?: string): void;
  /** The next `count` (default 1) calls of `method` answer with `failure`. */
  failNext(method: string, failure: FakeTelegramFailure, count?: number): void;
  /** Every later call of `method` waits `ms` before answering (0 cancels). */
  delay(method: string, ms: number): void;
  close(): Promise<void>;
}

export type TgUser = {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  is_bot?: boolean;
};

export type TgChat = {
  id: number;
  type: "private" | "group" | "supergroup";
  title?: string;
  is_forum?: boolean;
};

const MAX_TEXT = 4096;
const JSON_PARAMS = new Set(["reply_markup", "reply_parameters", "allowed_updates", "entities"]);

const DEFAULT_BOT: FakeTelegramBot = {
  token: "123456:fake-telegram-token",
  id: 123456,
  username: "capybara_bot",
  firstName: "Capybara",
};

class TelegramError extends Error {
  constructor(
    readonly code: number,
    description: string,
  ) {
    super(description);
  }
}

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve, reject) => {
    let body = "";
    req.on("data", (c: Buffer) => {
      body += c.toString();
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });

function parseParams(url: URL, raw: string, contentType: string | undefined) {
  const out: Record<string, unknown> = {};
  const fromForm = (form: URLSearchParams) => {
    for (const [k, v] of form) {
      if (JSON_PARAMS.has(k)) {
        try {
          out[k] = JSON.parse(v);
          continue;
        } catch {
          // keep the raw string
        }
      }
      out[k] = v;
    }
  };
  fromForm(url.searchParams);
  if (raw === "") return out;
  if (contentType?.includes("application/json")) {
    Object.assign(out, JSON.parse(raw) as Record<string, unknown>);
  } else {
    fromForm(new URLSearchParams(raw));
  }
  return out;
}

const num = (v: unknown): number | undefined => {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
};
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const nowSec = () => Math.floor(Date.now() / 1000);
/** The update's type: its one field besides `update_id`. */
const updateType = (u: Record<string, unknown>) => Object.keys(u).find((k) => k !== "update_id");

interface Poller {
  res: ServerResponse;
  port: number | undefined;
  limit: number;
  timer: NodeJS.Timeout;
}

interface BotState {
  bot: FakeTelegramBot;
  queue: Record<string, unknown>[];
  nextUpdateId: number;
  confirmed: number;
  webhook: string;
  allowed: Set<string> | undefined;
  pollers: Poller[];
  peakPollers: number;
}

/** Starts the fake Telegram Bot API (listens on a random 127.0.0.1 port). */
export async function startFakeTelegram(
  opts: FakeTelegramOptions = {},
): Promise<FakeTelegramServer> {
  const bots = opts.bots && opts.bots.length > 0 ? opts.bots : [DEFAULT_BOT];
  const states = new Map<string, BotState>();
  for (const [i, bot] of bots.entries()) {
    if (states.has(bot.token)) throw new Error(`fake telegram: duplicate bot token ${bot.token}`);
    states.set(bot.token, {
      bot,
      queue: [],
      nextUpdateId: 100_000_001 + i * 10_000_000,
      confirmed: 0,
      webhook: "",
      allowed: undefined,
      pollers: [],
      peakPollers: 0,
    });
  }
  const first = bots[0] as FakeTelegramBot;
  const messages: FakeTelegramMessage[] = [];
  const edits: FakeTelegramMessage[] = [];
  const calls: FakeTelegramCall[] = [];
  const callbackAnswers: string[] = [];
  const failures: { method: string; failure: FakeTelegramFailure; left: number }[] = [];
  const delays = new Map<string, number>();
  /** Per bot and chat: the last message id sent. */
  const lastMessageId = new Map<string, number>();
  /** Per bot, chat and message: the current text and markup (for "message is not modified"). */
  const current = new Map<string, FakeTelegramMessage>();
  let closed = false;

  const stateOf = (token: string | undefined) => {
    const s = states.get(token ?? first.token);
    if (!s) throw new Error(`fake telegram: unknown bot token ${token}`);
    return s;
  };

  const reply = (res: ServerResponse, status: number, body: unknown) => {
    if (res.headersSent || res.destroyed) return;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const ok = (res: ServerResponse, result: unknown) => reply(res, 200, { ok: true, result });
  const fail = (res: ServerResponse, code: number, description: string) =>
    reply(res, code, { ok: false, error_code: code, description });

  const botUser = (bot: FakeTelegramBot) => ({
    id: bot.id,
    is_bot: true,
    first_name: bot.firstName ?? bot.username,
    username: bot.username,
  });

  /** Drops updates of types not allowed, then returns up to `limit` of the queue. */
  const collect = (s: BotState, limit: number) => {
    if (s.allowed) {
      const allowed = s.allowed;
      s.queue = s.queue.filter((u) => allowed.has(updateType(u) ?? ""));
    }
    return s.queue.slice(0, limit);
  };

  const removePoller = (s: BotState, p: Poller) => {
    clearTimeout(p.timer);
    const i = s.pollers.indexOf(p);
    if (i >= 0) s.pollers.splice(i, 1);
  };

  const getUpdates = (s: BotState, params: Record<string, unknown>, req: IncomingMessage) => {
    if (s.webhook !== "") {
      throw new TelegramError(
        409,
        "Conflict: can't use getUpdates method while webhook is active; use deleteWebhook to delete the webhook first",
      );
    }
    const offset = num(params.offset);
    if (offset !== undefined && offset > 0) {
      s.queue = s.queue.filter((u) => (u.update_id as number) >= offset);
      s.confirmed = Math.max(s.confirmed, offset);
    } else if (offset !== undefined && offset < 0) {
      s.queue = s.queue.slice(offset);
    }
    const allowed = params.allowed_updates;
    if (Array.isArray(allowed)) {
      s.allowed = allowed.length > 0 ? new Set(allowed.map(String)) : undefined;
    }
    // An overlapping request counts as concurrent even though Telegram ends the earlier one.
    s.peakPollers = Math.max(s.peakPollers, s.pollers.length + 1);
    for (const earlier of [...s.pollers]) {
      removePoller(s, earlier);
      fail(earlier.res, 409, "Conflict: terminated by other getUpdates request");
    }
    const limit = Math.min(Math.max(num(params.limit) ?? 100, 1), 100);
    const timeout = Math.max(num(params.timeout) ?? 0, 0);
    return { limit, timeout, ready: collect(s, limit), port: req.socket.remotePort };
  };

  const sendMessage = (s: BotState, params: Record<string, unknown>) => {
    const chatId = num(params.chat_id);
    if (chatId === undefined) throw new TelegramError(400, "Bad Request: chat not found");
    const text = str(params.text) ?? "";
    if (text === "") throw new TelegramError(400, "Bad Request: message text is empty");
    if (text.length > MAX_TEXT) throw new TelegramError(400, "Bad Request: message is too long");
    const chatKey = `${s.bot.token}|${chatId}`;
    const messageId = (lastMessageId.get(chatKey) ?? 0) + 1;
    lastMessageId.set(chatKey, messageId);
    const threadId = num(params.message_thread_id);
    const replyParams = params.reply_parameters as { message_id?: unknown } | undefined;
    const replyTo = num(replyParams?.message_id) ?? num(params.reply_to_message_id);
    const parseMode = str(params.parse_mode);
    const m: FakeTelegramMessage = {
      chatId,
      messageId,
      text,
      ...(parseMode !== undefined && { parseMode }),
      ...(params.reply_markup !== undefined && { replyMarkup: params.reply_markup }),
      ...(threadId !== undefined && { messageThreadId: threadId }),
      ...(replyTo !== undefined && { replyToMessageId: replyTo }),
      at: Date.now(),
    };
    messages.push(m);
    current.set(`${chatKey}|${messageId}`, m);
    return messageResult(s, m);
  };

  const editMessageText = (s: BotState, params: Record<string, unknown>) => {
    const chatId = num(params.chat_id);
    const messageId = num(params.message_id);
    const key = `${s.bot.token}|${chatId}|${messageId}`;
    const before = current.get(key);
    if (chatId === undefined || messageId === undefined || !before) {
      throw new TelegramError(400, "Bad Request: message to edit not found");
    }
    const text = str(params.text) ?? "";
    if (text === "") throw new TelegramError(400, "Bad Request: message text is empty");
    if (text.length > MAX_TEXT) throw new TelegramError(400, "Bad Request: message is too long");
    const markup = params.reply_markup;
    if (text === before.text && JSON.stringify(markup) === JSON.stringify(before.replyMarkup)) {
      throw new TelegramError(400, "Bad Request: message is not modified");
    }
    const parseMode = str(params.parse_mode);
    const m: FakeTelegramMessage = {
      chatId,
      messageId,
      text,
      ...(parseMode !== undefined && { parseMode }),
      ...(markup !== undefined && { replyMarkup: markup }),
      ...(before.messageThreadId !== undefined && { messageThreadId: before.messageThreadId }),
      ...(before.replyToMessageId !== undefined && { replyToMessageId: before.replyToMessageId }),
      at: Date.now(),
    };
    edits.push(m);
    current.set(key, m);
    return { ...messageResult(s, m), edit_date: nowSec() };
  };

  const messageResult = (s: BotState, m: FakeTelegramMessage) => ({
    message_id: m.messageId,
    from: botUser(s.bot),
    chat: { id: m.chatId, type: m.chatId > 0 ? "private" : "supergroup" },
    date: Math.floor(m.at / 1000),
    text: m.text,
    ...(m.messageThreadId !== undefined && { message_thread_id: m.messageThreadId }),
    ...(m.replyMarkup !== undefined && { reply_markup: m.replyMarkup }),
  });

  const handle = async (req: IncomingMessage, res: ServerResponse, token: string, name: string) => {
    const url = new URL(req.url ?? "/", "http://x");
    const params = parseParams(url, await readBody(req), req.headers["content-type"]);
    const s = states.get(token);
    if (!s) return fail(res, 401, "Unauthorized");
    calls.push({ method: name, token, params, at: Date.now() });
    const method = name.toLowerCase();
    const wait = delays.get(method) ?? 0;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const f = failures.find((x) => x.method === method && x.left > 0);
    if (f) {
      f.left--;
      const { status, errorCode, description, retryAfter, migrateToChatId } = f.failure;
      const parameters = {
        ...(retryAfter !== undefined && { retry_after: retryAfter }),
        ...(migrateToChatId !== undefined && { migrate_to_chat_id: migrateToChatId }),
      };
      return reply(res, status, {
        ok: false,
        error_code: errorCode ?? status,
        description,
        ...(Object.keys(parameters).length > 0 && { parameters }),
      });
    }
    try {
      switch (method) {
        case "getme":
          return ok(res, {
            ...botUser(s.bot),
            can_join_groups: true,
            can_read_all_group_messages: s.bot.canReadAllGroupMessages ?? false,
            supports_inline_queries: false,
            has_topics_enabled: s.bot.hasTopicsEnabled ?? false,
          });
        case "getwebhookinfo":
          return ok(res, {
            url: s.webhook,
            has_custom_certificate: false,
            pending_update_count: s.queue.length,
          });
        case "getupdates": {
          const { limit, timeout, ready, port } = getUpdates(s, params, req);
          if (ready.length > 0 || timeout === 0 || closed) return ok(res, ready);
          const p: Poller = {
            res,
            port,
            limit,
            timer: setTimeout(() => {
              removePoller(s, p);
              ok(res, collect(s, limit));
            }, timeout * 1000),
          };
          s.pollers.push(p);
          res.on("close", () => removePoller(s, p));
          return;
        }
        case "sendmessage":
          return ok(res, sendMessage(s, params));
        case "editmessagetext":
          return ok(res, editMessageText(s, params));
        case "answercallbackquery":
          callbackAnswers.push(str(params.callback_query_id) ?? "");
          return ok(res, true);
        default:
          return fail(res, 404, "Not Found");
      }
    } catch (e) {
      if (e instanceof TelegramError) return fail(res, e.code, e.message);
      throw e;
    }
  };

  const server = createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? "/", "http://x").pathname;
      const m = /^\/bot([^/]+)\/([A-Za-z]+)$/.exec(path);
      if (!m || (req.method !== "GET" && req.method !== "POST")) {
        return fail(res, 404, "Not Found");
      }
      return handle(req, res, decodeURIComponent(m[1] as string), m[2] as string);
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url,
    apiUrl: url,
    bot: first,
    bots,
    messages,
    edits,
    calls,
    callbackAnswers,
    push(update, token) {
      const s = stateOf(token);
      const id = s.nextUpdateId++;
      s.queue.push({ update_id: id, ...update });
      for (const p of [...s.pollers]) {
        const ready = collect(s, p.limit);
        if (ready.length === 0) continue;
        removePoller(s, p);
        ok(p.res, ready);
      }
      return id;
    },
    confirmedOffset: (token) => stateOf(token).confirmed,
    pending: (token) => stateOf(token).queue.length,
    activePollers: (token) => stateOf(token).pollers.length,
    maxConcurrentPollers: (token) => stateOf(token).peakPollers,
    pollerPeerPorts: (token) =>
      stateOf(token).pollers.flatMap((p) => (p.port === undefined ? [] : [p.port])),
    setWebhook(webhookUrl, token) {
      stateOf(token).webhook = webhookUrl ?? "";
    },
    failNext(method, failure, count = 1) {
      failures.push({ method: method.toLowerCase(), failure, left: count });
    },
    delay(method, ms) {
      delays.set(method.toLowerCase(), ms);
    },
    async close() {
      closed = true;
      for (const s of states.values()) for (const p of [...s.pollers]) removePoller(s, p);
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

let seq = 0;
const nextMessageId = () => 1000 + ++seq;

const userOf = (u: TgUser) => ({
  id: u.id,
  is_bot: u.is_bot ?? false,
  first_name: u.first_name,
  ...(u.last_name !== undefined && { last_name: u.last_name }),
  ...(u.username !== undefined && { username: u.username }),
});

/** A `bot_command` entity when the text starts with `/command`. */
const commandEntities = (text: string) => {
  const m = /^\/[A-Za-z0-9_]+(@[A-Za-z0-9_]+)?/.exec(text);
  return m ? [{ type: "bot_command", offset: 0, length: m[0].length }] : [];
};

/** An update with a private (direct) message from `from`. */
export function telegramPrivateMessage(
  from: TgUser,
  text: string,
  o: { messageId?: number; date?: number } = {},
): Record<string, unknown> {
  const entities = commandEntities(text);
  return {
    message: {
      message_id: o.messageId ?? nextMessageId(),
      date: o.date ?? nowSec(),
      chat: {
        id: from.id,
        type: "private",
        first_name: from.first_name,
        ...(from.last_name !== undefined && { last_name: from.last_name }),
        ...(from.username !== undefined && { username: from.username }),
      },
      from: userOf(from),
      text,
      ...(entities.length > 0 && { entities }),
    },
  };
}

/**
 * An update with a group message. `mention` (with or without `@`) adds a `mention` entity at its
 * UTF-16 offset, prefixing `@<mention> ` when the text lacks it; `replyTo` sets `reply_to_message`
 * (from the bot when `fromBot` is given); `messageThreadId` sets the thread, with
 * `is_topic_message` defaulting to the chat's `is_forum`; `caption` turns the message into a photo
 * whose caption carries the text and entities.
 */
export function telegramGroupMessage(
  chat: TgChat,
  from: TgUser,
  text: string,
  o: {
    messageId?: number;
    mention?: string;
    replyTo?: { messageId: number; fromBot?: FakeTelegramBot; text?: string };
    messageThreadId?: number;
    isTopicMessage?: boolean;
    caption?: boolean;
  } = {},
): Record<string, unknown> {
  let body = text;
  const entities: { type: string; offset: number; length: number }[] = commandEntities(text);
  if (o.mention !== undefined) {
    const handle = o.mention.startsWith("@") ? o.mention : `@${o.mention}`;
    if (!body.includes(handle)) body = `${handle} ${body}`;
    entities.splice(0, entities.length, ...commandEntities(body));
    entities.push({ type: "mention", offset: body.indexOf(handle), length: handle.length });
  }
  const date = nowSec();
  const isTopic = o.isTopicMessage ?? (chat.is_forum === true ? true : undefined);
  const r = o.replyTo;
  const replyFrom = r?.fromBot
    ? {
        id: r.fromBot.id,
        is_bot: true,
        first_name: r.fromBot.firstName ?? r.fromBot.username,
        username: r.fromBot.username,
      }
    : userOf(from);
  return {
    message: {
      message_id: o.messageId ?? nextMessageId(),
      date,
      chat,
      from: userOf(from),
      ...(o.messageThreadId !== undefined && { message_thread_id: o.messageThreadId }),
      ...(o.messageThreadId !== undefined &&
        isTopic !== undefined && { is_topic_message: isTopic }),
      ...(r && {
        reply_to_message: {
          message_id: r.messageId,
          date: date - 60,
          chat,
          from: replyFrom,
          text: r.text ?? "",
          ...(o.messageThreadId !== undefined && { message_thread_id: o.messageThreadId }),
        },
      }),
      ...(o.caption
        ? {
            photo: [
              {
                file_id: "fake-photo-small",
                file_unique_id: "fps",
                width: 90,
                height: 90,
                file_size: 1200,
              },
              {
                file_id: "fake-photo-large",
                file_unique_id: "fpl",
                width: 800,
                height: 800,
                file_size: 64000,
              },
            ],
            caption: body,
            ...(entities.length > 0 && { caption_entities: entities }),
          }
        : { text: body, ...(entities.length > 0 && { entities }) }),
    },
  };
}

/** An update with a callback query: `from` pressed an inline button with `data` on a bot message. */
export function telegramCallback(
  from: TgUser,
  message: { chatId: number; messageId: number; chatType?: string; messageThreadId?: number },
  data: string,
  o: { id?: string } = {},
): Record<string, unknown> {
  return {
    callback_query: {
      id: o.id ?? `cbq-${++seq}`,
      from: userOf(from),
      chat_instance: `ci${Math.abs(message.chatId)}`,
      data,
      message: {
        message_id: message.messageId,
        date: nowSec(),
        chat: {
          id: message.chatId,
          type: message.chatType ?? (message.chatId > 0 ? "private" : "supergroup"),
        },
        ...(message.messageThreadId !== undefined && {
          message_thread_id: message.messageThreadId,
        }),
      },
    },
  };
}

/** Finds an inline keyboard button in a `reply_markup` (object or JSON string). */
export function findTelegramButton(
  replyMarkup: unknown,
  pred: (b: { text: string; callback_data?: string; url?: string }) => boolean,
): { text: string; callback_data?: string; url?: string } | undefined {
  let markup = replyMarkup;
  if (typeof markup === "string") {
    try {
      markup = JSON.parse(markup);
    } catch {
      return undefined;
    }
  }
  const rows = (markup as { inline_keyboard?: unknown } | undefined)?.inline_keyboard;
  if (!Array.isArray(rows)) return undefined;
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    for (const b of row as { text: string; callback_data?: string; url?: string }[]) {
      if (pred(b)) return b;
    }
  }
  return undefined;
}

/** The headers Telegram sends to a webhook set with `secret_token`. */
export function telegramWebhookHeaders(secret: string): Record<string, string> {
  return { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret };
}
