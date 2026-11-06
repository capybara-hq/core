import { Module } from "@nestjs/common";
import { ExtensionsModule } from "../extensions/extensions.module.js";
import { SuperAdminLockModule } from "../identity/super-admin.js";
import { QueueModule } from "../infra/queue/queue.module.js";
import { OrgLockModule } from "../orgs/org-lock.js";
import { MAINTENANCE_QUEUE_NAME } from "../runtime/maintenance-queue.js";
import { StorageModule } from "../storage/storage.module.js";
import { CatalogService } from "./catalog.service.js";
import { ComponentPromotion } from "./component-promotion.js";
import { CatalogItemLock, CatalogSourceLock } from "./locks.js";
import { MarketplacesService } from "./marketplaces.service.js";
import { PlatformComponents } from "./platform-components.js";
import { PluginImport } from "./plugin-import.js";

// Its own file so that `SkillsModule` can import it (an owner's new version of a promoted skill is
// written to its platform row, ruling P3-4) without a module file cycle through `CatalogModule`.
/**
 * The platform side of the catalog: marketplaces, the one import review (prepare -> confirm), the
 * items and their platform components. The CLI's `capybara plugins *` and `capybara bootstrap` run on this
 * part alone.
 */
@Module({
  imports: [
    ExtensionsModule,
    SuperAdminLockModule,
    // an org upload re-checks the owner org's admin (`PluginImport`, ruling P3-7)
    OrgLockModule,
    StorageModule,
    // a failed post-import platform sync enqueues the migration job (`PluginImport.syncPlatform`)
    QueueModule.registerQueue(MAINTENANCE_QUEUE_NAME),
  ],
  providers: [
    CatalogSourceLock,
    CatalogItemLock,
    MarketplacesService,
    PluginImport,
    PlatformComponents,
    // promote on share (ruling P3-3): the admin component routes and the owner's 可共享
    ComponentPromotion,
    CatalogService,
  ],
  exports: [
    MarketplacesService,
    PluginImport,
    PlatformComponents,
    ComponentPromotion,
    CatalogService,
    CatalogItemLock,
  ],
})
export class CatalogImportModule {}
