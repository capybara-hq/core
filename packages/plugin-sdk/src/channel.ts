import type { ZodTypeAny } from "zod";
import type { CardAction, Locale, OutboundMessage } from "./cards.js";

/**
 * The delivery target of a message. In a group chat `threadId` is the **`messageId` of the thread's
 * root message** (the kernel uses it to map one thread to one conversation,
 * and replies are delivered to this thread): for Slack it is the root message `messageId` as the
 * plugin defines it (e.g. `<channel>:<ts>`, where ts is the reply's
 * `thread_ts`); for Lark it is the root message's `message_id` (`root_id`, `om_…`), **not**
 * `thread_id` (`omt_…`). Absent in direct messages.
 */
export interface ChannelTarget {
  chatId: string;
  threadId?: string;
  chatType: "dm" | "group";
}

/**
 * The speaker / clicker of an inbound event. `tenantId` is the tenant (company) the speaker belongs
 * to: for Slack the team id (under Enterprise Grid it is the team,
 * not the Grid organization), for Lark `tenant_key`; a person whose tenant differs from the
 * connection's tenant (the `tenantId` returned by `verify`, same convention)
 * (an external contact, another company in a shared channel) can only be bound by the kernel, never
 * treated as an anonymous guest. `displayName` and `avatarUrl` are the display name and avatar
 * on the platform (include them when available): the kernel uses the display name on the binding
 * confirmation page (falling back to externalId when absent).
 */
export interface InboundSender {
  externalId: string;
  tenantId: string;
  displayName?: string;
  avatarUrl?: string;
  /**
   * The sender's time zone on the platform, an IANA name (`Asia/Shanghai`; Slack `users.info`
   * `user.tz`), when the platform gives one. Include it on `message` events when you can get it
   * within the acknowledgement deadline (cache it per user); leave it out otherwise. It wins over
   * the person's account setting and the org default for the run's date and zone (run context
   * spec §3.4); a name the kernel does not know is ignored.
   */
  timeZone?: string;
  /**
   * The sender's language on the platform: `zh` / `en` or a BCP 47 tag (`zh-CN`, `en-US`; Slack
   * `users.info` with `include_locale=true`, `user.locale`), when the platform gives one. The
   * kernel normalizes it (`zh` and `zh-*` are Chinese, any other tag English); it wins over the
   * person's latest web UI language and the org default (run context spec §3.4).
   */
  locale?: string;
}

/**
 * An inbound event a channel hands to the kernel. The plugin's conventions:
 * - `message.messageId` is unique within this connection (the kernel deduplicates by it);
 * - M4 handles text only: attachments, images, files and the like are ignored (a message with
 *   only attachments emits no event);
 * - user edits and message recalls / deletions emit no event (ignored);
 * - the part of `text` that @-mentions the bot is removed (`mentionsBot` states separately
 *   whether the bot was @-mentioned);
 * - `card_action`: `messageId` is the id of the message holding the card (the same for repeated
 *   clicks on one card); `eventId` is the platform's
 *   unique id for this click (include it when available; unique within this connection: the kernel
 * deduplicates platform redeliveries by it); in a group chat include `target.threadId` when
 * available,
 *   otherwise the kernel uses the thread recorded when it sent the card.
 */
export type InboundEvent =
  | {
      type: "message";
      messageId: string;
      target: ChannelTarget;
      sender: InboundSender;
      text: string;
      mentionsBot: boolean;
    }
  | {
      type: "card_action";
      target: ChannelTarget;
      messageId: string;
      /**
       * The platform's unique id for this click (e.g. the event_id of a Lark callback, or a
       * combination of Slack's trigger / action timestamps).
       */
      eventId?: string;
      sender: InboundSender;
      action: CardAction;
    }
  /** The platform pushes a personnel change hint; the kernel triggers a directory sync from it. */
  | { type: "directory_changed"; tenantId: string };

export interface ChannelConnectArgs {
  connectionId: string;
  /** Already validated against connectionSchema, secrets included. */
  config: unknown;
  /**
   * Hands an inbound event to the kernel. The kernel only deduplicates and durably enqueues the
   * event (fast; it does not process the message here); resolving means the kernel has
   * reliably received the event: the plugin acknowledges (acks) to the platform **only after it
   * resolves**; on reject **do not** acknowledge, so the platform redelivers;
   * the plugin need not retry `onEvent` itself. Deduplication scope: `message` by `messageId`, a
   * `card_action` with `eventId` by `eventId`
   * (each kept for 24 hours), so a redelivery is processed once; a `card_action` without `eventId`
   * is not deduplicated (processed every time; a repeated approval /
   * answer gets an "already handled" reply from the kernel); `directory_changed` is not
   * deduplicated (the sync task itself coalesces per minute).
   */
  onEvent(e: InboundEvent): Promise<void>;
  signal: AbortSignal;
}

