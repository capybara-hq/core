import { Inject, Module, type OnModuleInit } from "@nestjs/common";
import { PermissionCallGrantsModule } from "../sandbox/permission-call-grants.module.js";
import {
  LOCAL_PROVIDER,
  type SandboxProviderEntry,
  SandboxProviders,
} from "../sandbox/providers.js";
import { SandboxProviderRegistryModule } from "../sandbox/providers.module.js";
import { SandboxModule } from "../sandbox/sandbox.module.js";
import { DevicePolicyService } from "./device-policy.service.js";
import { LocalInstanceBindings } from "./instance-bindings.js";
import { LocalDeviceProvider } from "./local-device-provider.js";
import { MachinesService } from "./machines.js";
import { NetworkGrants } from "./network-grants.js";
import { NetworkGrantsModule } from "./network-grants.module.js";
import { OwnerReports } from "./owner-reports.js";
import { LocalDeviceRelay, stagedDeviceProtocolActive } from "./relay.js";
import { DeviceTargets } from "./targets.js";

export { stagedDeviceProtocolActive } from "./relay.js";

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
    OwnerReports,
  ],
  exports: [
    NetworkGrantsModule,
    LocalDeviceRelay,
    LocalDeviceProvider,
    MachinesService,
    DevicePolicyService,
    LocalInstanceBindings,
    OwnerReports,
  ],
})
export class LocalDevicesModule implements OnModuleInit {
  constructor(
    @Inject(SandboxProviders) private readonly providers: SandboxProviders,
    @Inject(LocalDeviceProvider) private readonly provider: LocalDeviceProvider,
    @Inject(LocalDeviceRelay) private readonly relay: LocalDeviceRelay,
    @Inject(LocalInstanceBindings) private readonly bindings: LocalInstanceBindings,
  ) {}

  onModuleInit(): void {
    this.providers.register(
      localProviderEntry(stagedDeviceProtocolActive(), {
        provider: this.provider,
        relay: this.relay,
        bindings: this.bindings,
      }),
    );
  }
}

/**
 * The `@local` registration: protocol 2's provider as it is, or the staged (protocol 3) provider
 * ({@link LocalDeviceProvider.staged}: v3 operations, no broad kill) with its instance binder,
 * which binds every committed generation before shared use (B-8).
 */
export function localProviderEntry(
  staged: boolean,
  deps: { provider: LocalDeviceProvider; relay: LocalDeviceRelay; bindings: LocalInstanceBindings },
): SandboxProviderEntry {
  if (!staged) return { plugin: LOCAL_PROVIDER, impl: deps.provider };
  return {
    plugin: LOCAL_PROVIDER,
    impl: deps.provider.staged({
      call: deps.relay.callV3.bind(deps.relay),
      permissionSupport: (deviceId) => deps.bindings.permissionSupport(deviceId),
    }),
    binder: deps.bindings,
  };
}
