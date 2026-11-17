import { Inject, Module, type OnModuleInit } from "@nestjs/common";
import { PermissionCallGrantsModule } from "../sandbox/permission-call-grants.module.js";
import { LOCAL_PROVIDER, SandboxProviders } from "../sandbox/providers.js";
import { SandboxProviderRegistryModule } from "../sandbox/providers.module.js";
import { SandboxModule } from "../sandbox/sandbox.module.js";
import { DevicePolicyService } from "./device-policy.service.js";
import { LocalInstanceBindings } from "./instance-bindings.js";
import { LocalDeviceProvider } from "./local-device-provider.js";
import { MachinesService } from "./machines.js";
import { NetworkGrants } from "./network-grants.js";
import { NetworkGrantsModule } from "./network-grants.module.js";
import { LocalDeviceRelay } from "./relay.js";
import { DeviceTargets } from "./targets.js";

/**
 * Connected machines (environments spec §6, §13): the caller side of the device relay and the
 * kernel-internal `@local` sandbox provider, registered with {@link SandboxProviders} on init, and
 * the machines and their credentials ({@link MachinesService}), changes to a device's network
 * policy ({@link DevicePolicyService}) and the run grants sent with each exec ({@link NetworkGrants}).
 * Imported on every role: any replica may run a sandbox operation on a local device
 * (the socket itself is held by the gateway role).
 */
@Module({
  imports: [
    PermissionCallGrantsModule,
    SandboxModule,
    SandboxProviderRegistryModule,
    NetworkGrantsModule,
  ],
  providers: [
    DeviceTargets,
    LocalDeviceRelay,
    LocalDeviceProvider,
    MachinesService,
    DevicePolicyService,
    LocalInstanceBindings,
  ],
  exports: [
    NetworkGrantsModule,
    LocalDeviceRelay,
    LocalDeviceProvider,
    MachinesService,
    DevicePolicyService,
    LocalInstanceBindings,
  ],
})
export class LocalDevicesModule implements OnModuleInit {
  constructor(
    @Inject(SandboxProviders) private readonly providers: SandboxProviders,
    @Inject(LocalDeviceProvider) private readonly provider: LocalDeviceProvider,
  ) {}

  onModuleInit(): void {
    this.providers.register({ plugin: LOCAL_PROVIDER, impl: this.provider });
  }
}
