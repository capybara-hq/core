import { Module } from "@nestjs/common";
import { DeviceReports } from "./device-reports.js";
import { PermissionCeilingWritesModule } from "./permission-authority.module.js";
import { SandboxProviderRegistryModule } from "./providers.module.js";

/**
 * {@link DeviceReports}: the stored device reports and the device authority epoch their revisions
 * drive. Below the extension host (registry, ceiling writes and infrastructure only), so the host
 * builds `ctx.devices` from it and the sandbox and device domains share the one instance.
 */
@Module({
  imports: [SandboxProviderRegistryModule, PermissionCeilingWritesModule],
  providers: [DeviceReports],
  exports: [DeviceReports],
})
export class DeviceReportsModule {}
