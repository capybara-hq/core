import { Module } from "@nestjs/common";
import { AttachmentsModule } from "../conversations/attachments.module.js";
import { EvalBudgetModule } from "../evals/budget.js";
import { ExtensionsModule } from "../extensions/extensions.module.js";
import { ModelsModule } from "../models/models.module.js";
import { OrgLockModule } from "../orgs/org-lock.js";
import { ProvidersModule } from "../runtime/providers.js";
import { SandboxModule } from "../sandbox/sandbox.module.js";
import { SkillsModule } from "../skills/skills.module.js";
import { ToolsModule } from "../tools/tools.module.js";
import { AgentLookupModule } from "./agent-lookup.js";
import { AgentProfileService } from "./agent-profile.service.js";
import { AgentsService } from "./agents.service.js";
import { AgentsFromTemplate } from "./from-template.service.js";
import { PendingConnectorRequests } from "./pending-connector-requests.js";
import { AgentTemplatesService } from "./templates.js";

/**
 * Agents: the one {@link AgentsService} (definitions, versions, visibility; writes under the org
 * row lock), the plugin agent templates, creating agents from templates (`AgentsFromTemplate`)
 * with its pending connector request seam (`PendingConnectorRequests`, ruling P4-7). Reads for a
 * viewer are {@link AgentLookupModule}'s
 * (re-exported), which the conversations and the skill invoker use without this module.
 */
@Module({
  imports: [
    AgentLookupModule,
    // avatar uploads
    AttachmentsModule,
    OrgLockModule,
    ProvidersModule,
    SkillsModule,
    ToolsModule,
    // the producer of sandbox-destroy-for jobs after a delete
    SandboxModule,
    // cancels the deleted agent's eval runs
    EvalBudgetModule,
    // creating from a template: the extension tools and the tier purposes (rulings P4-4, P4-5)
    ExtensionsModule,
    ModelsModule,
  ],
  providers: [
    AgentsService,
    AgentProfileService,
    AgentTemplatesService,
    AgentsFromTemplate,
    PendingConnectorRequests,
  ],
  exports: [
    AgentLookupModule,
    AgentsService,
    AgentProfileService,
    AgentTemplatesService,
    AgentsFromTemplate,
    PendingConnectorRequests,
  ],
})
export class AgentsModule {}
