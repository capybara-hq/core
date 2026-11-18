import { Module } from "@nestjs/common";
import { ExtensionRegistryModule } from "../extensions/registry.js";
import { SandboxProviders } from "./providers.js";
@Module({
  imports: [ExtensionRegistryModule],
  providers: [SandboxProviders],
  exports: [SandboxProviders],
})
export class SandboxProviderRegistryModule {}
