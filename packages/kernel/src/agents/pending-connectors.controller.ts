import { Controller, Get, HttpCode, Inject, Param, Post, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import type { z } from "zod";
import { CatalogRequestsService, type CatalogRequestView } from "../catalog/requests.service.js";
import {
  CurrentPrincipal,
  type Principal,
  patTokenId,
  requireUser,
} from "../identity/principal.js";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import { ZBody } from "../infra/validation/zod-params.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import type { AgentView } from "./agent-lookup.js";
import { PendingConnectorBindBody as BindBodySchema } from "./agents.schemas.js";
import { AgentsService } from "./agents.service.js";
import { PendingConnectorsService } from "./pending-connectors.service.js";

const BindBody = BindBodySchema;

class PendingConnectorBindBody extends createZodDto(BindBody, "PendingConnectorBindBody") {}

/**
 * An agent's pending connectors (`/api/v1/orgs/:orgId/agents/:agentId/pending-connectors`,
 * rulings P4-6, P4-7; human users only):
 * - `POST :key/bind { connectorId }` (`agents.create`; the service allows the owner or an org
 *   admin+) -> 200 `{ agent, dropped }`: a new version with the connector's tools, the entry gone;
 * - `POST request` (same) -> 201 `{ request }` a new `connector_setup` request, 200 `{ request }`
 *   the pending one;
 * - `GET request` (`agents.use`; the service allows only the agent's owner or an org admin+:
 *   another member who sees the agent -> 403 `forbidden`, anyone else 404 `agent.not_found`) ->
 *   200 `{ request }`: the latest `connector_setup` request of the agent, any status, or null.
 */
@Controller("api/v1/orgs/:orgId/agents/:agentId/pending-connectors")
export class PendingConnectorsController {
  constructor(
    @Inject(PendingConnectorsService) private readonly pending: PendingConnectorsService,
    @Inject(AgentsService) private readonly agents: AgentsService,
    @Inject(CatalogRequestsService) private readonly requests: CatalogRequestsService,
  ) {}

  @Post(":key/bind")
  @HttpCode(200)
  @OrgAction("agents.create")
  async bind(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("agentId") agentId: string,
    @Param("key") key: string,
    @ZBody(PendingConnectorBindBody) body: z.infer<typeof BindBody>,
  ): Promise<{ agent: AgentView; dropped: string[] }> {
    const p = requireUser(principal);
    const r = await this.pending.bind(
      org.orgId,
      agentId,
      key,
      body.connectorId,
      p.account.id,
      patTokenId(p),
    );
    const [agent] = await this.agents.withTemplateLinks(org.orgId, [r.agent]);
    return { agent: agent as AgentView, dropped: r.dropped };
  }

  @Post("request")
  @OrgAction("agents.create")
  async reopen(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("agentId") agentId: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ request: CatalogRequestView }> {
    const p = requireUser(principal);
    const r = await this.pending.reopen(org.orgId, agentId, p.account.id, patTokenId(p));
    reply.status(r.created ? 201 : 200);
    return { request: await this.requests.view(r.id) };
  }

  @Get("request")
  @OrgAction("agents.use")
  async latest(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("agentId") agentId: string,
  ): Promise<{ request: CatalogRequestView | null }> {
    const p = requireUser(principal);
    const id = await this.pending.latestRequest(org.orgId, agentId, p.account.id);
    return { request: id === null ? null : await this.requests.view(id) };
  }
}
