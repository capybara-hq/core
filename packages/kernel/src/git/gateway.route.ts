import type { Logger } from "@capybara-hq/plugin-sdk";
import type { FastifyError, FastifyInstance } from "fastify";
import { redactPath } from "../http/error.filter.js";
import type { GitGateway } from "./gateway.js";

/** The Fastify route template of the git gateway (`GIT_GATEWAY_PREFIX` + `*`). */
export const GIT_GATEWAY_ROUTE = "/git/v1/*";

/** The request content types of git smart-HTTP POSTs. */
const GIT_REQUEST_TYPES = [
  "application/x-git-upload-pack-request",
  "application/x-git-receive-pack-request",
];

/**
 * Registers the git gateway (`GET` / `POST /git/v1/*`, sandbox git credentials spec §5) as a raw
 * Fastify route in its own encapsulated scope, like the channel webhook (P-4): outside Nest, so
 * neither the global `AuthGuard` nor the CSRF check applies (git sends neither; the run ticket is
 * checked by {@link GitGateway}). It is not an API route and not a Platform operation (git
 * smart-HTTP for sandboxes, authenticated by run tickets). Inside this scope only, the two git
 * request types are handed to the handler as the raw stream (no buffering, no body limit: the
 * gateway counts bytes against `tools.git.maxBytesPerRun`); any other type is refused by Fastify.
 * HEAD and every other method answer 404. Registered by the api role; call before `app.init()`.
 */
export async function registerGitGatewayRoute(
  fastify: FastifyInstance,
  gateway: Pick<GitGateway, "handle">,
  log: Pick<Logger, "error">,
): Promise<void> {
  await fastify.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser(GIT_REQUEST_TYPES, (_req, payload, done) => done(null, payload));
    scope.setErrorHandler((err: FastifyError, req, reply) => {
      const status = typeof err.statusCode === "number" ? err.statusCode : 500;
      if (status >= 500)
        log.error("git gateway request failed", { path: redactPath(req.url), err });
      return reply
        .code(status >= 400 && status < 500 ? 404 : 500)
        .header("content-type", "text/plain; charset=utf-8")
        .send(
          status >= 400 && status < 500
            ? "Capybara: not a git smart-HTTP endpoint.\n"
            : "Capybara: internal error.\n",
        );
    });
    scope.route({
      method: ["GET", "POST"],
      url: GIT_GATEWAY_ROUTE,
      exposeHeadRoute: false,
      handler: (req, reply) => gateway.handle(req, reply),
    });
  });
}