export interface ChannelSendArgs {
  config: unknown;
  target: ChannelTarget;
  /**
   * The message content. When `text` exceeds the platform's per-message length limit the plugin
   * splits it into several messages sent in order and returns the id of the **last one**
   * (the kernel edits that one afterwards).
   */
  message: OutboundMessage;
  signal: AbortSignal;
  /**
   * The recipient's language (the sender's platform language, else their latest web language,
   * else the org's): the wording the extension renders itself (card buttons, fixed words in the
   * text fallback) follows it.
   */
  locale: Locale;
  /**
   * Idempotency key (optional): at most 40 characters from `[A-Za-z0-9_-]`, identical for every
   * retry of the same logical message (another replica continuing after a crash,
   * a resend after a retryable failure); the kernel derives it as a stable hash of "conversation +
   * event seq" or "card + state".
   * When the platform supports idempotent sends (e.g. Lark's `uuid`) the plugin should pass it
   * through unchanged or map it as the platform requires, to avoid duplicate messages; platforms
   * without support can ignore it.
   */
  idempotencyKey?: string;
}

/**
 * An inbound webhook request as the kernel received it on `POST /channels/webhook/<connectionId>`.
 * `headers` names are lowercase (repeated headers joined with `, `; cookies are dropped); `body` is
 * the raw request bytes, unparsed, so the plugin can verify signatures over them; `receivedAt` is the
 * kernel's receive time in epoch milliseconds (use it for timestamp replay checks).
 */
export interface ChannelWebhookRequest {
  method: "POST";
  headers: Readonly<Record<string, string>>;
  body: Uint8Array;
  receivedAt: number;
}

/** An HTTP response the kernel writes back to the platform as is. */
export interface ChannelWebhookResponse {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}

/**
 * What the plugin made of a webhook request:
 * - `respond`: reply directly without any event (URL verification challenge and the like);
 * - `events`: hand these events to the kernel, which dedupes and enqueues them like the long
 *   connection's `onEvent` and replies `ack` only after every one resolved; if any rejects, the
 *   kernel replies 503 so the platform redelivers (dedupe makes the redelivery safe);
 *   an empty list just replies `ack` (ignored events are still acknowledged);
 * - `reject`: the request is not genuine (bad signature, stale timestamp, malformed): reply this
 *   status and enqueue nothing.
 */
export type ChannelWebhookResult =
  | { kind: "respond"; response: ChannelWebhookResponse }
  | { kind: "events"; events: InboundEvent[]; ack: ChannelWebhookResponse }
  | { kind: "reject"; status: 400 | 401 | 403 };

/**
 * Optional webhook inbound mode (`Channel.webhook`). Signature verification, decryption and
 * timestamp replay protection all happen here: the kernel knows no platform formats, applies no
 * auth on the route, and only calls this for connections in webhook mode. `config` is the
 * connection config (validated against `connectionSchema`, secrets included).
 *
 * Timing: one request has a 10 second kernel deadline covering `handle` and handing its events to
 * the kernel. `signal` aborts at the deadline or when the platform hangs up; past the deadline the
 * kernel answers 503 whether or not `handle` stops (late work is not cancelled). Platforms' own ack
 * deadlines are a few seconds, so keep it quick.
 *
 * Responses the kernel writes without asking the plugin:
 * - 404 `channel.webhook_not_found`, the same body for an unknown connection, one not in webhook
 *   mode, a disabled one, or one whose plugin is off for its org;
 * - 503 `extension.unavailable` when the plugin is not loaded on the replica that got the request (a
 *   rolling upgrade; the platform retries and reaches one that has it) or the stored config no
 *   longer matches `connectionSchema`; only reachable with an existing webhook connection's id;
 * - 413 `payload_too_large` above `channels.webhookMaxBodyBytes` (default 1 MiB), and 415 for a
 *   malformed `Content-Type` header, both before `handle` is called (any well-formed content type,
 *   or none, reaches the plugin as raw bytes);
 * - after `handle`: 503 `channel.webhook_retry` when the deadline passes or any `onEvent` rejects,
 *   500 `internal` when `handle` throws or returns something else.
 * Every response carries `x-content-type-options: nosniff` and
 * `content-security-policy: default-src 'none'`, which the plugin cannot override; plugin-set
 * `set-cookie`, `content-length`, `transfer-encoding`, `connection` and `keep-alive` are dropped.
 */
