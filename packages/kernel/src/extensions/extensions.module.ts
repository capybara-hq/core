import { Module } from "@nestjs/common";
import { SuperAdminLockModule } from "../identity/super-admin.js";
import { ModelsModule } from "../models/models.module.js";
import { OrgLockModule } from "../orgs/org-lock.js";
import { StorageModule } from "../storage/storage.module.js";
import { EmbedTokensModule } from "../ui/embed-token.js";
import { ExtensionAdminOps } from "./admin-ops.js";
import { ExtensionAdmin } from "./admin-view.js";
import { BootstrapService } from "./bootstrap.js";
import { ExtensionDeploymentConfigService } from "./deployment-config.js";
import { ExtensionDisplayNames } from "./display-name.js";
import { ExtensionHost } from "./host.js";
import { ExtensionLifecycle } from "./lifecycle.js";
import {
  PluginApproveLock,
  PluginDeploymentConfigLock,
  PluginInstallLock,
  SingleProviderLock,
} from "./locks.js";
import { OrgExtensionConfigs } from "./org-config.js";
import { OrgOverrides } from "./org-overrides.js";
import { PluginGuides } from "./plugin-guides.js";
import { PluginIcons } from "./plugin-icons.js";
import { ExtensionPointDefaults } from "./point-defaults.js";
import { ExtensionRegistryModule } from "./registry.js";
import { SingleProviderGuard } from "./single-provider.js";
import { ReplicaStatusStore } from "./sources.js";
import { ExtensionStateModule } from "./state.module.js";
import { ExtensionAvailability } from "./unavailable.js";

/**
 * The extensions domain: the extension host (it builds each `ctx` from the injected kernel
 * services), the package store and install records (the desired state the host converges to, one
 * way: spec §3), the per-replica lifecycle and its periodic reconcile, the admin operations,
 * deployment and org configs, the bootstrap step, and the shared {@link ExtensionRegistry}.
 */
@Module({
  imports: [
    ExtensionRegistryModule,
    SuperAdminLockModule,
    OrgLockModule,
    StorageModule,
    // ctx.ui verifies embed tokens with the one provider the UI routes issue them with
    EmbedTokensModule,
    ExtensionStateModule,
    // ctx.models: the embeddings broker (models domain, below the host through ExtensionStateModule)
    ModelsModule,
  ],
  providers: [
    PluginInstallLock,
    PluginApproveLock,
    PluginDeploymentConfigLock,
    SingleProviderLock,
    SingleProviderGuard,
    ReplicaStatusStore,
    ExtensionHost,
    ExtensionLifecycle,
    ExtensionAdmin,
    ExtensionAdminOps,
    ExtensionDisplayNames,
    PluginIcons,
    PluginGuides,
    ExtensionDeploymentConfigService,
    OrgExtensionConfigs,
    OrgOverrides,
    ExtensionPointDefaults,
    BootstrapService,
    ExtensionAvailability,
  ],
  exports: [
    ExtensionRegistryModule,
    ExtensionStateModule,
    PluginInstallLock,
    PluginApproveLock,
    ReplicaStatusStore,
    ExtensionHost,
    ExtensionLifecycle,
    ExtensionAdmin,
    ExtensionAdminOps,
    ExtensionDisplayNames,
    PluginIcons,
    PluginGuides,
    ExtensionDeploymentConfigService,
    OrgExtensionConfigs,
    OrgOverrides,
    ExtensionPointDefaults,
    BootstrapService,
    ExtensionAvailability,
    SingleProviderGuard,
  ],
})
export class ExtensionsModule {}
