import type { Logger } from "@capybara-hq/plugin-sdk";
import type { FastifyInstance } from "fastify";
import { registerChannelWebhookRoute } from "../channels/webhook.controller.js";
import type { ChannelWebhooks } from "../channels/webhook.js";

/** What the gateway role serves over HTTP besides health and plugin routes. */
export interface GatewayRoutes {
  webhooks: Pick<ChannelWebhooks, "handle">;
  /** `channels.webhookMaxBodyBytes`. */
  webhookMaxBodyBytes: number;
}

/**
 * Registers the gateway role's HTTP routes (`serveGateway = roles.includes("gateway")`): today the
 * channel webhook. These are raw Fastify routes, not a Nest module, so the API's global guard and
 * CSRF check do not apply (P-4); each route does its own (plugin-side) verification.
 */
export async function registerGatewayRoutes(
  fastify: FastifyInstance,
  routes: GatewayRoutes,
  log: Pick<Logger, "error">,
): Promise<void> {
  await registerChannelWebhookRoute(fastify, {
    webhooks: routes.webhooks,
    maxBodyBytes: routes.webhookMaxBodyBytes,
    log,
  });
}