export interface ChannelWebhook {
  handle(args: {
    connectionId: string;
    config: unknown;
    request: ChannelWebhookRequest;
    signal: AbortSignal;
  }): Promise<ChannelWebhookResult>;
}

/** A channel implementation (the bot uses the channel connection config). */
export interface Channel {
  /** Schema of the channel connection config; secret fields use secret(). */
  connectionSchema: ZodTypeAny;
  /**
   * `minEditIntervalMs`: the minimum interval the platform allows between two edits of the same
   * message; the kernel's streaming-draft update interval is
   * `max(1000, minEditIntervalMs)`.
   */
  features: { cards: boolean; edit: boolean; threads: boolean; minEditIntervalMs?: number };
  verify(args: {
    config: unknown;
    signal: AbortSignal;
  }): Promise<{ botUserId: string; botName: string; tenantId: string }>;
  /**
   * Long-connection loop: returns when `signal` aborts; reconnects by itself after a disconnect.
   */
  connect(args: ChannelConnectArgs): Promise<void>;
  /**
   * On failure throw {@link ChannelSendError} to say whether it can be retried; the kernel treats
   * other exceptions as retryable (a limited number of times).
   */
  send(args: ChannelSendArgs): Promise<{ messageId: string }>;
  /**
   * Never called for channels whose features.edit is false. Failure semantics are the same as send.
   * When the new text exceeds the platform's per-message limit and cannot be turned into one
   * message,
   * throw a non-retryable {@link ChannelSendError} (`reason: "too_large"`): the kernel then `send`s
   * the full text as a new message
   * (split by the plugin).
   */
  update(args: ChannelSendArgs & { messageId: string }): Promise<void>;
  /**
   * Optional webhook inbound (see {@link ChannelWebhook}). Only connections of plugins that
   * implement it can be switched from the default long connection to webhook mode; a connection in
   * webhook mode gets no `connect` call.
   */
  webhook?: ChannelWebhook;
}

/**
 * Reasons for a non-retryable failure (`ChannelSendError.reason`), which the kernel handles
 * accordingly:
 * - `auth`: credentials invalid / permission revoked -> record the connection's `last_error` and
 *   stop delivering for this conversation in this round;
 * - `target_gone`: the bot was removed from the group or the conversation does not exist -> stop
 *   delivering for this conversation in this round, not counted as a poison event;
 * - `rejected` (content rejected by the platform), `too_large` (still over the limit after
 *   splitting, e.g. a card that is too large) -> counted as failures of the same event; after 3 the
 *   event is skipped.
 * A failure without a reason is treated as `rejected`.
 */
export type ChannelSendFailure = "auth" | "target_gone" | "rejected" | "too_large";

/**
 * Classification of a channel send / update failure: when `retryable` is true (rate limit, platform
 * 5xx, network) the kernel retries after backoff,
 * `retryAfterMs` is the wait the platform suggests; when false it is handled by `reason` (see
 * {@link ChannelSendFailure}).
 * When editing a streaming draft fails non-retryably (except `auth` / `target_gone`), the kernel
 * sends the full text as a new message instead.
 * Do not put credentials in the message.
 */
export class ChannelSendError extends Error {
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly reason?: ChannelSendFailure;

  constructor(
    message: string,
    opts: {
      retryable: boolean;
      retryAfterMs?: number;
      reason?: ChannelSendFailure;
      cause?: unknown;
    },
  ) {
    super(message, "cause" in opts ? { cause: opts.cause } : undefined);
    this.name = "ChannelSendError";
    this.retryable = opts.retryable;
    if (opts.retryAfterMs !== undefined) this.retryAfterMs = opts.retryAfterMs;
    if (opts.reason !== undefined) this.reason = opts.reason;
  }
}

/**
 * Duck-typed check (no instanceof), compatible with a plugin bundling another copy of plugin-sdk.
 */
export function isChannelSendError(e: unknown): e is ChannelSendError {
  return (
    e instanceof Error &&
    e.name === "ChannelSendError" &&
    typeof (e as { retryable?: unknown }).retryable === "boolean"
  );
}
