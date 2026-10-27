import { Controller, Get, Inject } from "@nestjs/common";
import { AGENT_TEMPLATES } from "../http/tokens.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import type { AgentTemplatesService, AgentTemplateView } from "./templates.js";

/**
 * The org's agent templates installed from plugins (`/api/v1/orgs/:orgId/agent-templates`, phase C
 * spec §17): the agent page lists them to select as sub-agents. Read with `agents.use`, like the
 * agents themselves; a template carries no secret (its body is in the plugin, which the org
 * installed).
 */
@Controller("api/v1/orgs/:orgId/agent-templates")
export class AgentTemplatesController {
  constructor(@Inject(AGENT_TEMPLATES) private readonly templates: AgentTemplatesService) {}

  @Get()
  @OrgAction("agents.use")
  async list(@CurrentOrg() org: OrgContext): Promise<{ templates: AgentTemplateView[] }> {
    return { templates: await this.templates.listForOrg(org.orgId) };
  }
}
