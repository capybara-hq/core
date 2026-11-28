import { Module } from "@nestjs/common";
import { DevicesModule } from "../devices/devices.module.js";
import { ExtensionRegistryModule } from "../extensions/registry.js";
import { SandboxProviderRegistryModule } from "../sandbox/providers.module.js";
import { SandboxModule } from "../sandbox/sandbox.module.js";
import { ToolsModule } from "../tools/tools.module.js";
import { DeviceAccessService } from "./device-access.service.js";
import { DEVICE_ACCESS_BACKEND } from "./token.js";

/**
 * `ctx.deviceAccess` (browser use spec §7): {@link DeviceAccessService}. The extension host finds
 * it at the time of use (`ModuleRef`, {@link DEVICE_ACCESS_BACKEND}), since this module sits
 * above the host (sandbox, devices and tools all import the extensions module).
 */
@Module({
  // SandboxModule: device services and the command review; DevicesModule: the conversation's
  // device, who may use it and its allowlist write; ToolsModule: the questions;
  // ExtensionRegistryModule: an extension's approved manifest when a viewer opens
  imports: [
    SandboxModule,
    SandboxProviderRegistryModule,
    DevicesModule,
    ToolsModule,
    ExtensionRegistryModule,
  ],
  providers: [
    DeviceAccessService,
    { provide: DEVICE_ACCESS_BACKEND, useExisting: DeviceAccessService },
  ],
  exports: [DeviceAccessService, DEVICE_ACCESS_BACKEND],
})
export class ExtensionDeviceAccessModule {}
