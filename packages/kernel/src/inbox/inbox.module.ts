import { Module } from "@nestjs/common";
import { CatalogModule } from "../catalog/catalog.module.js";
import { SkillsModule } from "../skills/skills.module.js";
import { ToolsModule } from "../tools/tools.module.js";
import { InboxService } from "./inbox.service.js";

/** The inbox: pending tool approvals, skill changes and catalog requests, read live from PG. */
@Module({
  imports: [ToolsModule, SkillsModule, CatalogModule],
  providers: [InboxService],
  exports: [InboxService],
})
export class InboxModule {}
