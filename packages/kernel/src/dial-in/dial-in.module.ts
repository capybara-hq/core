import { Module } from "@nestjs/common";
import { DeviceProviderSelectionModule } from "../devices/device-provider-selection.module.js";
import { ExtensionRegistryModule } from "../extensions/registry.js";
import { NetworkGrantsModule } from "../sandbox/network-grants.module.js";
import { PermissionCallGrantsModule } from "../sandbox/permission-call-grants.module.js";
import { SandboxProviderRegistryModule } from "../sandbox/providers.module.js";
import { SandboxModule } from "../sandbox/sandbox.module.js";
import { DialInHandlers } from "./handlers.js";
import { DialInMachines } from "./machines.js";
import { DialInRelayModule } from "./relay.module.js";

/**
 * The dial-in side of connected machines (environments spec §6, §13): the caller side of the
 * relay ({@link DialInRelayModule}), the machines and their credentials ({@link DialInMachines})
 * and the providers' dial-in handlers ({@link DialInHandlers}). Imported on every role: any
 * replica may run an operation on a device (the socket itself is held by the gateway role,
 * `DialInGateway`).
 */
@Module({
  imports: [
    DialInRelayModule,
    DeviceProviderSelectionModule,
    ExtensionRegistryModule,
    PermissionCallGrantsModule,
    SandboxModule,
    SandboxProviderRegistryModule,
    NetworkGrantsModule,
  ],
  providers: [DialInMachines, DialInHandlers],
  exports: [DialInRelayModule, DialInMachines, DialInHandlers],
})
export class DialInModule {}
