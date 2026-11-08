import { Inject, Module, type OnModuleInit } from "@nestjs/common";
import { DEVICE_PROVIDER, SandboxProviders } from "../sandbox/providers.js";
import { SandboxModule } from "../sandbox/sandbox.module.js";
import { DeviceSandboxProvider } from "./device-provider.js";
import { DeviceRelay } from "./relay.js";

/**
 * Connected machines (environments spec §6, §13): the caller side of the device relay and the
 * kernel-internal `@device` sandbox provider, registered with {@link SandboxProviders} on init.
 * Imported on every role: any replica may run a sandbox operation on a connected environment
 * (the socket itself is held by the gateway role).
 */
@Module({
  imports: [SandboxModule],
  providers: [DeviceRelay, DeviceSandboxProvider],
  exports: [DeviceRelay, DeviceSandboxProvider],
})
export class DevicesModule implements OnModuleInit {
  constructor(
    @Inject(SandboxProviders) private readonly providers: SandboxProviders,
    @Inject(DeviceSandboxProvider) private readonly device: DeviceSandboxProvider,
  ) {}

  onModuleInit(): void {
    this.providers.register({ plugin: DEVICE_PROVIDER, impl: this.device });
  }
}
