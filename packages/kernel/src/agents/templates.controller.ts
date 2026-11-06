import { Controller, Get, Inject, Put } from "@nestjs/common";
import { z } from "zod";
import { OwnedItems } from "../catalog/owned-items.js";
import {
  CurrentPrincipal,
  type Principal,
  patTokenId,
  requireUser,
} from "../identity/principal.js";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import { ZBody, ZParam } from "../infra/validation/zod-params.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import { AgentTemplatesService, type AgentTemplateView } from "./templates.js";

const IdParams = z.object({ id: z.string().min(1).max(100) });
const ShareableBody = z.object({ shareable: z.boolean() }).strict();
class AgentTemplateIdParams extends createZodDto(IdParams, "AgentTemplateIdParams") {}
class AgentTemplateShareableBody extends createZodDto(
  ShareableBody,
  "AgentTemplateShareableBody",
) {}

/**
 * The org's agent templates installed from plugins (`/api/v1/orgs/:orgId/agent-templates`, phase C
 * spec §17): the agent page lists them to select as sub-agents. Read with `agents.create`, the
 * permission of its only consumer, the agent editor (members, people only); a template carries no
 * secret, but guests and service tokens have no use for the list. `PUT /:id/shareable` sets
 * 可共享 on the org's own template (plugin scope phase 3, ruling P3-6; `catalog.upload`).
 */
@Controller("api/v1/orgs/:orgId/agent-templates")
export class AgentTemplatesController {
  constructor(
    @Inject(AgentTemplatesService) private readonly templates: AgentTemplatesService,
    @Inject(OwnedItems) private readonly owned: OwnedItems,
  ) {}

  @Get()
  @OrgAction("agents.create")
  async list(@CurrentOrg() org: OrgContext): Promise<{ templates: AgentTemplateView[] }> {
    return { templates: await this.templates.listForOrg(org.orgId) };
  }

  /**
   * Sets 可共享 on the org's own agent template (`{ shareable }` -> 200 `{ id, shareable }`): a
   * copy of another owner's platform template -> 409 `catalog.not_owned`; one the org promoted
   * writes its platform row too (ruling P3-2).
   */
  @Put(":id/shareable")
  @OrgAction("catalog.upload")
  async setShareable(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(AgentTemplateIdParams) params: z.infer<typeof IdParams>,
    @ZBody(AgentTemplateShareableBody) body: z.infer<typeof ShareableBody>,
  ): Promise<{ id: string; shareable: boolean }> {
    const p = requireUser(principal);
    const tokenId = patTokenId(p);
    await this.owned.setShareable(
      org.orgId,
      p.account.id,
      { kind: "agent_template", id: params.id },
      body.shareable,
      tokenId !== undefined ? { actorTokenId: tokenId } : {},
    );
    return { id: params.id, shareable: body.shareable };
  }
}
