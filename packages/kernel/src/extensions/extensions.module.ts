import { Module } from "@nestjs/common";
import { EnterpriseAdminLockModule } from "../identity/enterprise-admin.js";
import { OrgLockModule } from "../orgs/org-lock.js";
import { StorageModule } from "../storage/storage.module.js";
import { EmbedTokensModule } from "../ui/embed-token.js";
import { ExtensionAdminOps } from "./admin-ops.js";
import { ExtensionAdmin } from "./admin-view.js";
import { ExtensionApprovals } from "./approvals.js";
import { ExtensionBlobs } from "./blobs.js";
import { BootstrapService } from "./bootstrap.js";
import { ExtensionDeploymentConfigService } from "./deployment-config.js";
import { ExtensionHost } from "./host.js";
import { ExtensionInstalls } from "./installs.js";
import { ExtensionLifecycle } from "./lifecycle.js";
import { PluginApproveLock, PluginDeploymentConfigLock, PluginInstallLock } from "./locks.js";
import { OrgExtensionConfigs } from "./org-config.js";
import { ExtensionRegistryModule } from "./registry.js";
import { ReplicaStatusStore } from "./sources.js";

/**
 * The extensions domain: the extension host (it builds each `ctx` from the injected kernel
 * services), the package store and install records (the desired state the host converges to, one
 * way: spec §3), the per-replica lifecycle and its periodic reconcile, the admin operations,
 * deployment and org configs, the bootstrap step, and the shared {@link ExtensionRegistry} (R6).
 */
@Module({
  imports: [
    ExtensionRegistryModule,
    EnterpriseAdminLockModule,
    OrgLockModule,
    StorageModule,
    // ctx.ui verifies embed tokens with the one provider the UI routes issue them with
    EmbedTokensModule,
  ],
  providers: [
    PluginInstallLock,
    PluginApproveLock,
    PluginDeploymentConfigLock,
    ExtensionApprovals,
    ExtensionBlobs,
    ExtensionInstalls,
    ReplicaStatusStore,
    ExtensionHost,
    ExtensionLifecycle,
    ExtensionAdmin,
    ExtensionAdminOps,
    ExtensionDeploymentConfigService,
    OrgExtensionConfigs,
    BootstrapService,
  ],
  exports: [
    ExtensionRegistryModule,
    PluginInstallLock,
    PluginApproveLock,
    ExtensionApprovals,
    ExtensionBlobs,
    ExtensionInstalls,
    ReplicaStatusStore,
    ExtensionHost,
    ExtensionLifecycle,
    ExtensionAdmin,
    ExtensionAdminOps,
    ExtensionDeploymentConfigService,
    OrgExtensionConfigs,
    BootstrapService,
  ],
})
export class ExtensionsModule {}
