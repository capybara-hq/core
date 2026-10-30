import { Module } from "@nestjs/common";
import { ChannelsModule } from "../channels/channels.module.js";
import { ChannelSupervisor } from "../channels/supervisor.js";
import { ChannelWebhooks } from "../channels/webhook.js";
import { ExtensionsModule } from "../extensions/extensions.module.js";
import { GatewayRole } from "./gateway-role.js";

/**
 * The gateway role (nest kernel spec §2), imported by `KernelModule` only when `roles` includes
 * `gateway`: the channel long-connection supervisor, the webhook inbound (served as a raw Fastify
 * route, `http/gateway-routes.ts`) and {@link GatewayRole}, which `KernelLifecycle` drives. It runs
 * no cron and no queue consumer (those are the worker role's).
 */
@Module({
  imports: [ChannelsModule, ExtensionsModule],
  providers: [ChannelSupervisor, ChannelWebhooks, GatewayRole],
  exports: [GatewayRole],
})
export class GatewayModule {}
