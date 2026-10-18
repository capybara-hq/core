import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
} from "@nestjs/common";
import { z } from "zod";
import { AGENTS } from "../http/tokens.js";
import { ZodPipe } from "../http/zod.pipe.js";
import {
  CurrentPrincipal,
  type Principal,
  patTokenId,
  requireUser,
} from "../identity/principal.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import {
  AGENT_VISIBILITIES,
  type AgentsService,
  type AgentVersionSummary,
  type AgentView,
  type AgentWarning,
} from "./agents.service.js";
import { AgentDefinitionSchema } from "./definition.js";

const MemberIds = z.array(z.string().min(1).max(100)).max(1000);

const CreateBody = z
  .object({
    definition: AgentDefinitionSchema,
    visibility: z.enum(AGENT_VISIBILITIES),
    memberIds: MemberIds.optional(),
  })
  .strict();
const UpdateBody = z
  .object({
    definition: AgentDefinitionSchema.optional(),
    visibility: z.enum(AGENT_VISIBILITIES).optional(),
    memberIds: MemberIds.optional(),
  })
  .strict();

/** 服务令牌没有账号：以 null 作为 viewer，只看到 visibility='org' 的 agent。 */
const viewerOf = (p: Principal): string | null => (p.kind === "user" ? p.account.id : null);

/**
 * Agent 定义（`/api/v1/orgs/:orgId/agents`）。读用 `agents.use`（访客与服务令牌可用），
 * 写用 `agents.create`（member 以上、HUMAN_ONLY），修改 / 删除的负责人或管理员判定在服务的组织行锁内完成。
 */
@Controller("api/v1/orgs/:orgId/agents")
export class AgentsController {
  constructor(@Inject(AGENTS) private readonly agents: AgentsService) {}

  @Post()
  @OrgAction("agents.create")
  async create(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Body(new ZodPipe(CreateBody)) body: z.infer<typeof CreateBody>,
  ): Promise<{ agent: AgentView; warnings: AgentWarning[] }> {
    const p = requireUser(principal);
    return this.agents.create(
      org.orgId,
      p.account.id,
      {
        definition: body.definition,
        visibility: body.visibility,
        ...(body.memberIds !== undefined && { memberIds: body.memberIds }),
      },
      patTokenId(p),
    );
  }

  @Get()
  @OrgAction("agents.use")
  async list(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
  ): Promise<{ agents: AgentView[] }> {
    return { agents: await this.agents.listVisible(org.orgId, viewerOf(principal)) };
  }

  @Get(":agentId")
  @OrgAction("agents.use")
  async get(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("agentId") agentId: string,
  ): Promise<{ agent: AgentView }> {
    return { agent: await this.agents.get(org.orgId, agentId, viewerOf(principal)) };
  }

  @Patch(":agentId")
  @OrgAction("agents.create")
  async update(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("agentId") agentId: string,
    @Body(new ZodPipe(UpdateBody)) body: z.infer<typeof UpdateBody>,
  ): Promise<{ agent: AgentView; warnings: AgentWarning[] }> {
    const p = requireUser(principal);
    return this.agents.update(org.orgId, agentId, p.account.id, body, patTokenId(p));
  }

  @Delete(":agentId")
  @HttpCode(204)
  @OrgAction("agents.create")
  async remove(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("agentId") agentId: string,
  ): Promise<void> {
    const p = requireUser(principal);
    await this.agents.softDelete(org.orgId, agentId, p.account.id, patTokenId(p));
  }

  @Get(":agentId/versions")
  @OrgAction("agents.use")
  async versions(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("agentId") agentId: string,
  ): Promise<{ versions: AgentVersionSummary[] }> {
    await this.agents.get(org.orgId, agentId, viewerOf(principal));
    return { versions: await this.agents.listVersions(agentId) };
  }
}
