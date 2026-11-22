import { Inject, Module, type OnModuleInit } from "@nestjs/common";
import { DialInModule } from "../dial-in/dial-in.module.js";
import { DialInRelay } from "../dial-in/relay.js";
import { NetworkGrantsModule } from "../sandbox/network-grants.module.js";
import { PermissionCallGrantsModule } from "../sandbox/permission-call-grants.module.js";
import { type DeviceProviderEntry, DeviceProviders, LOCAL_PROVIDER } from "../sandbox/providers.js";
import { SandboxProviderRegistryModule } from "../sandbox/providers.module.js";
import { SandboxModule } from "../sandbox/sandbox.module.js";
import { KERNEL_VERSION } from "../version.js";
import { LocalInstanceBindings } from "./instance-bindings.js";
import { localCall } from "./local-codec.js";
import { LocalDeviceProvider } from "./local-device-provider.js";
import { LocalDialIn } from "./local-dial-in.js";
import { LocalMachineReports } from "./local-machine-reports.js";
import { OwnerReports } from "./owner-reports.js";

/**
 * Connected machines (environments spec §6, §13): the kernel-internal `@local` provider,
 * registered with {@link DeviceProviders} on init with its dial-in handler ({@link LocalDialIn},
 * interim until the `device-local` plugin), what its machines report ({@link LocalMachineReports},
 * {@link OwnerReports}) and the run grants sent with each exec ({@link NetworkGrantsModule}). Imported on every role: any
 * replica may run a sandbox operation on a local device (the socket itself is held by the gateway
 * role).
 */
@Module({
  imports: [
    DialInModule,
    PermissionCallGrantsModule,
    SandboxModule,
    SandboxProviderRegistryModule,
    NetworkGrantsModule,
  ],
  providers: [
    LocalDeviceProvider,
    LocalInstanceBindings,
    OwnerReports,
    LocalMachineReports,
    LocalDialIn,
  ],
  exports: [
    DialInModule,
    NetworkGrantsModule,
    LocalDeviceProvider,
    LocalInstanceBindings,
    OwnerReports,
    LocalMachineReports,
  ],
})
export class LocalDevicesModule implements OnModuleInit {
  constructor(
    @Inject(DeviceProviders) private readonly providers: DeviceProviders,
    @Inject(LocalDeviceProvider) private readonly provider: LocalDeviceProvider,
    @Inject(DialInRelay) private readonly relay: DialInRelay,
    @Inject(LocalInstanceBindings) private readonly bindings: LocalInstanceBindings,
    @Inject(LocalDialIn) private readonly dialIn: LocalDialIn,
  ) {}

  onModuleInit(): void {
    this.providers.register(
      localProviderEntry({
        provider: this.provider,
        relay: this.relay,
        bindings: this.bindings,
        dialIn: this.dialIn,
      }),
    );
  }
}

/**
 * The `@local` registration: the protocol 5 provider ({@link LocalDeviceProvider.staged}: scoped
 * operations, no broad kill) over the dial-in relay ({@link localCall}), its dial-in handler, and
 * its instance binder, which binds every committed generation before shared use (B-8).
 */
export function localProviderEntry(deps: {
  provider: LocalDeviceProvider;
  relay: Pick<DialInRelay, "request">;
  bindings: LocalInstanceBindings;
  dialIn?: LocalDialIn;
}): DeviceProviderEntry {
  const impl = deps.provider.staged({
    call: localCall(deps.relay),
    permissionSupport: (deviceId) => deps.bindings.permissionSupport(deviceId),
  });
  return {
    plugin: LOCAL_PROVIDER,
    version: KERNEL_VERSION,
    impl: deps.dialIn ? Object.assign(impl, { dialIn: deps.dialIn }) : impl,
    binder: deps.bindings,
  };
}
