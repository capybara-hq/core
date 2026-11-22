import { Module } from "@nestjs/common";
import { OwnerReports } from "../local-devices/owner-reports.js";
import { NetworkGrantsModule } from "../sandbox/network-grants.module.js";
import { PermissionCallGrantsModule } from "../sandbox/permission-call-grants.module.js";
import { SandboxProviderRegistryModule } from "../sandbox/providers.module.js";
import { SandboxModule } from "../sandbox/sandbox.module.js";
import { DialInMachines } from "./machines.js";
import { DialInRelay } from "./relay.js";
import { DeviceTargets } from "./targets.js";

/**
 * The dial-in side of connected machines (environments spec §6, §13): the caller side of the
 * device relay ({@link DialInRelay}), the machines and their credentials ({@link DialInMachines})
 * and the device targets they resolve. Imported on every role: any replica may run an operation on
 * a device (the socket itself is held by the gateway role, {@link DialInGateway}).
 */
@Module({
  imports: [
    PermissionCallGrantsModule,
    SandboxModule,
    SandboxProviderRegistryModule,
    NetworkGrantsModule,
  ],
  providers: [DeviceTargets, DialInRelay, DialInMachines, OwnerReports],
  exports: [DeviceTargets, DialInRelay, DialInMachines, OwnerReports],
})
export class DialInModule {}
