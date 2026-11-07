import { Module } from "@nestjs/common";
import { ExtensionsModule } from "../extensions/extensions.module.js";
import { SuperAdminLockModule } from "../identity/super-admin.js";
import { QueueModule } from "../infra/queue/queue.module.js";
import { OrgLockModule } from "../orgs/org-lock.js";
import { MAINTENANCE_QUEUE_NAME } from "../runtime/maintenance-queue.js";
import { SkillsModule } from "../skills/skills.module.js";
import { StorageModule } from "../storage/storage.module.js";
import { ToolsModule } from "../tools/tools.module.js";
import { CatalogImportModule } from "./catalog-import.module.js";
import { CatalogScopeService } from "./catalog-scope.service.js";
import { ComponentScopeService } from "./component-scope.service.js";
import { OrgCatalogService } from "./org-catalog.service.js";
import { OrgExtensionSwitch } from "./org-extension-switch.js";
import { OrgPluginUploads } from "./org-plugin-uploads.js";
import { OwnedItems } from "./owned-items.js";
import { PluginInstaller } from "./plugin-install.js";
import { PlatformPluginUpdater } from "./plugin-upgrade.js";
import { CatalogRequestsService } from "./requests.service.js";
import { PLUGIN_SCOPE_QUEUE, PluginScopeSync } from "./scope-sync.js";

export { CatalogImportModule };

/**
 * The plugin catalog (spec §4, §10): {@link CatalogImportModule}, catalog requests, org installs
 * with their dependencies, the platform plugin update (`PlatformPluginUpdater`), the admin's scope
 * and disable
 * (`CatalogScopeService`), org admins' plugin uploads (`OrgPluginUploads`) and their own plugins (`OwnedItems`), and the producer of the plugin scope sync
 * (`PluginScopeSync`; its consumer is the worker role's `PluginScopeWorkersModule`). The catalog's periodic jobs (`CatalogJobs`) are
 * the worker role's (`WorkerModule`).
 */
@Module({
  imports: [
    CatalogImportModule,
    ExtensionsModule,
    SuperAdminLockModule,
    OrgLockModule,
    StorageModule,
    SkillsModule,
    ToolsModule,
    // the producer side of the plugin scope sync (`PluginScopeWorkersModule` consumes it)
    QueueModule.registerQueue(PLUGIN_SCOPE_QUEUE),
    // a removed org plugin's cleanup job (`OwnedItems`, `CatalogScopeService`; consumed by the
    // worker role's `MaintenanceProcessor`)
    QueueModule.registerQueue(MAINTENANCE_QUEUE_NAME),
  ],
  providers: [
    CatalogRequestsService,
    PluginInstaller,
    PlatformPluginUpdater,
    OrgCatalogService,
    OrgExtensionSwitch,
    PluginScopeSync,
    CatalogScopeService,
    ComponentScopeService,
    OrgPluginUploads,
    OwnedItems,
  ],
  exports: [
    CatalogImportModule,
    CatalogRequestsService,
    PluginInstaller,
    PlatformPluginUpdater,
    OrgCatalogService,
    OrgExtensionSwitch,
    PluginScopeSync,
    CatalogScopeService,
    ComponentScopeService,
    OrgPluginUploads,
    OwnedItems,
  ],
})
export class CatalogModule {}
