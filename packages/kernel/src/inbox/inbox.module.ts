import { Module } from "@nestjs/common";
import { CatalogModule } from "../catalog/catalog.module.js";
import { SkillsModule } from "../skills/skills.module.js";
import { ToolsModule } from "../tools/tools.module.js";
import { InboxService } from "./inbox.service.js";
import { PlatformInboxService } from "./platform-inbox.service.js";

/**
 * The inboxes, read live from PG: an org member's (pending tool approvals, skill changes, catalog
 * requests, org notices) and the super admin's (`PlatformInboxService`).
 */
@Module({
  imports: [ToolsModule, SkillsModule, CatalogModule],
  providers: [InboxService, PlatformInboxService],
  exports: [InboxService, PlatformInboxService],
})
export class InboxModule {}
