import { Module } from "@nestjs/common";
import { AutomationsModule } from "../automations/automations.module.js";
import { CatalogModule } from "../catalog/catalog.module.js";
import { SkillsModule } from "../skills/skills.module.js";
import { ToolsModule } from "../tools/tools.module.js";
import { UiModule } from "../ui/ui.module.js";
import { InboxService } from "./inbox.service.js";
import { InboxItemActions } from "./inbox-item-actions.js";
import { InboxItemsModule } from "./inbox-items.service.js";
import { PlatformInboxService } from "./platform-inbox.service.js";

/**
 * The inboxes, read live from PG: an org member's (pending tool approvals, skill changes, catalog
 * requests, org notices, personal items) and the super admin's (`PlatformInboxService`); the
 * clicks on personal items' actions ({@link InboxItemActions}, through the UI actions).
 */
@Module({
  imports: [
    ToolsModule,
    SkillsModule,
    CatalogModule,
    AutomationsModule,
    InboxItemsModule,
    UiModule,
  ],
  providers: [InboxService, PlatformInboxService, InboxItemActions],
  exports: [InboxService, PlatformInboxService, InboxItemActions, InboxItemsModule],
})
export class InboxModule {}
