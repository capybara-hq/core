import type { FastifyReply } from "fastify";

/**
 * An `AbortSignal` tied to one HTTP request: aborted when the connection closes before the
 * response is written (the client hung up), never by a close after a finished response. The same
 * rule as the plugin routes' `req.signal` and the channel webhooks. For a route whose handler asks
 * a device (or another remote) on the request's behalf, so the call stops when nobody waits.
 */
export function requestSignal(reply: FastifyReply): AbortSignal {
  const ac = new AbortController();
  reply.raw.once("close", () => {
    if (!reply.raw.writableFinished) ac.abort();
  });
  return ac.signal;
}
