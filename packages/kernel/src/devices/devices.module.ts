import { Module } from "@nestjs/common";
import { ExtensionsModule } from "../extensions/extensions.module.js";
import { LocalDevicesModule } from "../local-devices/local-devices.module.js";
import { SandboxModule } from "../sandbox/sandbox.module.js";
import { DeviceAccess } from "./access.js";
import { ConversationDevices } from "./conversation-devices.js";
import { DevicesService } from "./devices.service.js";

/**
 * Devices (spec 2026-11-07-environments-design): a person's devices
 * ({@link DevicesService}), who may use one ({@link DeviceAccess}) and the one a
 * conversation works in ({@link ConversationDevices}). The instances and file systems are the
 * {@link SandboxModule}'s.
 */
@Module({
  // ExtensionsModule: the provider display names of demoted defaults; LocalDevicesModule: deleting
  // a local device revokes its machine
  imports: [SandboxModule, ExtensionsModule, LocalDevicesModule],
  providers: [DeviceAccess, DevicesService, ConversationDevices],
  exports: [DeviceAccess, DevicesService, ConversationDevices],
})
export class DevicesModule {}
