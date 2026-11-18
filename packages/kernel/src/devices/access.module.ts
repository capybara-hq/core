import { Module } from "@nestjs/common";
import { SandboxProviderRegistryModule } from "../sandbox/providers.module.js";
import { DeviceAccess } from "./access.js";
@Module({
  imports: [SandboxProviderRegistryModule],
  providers: [DeviceAccess],
  exports: [DeviceAccess],
})
export class DeviceAccessModule {}
