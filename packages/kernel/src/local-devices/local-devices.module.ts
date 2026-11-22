import { Inject, Module, type OnModuleInit } from "@nestjs/common";
import { DialInModule } from "../dial-in/dial-in.module.js";
import { DialInRelay } from "../dial-in/relay.js";
import { NetworkGrantsModule } from "../sandbox/network-grants.module.js";
import { PermissionCallGrantsModule } from "../sandbox/permission-call-grants.module.js";
import { type DeviceProviderEntry, DeviceProviders, LOCAL_PROVIDER } from "../sandbox/providers.js";
import { SandboxProviderRegistryModule } from "../sandbox/providers.module.js";
import { SandboxModule } from "../sandbox/sandbox.module.js";
import { KERNEL_VERSION } from "../version.js";
import { DevicePolicyService } from "./device-policy.service.js";
import { LocalInstanceBindings } from "./instance-bindings.js";
import { LocalDeviceProvider } from "./local-device-provider.js";

/**
 * Connected machines (environments spec §6, §13): the caller side of the device relay and the
 * kernel-internal `@local` sandbox provider, registered with {@link DeviceProviders} on init, and
 * the machines and their credentials ({@link DialInMachines}), changes to a device's network
 * policy ({@link DevicePolicyService}) and the run grants sent with each exec ({@link NetworkGrantsModule}).
 * Imported on every role: any replica may run a sandbox operation on a local device
 * (the socket itself is held by the gateway role).
 */
@Module({
  imports: [
    DialInModule,
    PermissionCallGrantsModule,
    SandboxModule,
    SandboxProviderRegistryModule,
    NetworkGrantsModule,
  ],
  providers: [LocalDeviceProvider, DevicePolicyService, LocalInstanceBindings],
  exports: [
    DialInModule,
    NetworkGrantsModule,
    LocalDeviceProvider,
    DevicePolicyService,
    LocalInstanceBindings,
  ],
})
export class LocalDevicesModule implements OnModuleInit {
  constructor(
    @Inject(DeviceProviders) private readonly providers: DeviceProviders,
    @Inject(LocalDeviceProvider) private readonly provider: LocalDeviceProvider,
    @Inject(DialInRelay) private readonly relay: DialInRelay,
    @Inject(LocalInstanceBindings) private readonly bindings: LocalInstanceBindings,
  ) {}

  onModuleInit(): void {
    this.providers.register(
      localProviderEntry({
        provider: this.provider,
        relay: this.relay,
        bindings: this.bindings,
      }),
    );
  }
}

/**
 * The `@local` registration: the protocol 4 provider ({@link LocalDeviceProvider.staged}: scoped
 * operations, no broad kill) with its instance binder, which binds every committed generation
 * before shared use (B-8).
 */
export function localProviderEntry(deps: {
  provider: LocalDeviceProvider;
  relay: DialInRelay;
  bindings: LocalInstanceBindings;
}): DeviceProviderEntry {
  return {
    plugin: LOCAL_PROVIDER,
    version: KERNEL_VERSION,
    impl: deps.provider.staged({
      call: deps.relay.callV3.bind(deps.relay),
      permissionSupport: (deviceId) => deps.bindings.permissionSupport(deviceId),
    }),
    binder: deps.bindings,
  };
}
