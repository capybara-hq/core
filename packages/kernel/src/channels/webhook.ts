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

/**
 * Deadline of one webhook request: connection lookups, the plugin's `webhook.handle` and handing
 * its events to `onEvent` (platform ack deadlines are a few seconds). Past it the kernel answers 503.
 */
export const WEBHOOK_HANDLE_TIMEOUT_MS = 10_000;
/** How long a connection's decrypted runtime (plugin + config) is reused across requests. */
export const WEBHOOK_RUNTIME_CACHE_MS = 5_000;
/** Most connections whose runtime is cached in one process. */
export const WEBHOOK_RUNTIME_CACHE_MAX = 1_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Headers every webhook response carries; a plugin cannot override them (the body is never meant to
 * be rendered or sniffed by a browser).
 */
export const WEBHOOK_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'",
};

/** Response headers a plugin may not set (the HTTP server owns framing, cookies and the above). */
const DROPPED_HEADERS: ReadonlySet<string> = new Set([
  "connection",
  "content-length",
  "keep-alive",
  "set-cookie",
  "transfer-encoding",
  ...Object.keys(WEBHOOK_SECURITY_HEADERS),
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

const retryLater = () =>
  jsonError(503, "channel.webhook_retry", "The event could not be accepted; retry later");

/** Thrown by {@link raceAbort} when the request's deadline (or the platform hanging up) wins. */
class WebhookDeadline extends Error {}

/** Settles with `p`, or rejects with {@link WebhookDeadline} once `signal` aborts (whatever `p` does). */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    p.catch(() => {});
    return Promise.reject(new WebhookDeadline());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new WebhookDeadline());
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

type Runtime = Awaited<ReturnType<ChannelConnections["runtime"]>>;

export interface ChannelWebhooksDeps {
  connections: Pick<ChannelConnections, "row" | "runtime">;
  inbound: Pick<ChannelInbound, "onEvent">;
  log: Pick<Logger, "warn">;
  /** Defaults to {@link WEBHOOK_HANDLE_TIMEOUT_MS}. */
  handleTimeoutMs?: number;
  /** Defaults to {@link WEBHOOK_RUNTIME_CACHE_MS}; 0 disables the cache. */
  runtimeCacheMs?: number;
}

/**
 * Channel webhook inbound (F8 / F9), framework free. The gateway route
 * `POST /channels/webhook/:connectionId` hands every request here; the kernel applies no auth, so
 * everything a request can do goes through the plugin's `webhook.handle`, which verifies the
 * signature, decrypts and checks timestamps:
 * - unknown connection, not in webhook mode, not active or plugin off for the org → uniform 404
 *   `channel.webhook_not_found` (the connection row is read on every request);
 * - plugin not loaded on this replica, or stored config no longer valid → 503 `plugin.unavailable`.
 *   Deliberate tradeoff: during a rolling upgrade the platform retries and reaches a replica that
 *   has the plugin. It is only reachable with the UUID of an existing webhook-mode connection
 *   (the URL the platform already has), so it reveals nothing to a guesser;
 * - `respond` → written back (minus framing / cookie headers);
 * - `events` → each goes through the same `onEvent` as the long connection (dedupe by `messageId` /
 *   `eventId`, durable enqueue); the plugin's `ack` is written only after every one resolved, and
 *   any rejection answers 503 `channel.webhook_retry` so the platform redelivers;
 * - `reject` → that status (400 / 401 / 403), nothing enqueued;
 * - plugin throws or returns something else → 500 `internal`;
 * - the whole request (connection lookups, handle, onEvent) has one deadline ({@link WEBHOOK_HANDLE_TIMEOUT_MS}): a
 *   plugin that ignores its `signal` or an enqueue stuck on Redis answers 503 `channel.webhook_retry`
 *   when it passes (late work is not cancelled; dedupe makes the redelivery safe).
 * Every response carries {@link WEBHOOK_SECURITY_HEADERS}.
 *
 * The decrypted runtime (plugin implementation + config) is cached per connection for a few seconds
 * (bounded, process local), so unauthenticated requests stay cheap before the signature check. It is
 * a read-through cache only: the kernel calls {@link invalidate} on `channel.changed` (config rotation,
 * mode switch, deletion…) and {@link invalidateAll} when a plugin instance changes; a generation
 * counter keeps a fetch that started before `invalidateAll` from storing the old plugin instance.
 */
export class ChannelWebhooks {
  private readonly runtimes = new Map<string, { value: Runtime; expiresAt: number }>();
  /** Bumped by {@link invalidateAll}: a fetch started before the bump is not stored. */
  private generation = 0;

  constructor(private readonly deps: ChannelWebhooksDeps) {}

  /** Drops the cached runtime of one connection (on `channel.changed`). */
  invalidate(connectionId: string): void {
    this.runtimes.delete(connectionId);
  }

  /** Drops every cached runtime (a plugin was replaced, revoked or reloaded). */
  invalidateAll(): void {
    this.generation++;
    this.runtimes.clear();
  }

  async handle(
    connectionId: string,
    request: ChannelWebhookRequest,
    signal: AbortSignal,
  ): Promise<ChannelWebhookResponse> {
    return secure(await this.respond(connectionId, request, signal));
  }

  private async runtime(connectionId: string, deadline: AbortSignal): Promise<Runtime> {
    const ttl = this.deps.runtimeCacheMs ?? WEBHOOK_RUNTIME_CACHE_MS;
    const now = Date.now();
    const hit = this.runtimes.get(connectionId);
    if (hit && hit.expiresAt > now) return hit.value;
    const generation = this.generation;
    const value = await raceAbort(this.deps.connections.runtime(connectionId), deadline);
    // A plugin instance changed while fetching: use the value once, keep no stale instance
    if (ttl > 0 && generation === this.generation) {
      this.runtimes.delete(connectionId);
      while (this.runtimes.size >= WEBHOOK_RUNTIME_CACHE_MAX) {
        const oldest = this.runtimes.keys().next().value;
        if (oldest === undefined) break;
        this.runtimes.delete(oldest);
      }
      this.runtimes.set(connectionId, { value, expiresAt: now + ttl });
    }
    return value;
  }

  private async respond(
    connectionId: string,
    request: ChannelWebhookRequest,
    signal: AbortSignal,
  ): Promise<ChannelWebhookResponse> {
    if (!UUID_RE.test(connectionId)) return notFound();
    // One deadline for the whole request (DB lookups, handle, onEvent); also aborts when the
    // platform hangs up
    const deadline = AbortSignal.any([
      signal,
      AbortSignal.timeout(this.deps.handleTimeoutMs ?? WEBHOOK_HANDLE_TIMEOUT_MS),
    ]);
    try {
      return await this.respondBefore(connectionId, request, deadline);
    } catch (err) {
      if (!(err instanceof WebhookDeadline)) throw err;
      this.deps.log.warn("channel webhook timed out; the platform will retry", { connectionId });
      return retryLater();
    }
  }

  private async respondBefore(
    connectionId: string,
    request: ChannelWebhookRequest,
    deadline: AbortSignal,
  ): Promise<ChannelWebhookResponse> {
    const row = await raceAbort(this.deps.connections.row(connectionId), deadline);
    if (
      row === undefined ||
      row.inboundMode !== "webhook" ||
      row.status !== "active" ||
      !row.pluginEnabled
    ) {
      this.invalidate(connectionId);
      return notFound();
    }
    let runtime: Runtime;
    try {
      runtime = await this.runtime(connectionId, deadline);
    } catch (err) {
      if (err instanceof WebhookDeadline) throw err;
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
      result = await raceAbort(
        Promise.resolve().then(() =>
          webhook.handle({ connectionId, config: runtime.config, request, signal: deadline }),
        ),
        deadline,
      );
    } catch (err) {
      if (err instanceof WebhookDeadline) {
        this.deps.log.warn("channel webhook handler timed out; the platform will retry", {
          connectionId,
        });
        return retryLater();
      }
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
            await raceAbort(this.deps.inbound.onEvent(connectionId, e), deadline);
          } catch (err) {
            this.deps.log.warn("channel webhook event not accepted; the platform will retry", {
              connectionId,
              ...(err instanceof WebhookDeadline ? { timedOut: true } : { err }),
            });
            return retryLater();
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

/** Adds {@link WEBHOOK_SECURITY_HEADERS}, replacing any same-named header whatever its case. */
function secure(r: ChannelWebhookResponse): ChannelWebhookResponse {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(r.headers ?? {})) {
    if (!(name.toLowerCase() in WEBHOOK_SECURITY_HEADERS)) headers[name] = value;
  }
  return { ...r, headers: { ...headers, ...WEBHOOK_SECURITY_HEADERS } };
}
