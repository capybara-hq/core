import { Module } from "@nestjs/common";
import { DeviceAccessModule } from "../devices/access.module.js";
import { PermissionFacts } from "./permission-facts.js";
import { SandboxProviderRegistryModule } from "./providers.module.js";
@Module({
  imports: [SandboxProviderRegistryModule, DeviceAccessModule],
  providers: [PermissionFacts],
  exports: [PermissionFacts],
})
export class PermissionFactsModule {}
