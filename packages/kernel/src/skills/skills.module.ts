import { Module } from "@nestjs/common";
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
  imports: [StorageModule, OrgLockModule],
  providers: [SkillsService, SkillChangesService, SkillsCatalogService, SkillInvoker],
  exports: [SkillsService, SkillChangesService, SkillsCatalogService, SkillInvoker],
})
export class SkillsModule {}
