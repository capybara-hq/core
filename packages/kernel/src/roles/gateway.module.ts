import { Module } from "@nestjs/common";
import { ChannelsModule } from "../channels/channels.module.js";
import { ChannelSupervisor } from "../channels/supervisor.js";
import { ChannelWebhooks } from "../channels/webhook.js";
import { ExtensionDeviceAccessModule } from "../device-access/device-access.module.js";
import { DeviceStreamViewers } from "../device-access/viewer.js";
import { DialInModule } from "../dial-in/dial-in.module.js";
import { DialInGateway } from "../dial-in/gateway.js";
import { ExtensionsModule } from "../extensions/extensions.module.js";
import { SandboxModule } from "../sandbox/sandbox.module.js";
import { GatewayRole } from "./gateway-role.js";

/**
 * The gateway role (nest kernel spec §2), imported by `KernelModule` only when `roles` includes
 * `gateway`: the channel long-connection supervisor, the webhook inbound (served as a raw Fastify
 * route, `http/gateway-routes.ts`), the device connections ({@link DialInGateway}, `GET
 * /device/connect`), the device stream viewers ({@link DeviceStreamViewers}, `GET /device/stream`)
 * and {@link GatewayRole}, which `KernelLifecycle` drives. It runs
 * no cron and no queue consumer (those are the worker role's).
 */
@Module({
  imports: [
    ChannelsModule,
    ExtensionsModule,
    DialInModule,
    SandboxModule,
    ExtensionDeviceAccessModule,
  ],
  providers: [ChannelSupervisor, ChannelWebhooks, DialInGateway, DeviceStreamViewers, GatewayRole],
  exports: [GatewayRole],
})
export class GatewayModule {}
