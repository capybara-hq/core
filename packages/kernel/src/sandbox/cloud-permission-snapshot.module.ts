import { Module } from "@nestjs/common";
import { CloudPermissionSnapshots } from "./cloud-permission-snapshot.js";
import { SandboxLeases } from "./leases.js";
import { LegacyRetirementModule } from "./legacy-retirement.module.js";
import { PermissionAuthorityModule } from "./permission-authority.module.js";
import { PermissionFactsModule } from "./permission-facts.module.js";
import { SandboxProviderRegistryModule } from "./providers.module.js";

/**
 * The cloud snapshot writer (permission runtime cutover B1) and its driver (B-10), with the
 * sandbox leases it takes: the one {@link SandboxLeases} of the application (the sandbox service
 * uses it through {@link SandboxModule}'s import). Small enough for a CLI context
 * (`capybara permissions cutover snapshot`), which has Redis but no extension host.
 */
@Module({
  imports: [
    PermissionAuthorityModule,
    PermissionFactsModule,
    LegacyRetirementModule,
    SandboxProviderRegistryModule,
  ],
  providers: [SandboxLeases, CloudPermissionSnapshots],
  exports: [SandboxLeases, CloudPermissionSnapshots],
})
export class CloudPermissionSnapshotsModule {}
