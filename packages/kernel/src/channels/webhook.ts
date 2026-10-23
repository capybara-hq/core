import type {
  ChannelWebhookRequest,
  ChannelWebhookResponse,
  ChannelWebhookResult,
  InboundEvent,
  Logger,
} from "@capybara-hq/plugin-sdk";
import { ApiError, type ErrorCode, errorBody } from "../errors.js";
import type { ChannelConnections } from "./connections.service.js";
import type { ChannelInbound } from "./inbound.js";

/** How long the plugin's `webhook.handle` may take (platform ack deadlines are a few seconds). */
export const WEBHOOK_HANDLE_TIMEOUT_MS = 10_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Response headers a plugin may not set (the HTTP server owns framing and cookies). */
const DROPPED_HEADERS: ReadonlySet<string> = new Set([
  "connection",
  "content-length",
  "keep-alive",
  "set-cookie",
  "transfer-encoding",
]);

const jsonError = (status: number, code: ErrorCode, message: string): ChannelWebhookResponse => ({
  status,
  headers: { "content-type": "application/json; charset=utf-8" },
  body: JSON.stringify(errorBody(code, message)),
});

/**
 * The one answer for an unknown connection, a connection not in webhook mode, a disabled one, or
 * one whose plugin is off for its org: the response never reveals whether the connection exists.
 */
const notFound = () =>
  jsonError(404, "channel.webhook_not_found", "No webhook is registered at this address");

export interface ChannelWebhooksDeps {
  connections: Pick<ChannelConnections, "row" | "runtime">;
  inbound: Pick<ChannelInbound, "onEvent">;
  log: Pick<Logger, "warn">;
  /** Defaults to {@link WEBHOOK_HANDLE_TIMEOUT_MS}. */
  handleTimeoutMs?: number;
}

/**
 * Channel webhook inbound (F8 / F9), framework free. The gateway route
 * `POST /channels/webhook/:connectionId` hands every request here; the kernel applies no auth, so
 * everything a request can do goes through the plugin's `webhook.handle`, which verifies the
 * signature, decrypts and checks timestamps:
 * - unknown connection, not in webhook mode, not active or plugin off for the org → uniform 404
 *   `channel.webhook_not_found`; plugin not loaded here or stored config no longer valid → 503 so
 *   the platform retries (another replica may have it);
 * - `respond` → written back as is (minus framing / cookie headers);
 * - `events` → each goes through the same `onEvent` as the long connection (dedupe by `messageId` /
 *   `eventId`, durable enqueue); the plugin's `ack` is written only after every one resolved, and
 *   any rejection answers 503 `channel.webhook_retry` so the platform redelivers;
 * - `reject` → that status, nothing enqueued; a plugin error → 500.
 */
export class ChannelWebhooks {
  constructor(private readonly deps: ChannelWebhooksDeps) {}

  async handle(
    connectionId: string,
    request: ChannelWebhookRequest,
    signal: AbortSignal,
  ): Promise<ChannelWebhookResponse> {
    if (!UUID_RE.test(connectionId)) return notFound();
    const row = await this.deps.connections.row(connectionId);
    if (
      row === undefined ||
      row.inboundMode !== "webhook" ||
      row.status !== "active" ||
      !row.pluginEnabled
    ) {
      return notFound();
    }
    let runtime: Awaited<ReturnType<ChannelConnections["runtime"]>>;
    try {
      runtime = await this.deps.connections.runtime(connectionId);
    } catch (err) {
      if (
        err instanceof ApiError &&
        (err.code === "channel.not_found" || err.code === "plugin.not_enabled")
      ) {
        return notFound();
      }
      this.deps.log.warn("channel webhook cannot load its connection", {
        connectionId,
        code: err instanceof ApiError ? err.code : undefined,
      });
      return jsonError(503, "plugin.unavailable", "The channel is not available right now");
    }
    const webhook = runtime.channel.webhook;
    if (webhook === undefined) return notFound();

    let result: ChannelWebhookResult;
    try {
      result = await webhook.handle({
        connectionId,
        config: runtime.config,
        request,
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(this.deps.handleTimeoutMs ?? WEBHOOK_HANDLE_TIMEOUT_MS),
        ]),
      });
    } catch (err) {
      // The kernel log redacts the connection's secrets (runtime() registered them)
      this.deps.log.warn("channel webhook handler failed", { connectionId, err });
      return jsonError(500, "internal", "Internal error");
    }

    switch (result?.kind) {
      case "respond":
        return sanitize(result.response);
      case "reject":
        return rejected(result.status);
      case "events": {
        const events: unknown = result.events;
        if (!Array.isArray(events)) break;
        for (const e of events as InboundEvent[]) {
          try {
            await this.deps.inbound.onEvent(connectionId, e);
          } catch (err) {
            this.deps.log.warn("channel webhook event not accepted; the platform will retry", {
              connectionId,
              err,
            });
            return jsonError(
              503,
              "channel.webhook_retry",
              "The event could not be accepted; retry later",
            );
          }
        }
        return sanitize(result.ack);
      }
    }
    this.deps.log.warn("channel webhook handler returned an invalid result", { connectionId });
    return jsonError(500, "internal", "Internal error");
  }
}

/** Generic codes for the statuses a plugin may reject with (same as the HTTP error filter's). */
const REJECT_CODES = { 400: "validation_failed", 401: "auth.required", 403: "forbidden" } as const;

function rejected(status: number): ChannelWebhookResponse {
  const s = status === 401 || status === 403 ? status : 400;
  return jsonError(s, REJECT_CODES[s], "Webhook request rejected");
}

/** The plugin's response with a valid status and only string headers it may set. */
function sanitize(r: ChannelWebhookResponse | undefined): ChannelWebhookResponse {
  const status =
    r !== undefined && Number.isInteger(r.status) && r.status >= 200 && r.status <= 599
      ? r.status
      : 500;
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(r?.headers ?? {})) {
    if (typeof value === "string" && !DROPPED_HEADERS.has(name.toLowerCase())) {
      headers[name] = value;
    }
  }
  return {
    status,
    headers,
    ...(typeof r?.body === "string" && { body: r.body }),
  };
}
