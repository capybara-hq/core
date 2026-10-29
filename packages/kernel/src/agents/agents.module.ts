import { Module } from "@nestjs/common";
import { OrgLockModule } from "../orgs/org-lock.js";
import { SkillsModule } from "../skills/skills.module.js";
import { ToolsModule } from "../tools/tools.module.js";
import { AgentLookupModule } from "./agent-lookup.js";
import { AgentsService } from "./agents.service.js";
import { AgentTemplatesService } from "./templates.js";

/**
 * Agents: the one {@link AgentsService} (definitions, versions, visibility; writes under the org
 * row lock) and the plugin agent templates. Reads for a viewer are {@link AgentLookupModule}'s
 * (re-exported), which the conversations and the skill invoker use without this module.
 */
@Module({
  imports: [AgentLookupModule, OrgLockModule, SkillsModule, ToolsModule],
  providers: [AgentsService, AgentTemplatesService],
  exports: [AgentLookupModule, AgentsService, AgentTemplatesService],
})
export class AgentsModule {}
