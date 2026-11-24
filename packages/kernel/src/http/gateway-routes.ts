import type { Logger } from "@capybara-hq/plugin-sdk";
import type { FastifyInstance } from "fastify";
import { registerChannelWebhookRoute } from "../channels/webhook.controller.js";
import type { ChannelWebhooks } from "../channels/webhook.js";
import { type DeviceRoutesOptions, registerDeviceConnectRoute } from "../dial-in/routes.js";

/** What the gateway role serves over HTTP besides health and plugin routes. */
export interface GatewayRoutes {
  webhooks: Pick<ChannelWebhooks, "handle">;
  /** `channels.webhookMaxBodyBytes`. */
  webhookMaxBodyBytes: number;
  /**
   * The device connection route (`GET /device/connect`, environments spec §13.4) and the device
   * stream viewer routes (`GET /device/stream`, the replica hop; browser use spec §6.2).
   */
  devices: DeviceRoutesOptions;
}

/**
 * Registers the gateway role's HTTP routes (`serveGateway = roles.includes("gateway")`): the
 * channel webhook, the device connection WebSocket and the device stream viewer WebSockets. These
 * are raw Fastify routes, not a Nest module, so the API's global guard and CSRF check do not apply
 * (P-4); each route does its own verification (the channel plugin's signature check, the machine
 * credential, the viewer ticket, the hop MAC).
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
  await registerDeviceConnectRoute(fastify, routes.devices);
}
