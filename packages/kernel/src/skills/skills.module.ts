import { Module } from "@nestjs/common";
import { AgentLookupModule } from "../agents/agent-lookup.js";
import { CatalogImportModule } from "../catalog/catalog-import.module.js";
import { AttachmentsModule } from "../conversations/attachments.module.js";
import { EventLogModule } from "../conversations/event-log.js";
import { DevicesModule } from "../devices/devices.module.js";
import { OrgLockModule } from "../orgs/org-lock.js";
import { SandboxModule } from "../sandbox/sandbox.module.js";
import { StorageModule } from "../storage/storage.module.js";
import { AgentSkillsService } from "./agent-skills.service.js";
import { SkillsCatalogService } from "./catalog.js";
import { SkillChangesService } from "./changes.service.js";
import { SkillInvoker } from "./invoke.js";
import { SkillsService } from "./skills.service.js";

/**
 * Skills: the org library, agent-written skills and their approvals, the run start's skills
 * catalog snapshot and the one {@link SkillInvoker}.
 */
@Module({
  imports: [
    StorageModule,
    OrgLockModule,
    EventLogModule,
    AttachmentsModule,
    AgentLookupModule,
    // the owner's new version of a skill it promoted goes to the platform row (ruling P3-4)
    CatalogImportModule,
    // a person's invocation of a project skill reads its SKILL.md on the conversation's device
    DevicesModule,
    SandboxModule,
  ],
  providers: [
    AgentSkillsService,
    SkillsService,
    SkillChangesService,
    SkillsCatalogService,
    SkillInvoker,
  ],
  exports: [
    AgentSkillsService,
    SkillsService,
    SkillChangesService,
    SkillsCatalogService,
    SkillInvoker,
  ],
})
export class SkillsModule {}
