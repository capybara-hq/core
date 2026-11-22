import { Module } from "@nestjs/common";
import { ExtensionRegistryModule } from "../extensions/registry.js";
import { DeviceProviders } from "./providers.js";
@Module({
  imports: [ExtensionRegistryModule],
  providers: [DeviceProviders],
  exports: [DeviceProviders],
})
export class SandboxProviderRegistryModule {}
