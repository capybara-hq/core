import { Module } from "@nestjs/common";
import { ExtensionsModule } from "../extensions/extensions.module.js";
import { EnterpriseAdminLockModule } from "../identity/enterprise-admin.js";
import { OrgLockModule } from "../orgs/org-lock.js";
import { SkillsModule } from "../skills/skills.module.js";
import { StorageModule } from "../storage/storage.module.js";
import { CatalogService } from "./catalog.service.js";
import { CatalogJobs } from "./jobs.js";
import { CatalogItemLock, CatalogSourceLock } from "./locks.js";
import { MarketplacesService } from "./marketplaces.service.js";
import { OrgCatalogService } from "./org-catalog.service.js";
import { PluginImport } from "./plugin-import.js";
import { PluginInstaller } from "./plugin-install.js";
import { PluginUpgrader } from "./plugin-upgrade.js";
import { CatalogRequestsService } from "./requests.service.js";

/**
 * The enterprise side of the catalog: marketplaces, the one import review (prepare -> confirm) and
 * the items with their policy. The CLI's `capybara plugins *` and `capybara bootstrap` run on this
 * part alone (R13).
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
 * The plugin catalog (spec §4, §10): {@link CatalogImportModule}, catalog requests, and org installs,
 * upgrades and rollbacks with their dependencies; plus the catalog's periodic jobs.
 */
@Module({
  imports: [
    CatalogImportModule,
    ExtensionsModule,
    EnterpriseAdminLockModule,
    OrgLockModule,
    StorageModule,
    SkillsModule,
  ],
  providers: [
    CatalogRequestsService,
    PluginInstaller,
    PluginUpgrader,
    OrgCatalogService,
    CatalogJobs,
  ],
  exports: [
    CatalogImportModule,
    CatalogRequestsService,
    PluginInstaller,
    PluginUpgrader,
    OrgCatalogService,
  ],
})
export class CatalogModule {}
