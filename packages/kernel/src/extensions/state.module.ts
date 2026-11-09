import { Module } from "@nestjs/common";
import { ClientModule } from "../client/client.module.js";
import { SuperAdminLockModule } from "../identity/super-admin.js";
import { OrgLockModule } from "../orgs/org-lock.js";
import { StorageModule } from "../storage/storage.module.js";
import { ExtensionApprovals } from "./approvals.js";
import { ExtensionBlobs } from "./blobs.js";
import { EffectiveConfigs } from "./effective-config.js";
import { ExtensionInstalls } from "./installs.js";
import { ExtensionRegistryModule } from "./registry.js";

/**
 * The extension state the model domain reads below the host: the install records with their
 * packages and approvals, and each extension's effective config per org. Apart from
 * `ExtensionsModule` so the model provider registry (and the `ctx.models` broker the host injects)
 * can depend on it without a module cycle (writing-kernel-api: a cycle is cut by moving the shared
 * part into its own provider both sides inject). `ExtensionsModule` re-exports it.
 */
@Module({
  imports: [
    ExtensionRegistryModule,
    SuperAdminLockModule,
    OrgLockModule,
    StorageModule,
    // a package with client code stores its client build (`ExtensionBlobs`)
    ClientModule,
  ],
  providers: [ExtensionApprovals, ExtensionBlobs, ExtensionInstalls, EffectiveConfigs],
  exports: [
    ExtensionRegistryModule,
    ExtensionApprovals,
    ExtensionBlobs,
    ExtensionInstalls,
    EffectiveConfigs,
  ],
})
export class ExtensionStateModule {}
