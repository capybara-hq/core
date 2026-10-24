import type { ChannelWebhookResponse, Logger } from "@capybara-hq/plugin-sdk";
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { errorBody } from "../errors.js";
import { codeForStatus, redactPath } from "../http/error.filter.js";
import { type ChannelWebhooks, WEBHOOK_SECURITY_HEADERS } from "./webhook.js";
import { CHANNEL_WEBHOOK_PREFIX } from "./webhook-url.js";

/** Fastify route template of the channel webhook (F9). */
export const CHANNEL_WEBHOOK_ROUTE = `${CHANNEL_WEBHOOK_PREFIX}:connectionId`;

export interface ChannelWebhookRouteOptions {
  webhooks: Pick<ChannelWebhooks, "handle">;
  /** `channels.webhookMaxBodyBytes`: a larger body is answered 413 before the handler runs. */
  maxBodyBytes: number;
  log: Pick<Logger, "error">;
}

/** Request headers as the plugin sees them: lowercase names, repeats joined, no cookies. */
function headersOf(req: FastifyRequest): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || name === "cookie") continue;
    out[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

/**
 * Registers `POST /channels/webhook/:connectionId` as a raw Fastify route in its own encapsulated
 * scope (P-4), like `/plugins/*`: outside Nest, so neither the global `AuthGuard` nor the CSRF
 * check applies (platforms send neither; the plugin verifies signatures). Inside this scope only,
 * every content type is read as a raw Buffer (the global JSON parser is untouched), limited to
 * `maxBodyBytes`. Must be called before Nest `app.init()`.
 */
export async function registerChannelWebhookRoute(
  fastify: FastifyInstance,
  opts: ChannelWebhookRouteOptions,
): Promise<void> {
  const handler = async (req: FastifyRequest, reply: FastifyReply) => {
    const { connectionId } = req.params as { connectionId: string };
    // Aborts only when the platform hangs up before the response is written
    const ac = new AbortController();
    reply.raw.once("close", () => {
      if (!reply.raw.writableFinished) ac.abort();
    });
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    let res: ChannelWebhookResponse;
    try {
      res = await opts.webhooks.handle(
        connectionId,
        {
          method: "POST",
          headers: headersOf(req),
          body: new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
          receivedAt: Date.now(),
        },
        ac.signal,
      );
    } catch (err) {
      opts.log.error("channel webhook failed", { path: redactPath(req.url), err });
      return reply.code(500).send(errorBody("internal", "Internal error"));
    }
    reply.code(res.status);
    for (const [name, value] of Object.entries(res.headers ?? {})) reply.header(name, value);
    return reply.send(res.body ?? "");
  };

  await fastify.register(async (scope) => {
    // Every response of the route, including Fastify's own 413 / 415 / 500
    scope.addHook("onSend", async (_req, reply, payload) => {
      for (const [name, value] of Object.entries(WEBHOOK_SECURITY_HEADERS)) {
        reply.header(name, value);
      }
      return payload;
    });
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
    scope.setErrorHandler((err: FastifyError, req, reply) => {
      const status = typeof err.statusCode === "number" ? err.statusCode : 500;
      if (status >= 400 && status < 500) {
        return reply.code(status).send(errorBody(codeForStatus(status), err.message));
      }
      opts.log.error("channel webhook request failed", { path: redactPath(req.url), err });
      return reply.code(500).send(errorBody("internal", "Internal error"));
    });
    scope.post(CHANNEL_WEBHOOK_ROUTE, { bodyLimit: opts.maxBodyBytes }, handler);
  });
}
