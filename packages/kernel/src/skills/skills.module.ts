import { Module } from "@nestjs/common";
import { AgentLookupModule } from "../agents/agent-lookup.js";
import { AttachmentsModule } from "../conversations/attachments.module.js";
import { EventLogModule } from "../conversations/event-log.js";
import { OrgLockModule } from "../orgs/org-lock.js";
import { StorageModule } from "../storage/storage.module.js";
import { SkillsCatalogService } from "./catalog.js";
import { SkillChangesService } from "./changes.service.js";
import { SkillInvoker } from "./invoke.js";
import { SkillsService } from "./skills.service.js";

/**
 * Skills: the org library, agent-written skills and their approvals, the run start's skills
 * catalog snapshot and the one {@link SkillInvoker}.
 */
@Module({
  imports: [StorageModule, OrgLockModule, EventLogModule, AttachmentsModule, AgentLookupModule],
  providers: [SkillsService, SkillChangesService, SkillsCatalogService, SkillInvoker],
  exports: [SkillsService, SkillChangesService, SkillsCatalogService, SkillInvoker],
})
export class SkillsModule {}
