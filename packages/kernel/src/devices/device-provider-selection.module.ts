import { Module } from "@nestjs/common";
import { ExtensionsModule } from "../extensions/extensions.module.js";
import { OrgSettingsModule } from "../orgs/settings.service.js";
import { SandboxProviderRegistryModule } from "../sandbox/providers.module.js";
import { DeviceProviderSelection } from "./device-provider-selection.js";

/** {@link DeviceProviderSelection}: which providers serve an org, and the default one. */
@Module({
  imports: [ExtensionsModule, OrgSettingsModule, SandboxProviderRegistryModule],
  providers: [DeviceProviderSelection],
  exports: [DeviceProviderSelection],
})
export class DeviceProviderSelectionModule {}
