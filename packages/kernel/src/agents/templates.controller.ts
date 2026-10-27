import { Controller, Get, Inject } from "@nestjs/common";
import { AGENT_TEMPLATES } from "../http/tokens.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import type { AgentTemplatesService, AgentTemplateView } from "./templates.js";

/**
 * The org's agent templates installed from plugins (`/api/v1/orgs/:orgId/agent-templates`, phase C
 * spec §17): the agent page lists them to select as sub-agents. Read with `agents.create`, the
 * permission of its only consumer, the agent editor (members, people only); a template carries no
 * secret, but guests and service tokens have no use for the list.
 */
@Controller("api/v1/orgs/:orgId/agent-templates")
export class AgentTemplatesController {
  constructor(@Inject(AGENT_TEMPLATES) private readonly templates: AgentTemplatesService) {}

  @Get()
  @OrgAction("agents.create")
  async list(@CurrentOrg() org: OrgContext): Promise<{ templates: AgentTemplateView[] }> {
    return { templates: await this.templates.listForOrg(org.orgId) };
  }
}
