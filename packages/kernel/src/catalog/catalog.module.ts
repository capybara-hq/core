import { Module } from "@nestjs/common";
import { ExtensionsModule } from "../extensions/extensions.module.js";
import { EnterpriseAdminLockModule } from "../identity/enterprise-admin.js";
import { QueueModule } from "../infra/queue/queue.module.js";
import { OrgLockModule } from "../orgs/org-lock.js";
import { SkillsModule } from "../skills/skills.module.js";
import { StorageModule } from "../storage/storage.module.js";
import { ToolsModule } from "../tools/tools.module.js";
import { CatalogService } from "./catalog.service.js";
import { CatalogItemLock, CatalogSourceLock } from "./locks.js";
import { MarketplacesService } from "./marketplaces.service.js";
import { OrgCatalogService } from "./org-catalog.service.js";
import { PluginImport } from "./plugin-import.js";
import { PluginInstaller } from "./plugin-install.js";
import { PluginUpgrader } from "./plugin-upgrade.js";
import { CatalogRequestsService } from "./requests.service.js";
import { PLUGIN_SCOPE_QUEUE, PluginScopeSync } from "./scope-sync.js";

/**
 * The enterprise side of the catalog: marketplaces, the one import review (prepare -> confirm) and
 * the items with their policy. The CLI's `capybara plugins *` and `capybara bootstrap` run on this
 * part alone.
 */
@Module({
  imports: [ExtensionsModule, EnterpriseAdminLockModule, StorageModule],
  providers: [
    CatalogSourceLock,
    CatalogItemLock,
    MarketplacesService,
    PluginImport,
    CatalogService,
  ],
  exports: [MarketplacesService, PluginImport, CatalogService],
})
export class CatalogImportModule {}

/**
 * The plugin catalog (spec §4, §10): {@link CatalogImportModule}, catalog requests, org installs,
 * upgrades and rollbacks with their dependencies, and the producer of the plugin scope sync
 * (`PluginScopeSync`; its consumer is the worker role's `PluginScopeWorkersModule`). The catalog's periodic jobs (`CatalogJobs`) are
 * the worker role's (`WorkerModule`).
 */
@Module({
  imports: [
    CatalogImportModule,
    ExtensionsModule,
    EnterpriseAdminLockModule,
    OrgLockModule,
    StorageModule,
    SkillsModule,
    ToolsModule,
    // the producer side of the plugin scope sync (`PluginScopeWorkersModule` consumes it)
    QueueModule.registerQueue(PLUGIN_SCOPE_QUEUE),
  ],
  providers: [
    CatalogRequestsService,
    PluginInstaller,
    PluginUpgrader,
    OrgCatalogService,
    PluginScopeSync,
  ],
  exports: [
    CatalogImportModule,
    CatalogRequestsService,
    PluginInstaller,
    PluginUpgrader,
    OrgCatalogService,
    PluginScopeSync,
  ],
})
export class CatalogModule {}
