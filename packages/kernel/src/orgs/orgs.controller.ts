import { Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post } from "@nestjs/common";
import { z } from "zod";
import { ApiError } from "../errors.js";
import { type ApiTokenRecord, ApiTokenService, FutureIsoDate } from "../identity/api-tokens.js";
import {
  CurrentPrincipal,
  type Principal,
  patTokenId,
  requireUser,
  SessionOnly,
} from "../identity/principal.js";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import { ZBody } from "../infra/validation/zod-params.js";
import { type Member, MembersService } from "./members.service.js";
import { CurrentOrg, OrgAction, type OrgContext } from "./org.guard.js";
import { type Org, OrgsService } from "./orgs.service.js";
import { ORG_ROLES, type OrgRole } from "./roles.js";

const CreateSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z.string().min(1).max(40).optional(),
});
class OrgCreateBody extends createZodDto(CreateSchema, "OrgCreateBody") {}
const UpdateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  slug: z.string().min(1).max(40).optional(),
});
class OrgUpdateBody extends createZodDto(UpdateSchema, "OrgUpdateBody") {}
const TransferSchema = z.object({ toAccountId: z.string().min(1) });
class OrgTransferBody extends createZodDto(TransferSchema, "OrgTransferBody") {}
const ServiceTokenSchema = z.object({
  name: z.string().min(1).max(100),
  role: z.enum(["admin", "member", "guest"]),
  expiresAt: FutureIsoDate.optional(),
});
class ServiceTokenBody extends createZodDto(ServiceTokenSchema, "ServiceTokenBody") {}
const RoleSchema = z.object({ role: z.enum(ORG_ROLES) });
class MemberRoleBody extends createZodDto(RoleSchema, "MemberRoleBody") {}

/** 组织与成员（`/api/v1/orgs`）。组织级路由由 `@OrgAction` + OrgGuard 每请求实时鉴权。 */
@Controller("api/v1/orgs")
export class OrgsController {
  constructor(
    @Inject(OrgsService) private readonly orgs: OrgsService,
    @Inject(MembersService) private readonly members: MembersService,
    @Inject(ApiTokenService) private readonly tokens: ApiTokenService,
  ) {}

  @Post()
  async create(
    @CurrentPrincipal() principal: Principal,
    @ZBody(OrgCreateBody) body: z.infer<typeof CreateSchema>,
  ): Promise<{ org: Org; role: "owner" }> {
    const p = requireUser(principal);
    const org = await this.orgs.create(body, p.account, { actorTokenId: patTokenId(p) });
    return { org, role: "owner" };
  }

  @Get()
  async list(
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ orgs: (Org & { role: OrgRole })[] }> {
    const p = requireUser(principal);
    return { orgs: await this.orgs.listForAccount(p.account.id) };
  }

  @Get(":orgId")
  @OrgAction("org.read")
  async get(@CurrentOrg() org: OrgContext): Promise<{ org: Org; role: OrgRole }> {
    const found = await this.orgs.get(org.orgId);
    if (!found) throw new ApiError("org.not_found", "Organization not found");
    return { org: found, role: org.role };
  }

  @Patch(":orgId")
  @OrgAction("org.update")
  async update(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZBody(OrgUpdateBody) body: z.infer<typeof UpdateSchema>,
  ): Promise<{ org: Org }> {
    const p = requireUser(principal);
    return { org: await this.orgs.update(org.orgId, body, p.account, patTokenId(p)) };
  }

  @Delete(":orgId")
  @OrgAction("org.delete")
  @HttpCode(204)
  async remove(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
  ): Promise<void> {
    const p = requireUser(principal);
    await this.orgs.softDelete(org.orgId, p.account, patTokenId(p));
  }

  @Post(":orgId/transfer")
  @OrgAction("org.transfer")
  @HttpCode(204)
  async transfer(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZBody(OrgTransferBody) body: z.infer<typeof TransferSchema>,
  ): Promise<void> {
    const p = requireUser(principal);
    await this.members.transferOwnership(org.orgId, p.account.id, body.toAccountId, patTokenId(p));
  }

  @Post(":orgId/leave")
  @OrgAction("org.read")
  @HttpCode(204)
  async leave(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
  ): Promise<void> {
    const p = requireUser(principal);
    await this.members.leave(org.orgId, p.account.id, patTokenId(p));
  }

  @Get(":orgId/members")
  @OrgAction("org.members.read")
  async listMembers(@CurrentOrg() org: OrgContext): Promise<{ members: Member[] }> {
    return { members: await this.members.list(org.orgId) };
  }

  @Patch(":orgId/members/:accountId")
  @OrgAction("org.members.manage")
  async changeRole(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("accountId") accountId: string,
    @ZBody(MemberRoleBody) body: z.infer<typeof RoleSchema>,
  ): Promise<{ accountId: string; role: OrgRole }> {
    const p = requireUser(principal);
    await this.members.changeRole(org.orgId, accountId, body.role, p.account.id, patTokenId(p));
    return { accountId, role: body.role };
  }

  @Delete(":orgId/members/:accountId")
  @OrgAction("org.members.manage")
  @HttpCode(204)
  async removeMember(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("accountId") accountId: string,
  ): Promise<void> {
    const p = requireUser(principal);
    await this.members.remove(org.orgId, accountId, p.account.id, patTokenId(p));
  }

  @Post(":orgId/service-tokens")
  @OrgAction("org.tokens.manage")
  @SessionOnly()
  async createServiceToken(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZBody(ServiceTokenBody) body: z.infer<typeof ServiceTokenSchema>,
  ): Promise<{ token: string; record: ApiTokenRecord }> {
    const p = requireUser(principal);
    return this.tokens.createServiceAs(org.orgId, p.account.id, body);
  }

  @Get(":orgId/service-tokens")
  @OrgAction("org.tokens.manage")
  @SessionOnly()
  async listServiceTokens(@CurrentOrg() org: OrgContext): Promise<{ tokens: ApiTokenRecord[] }> {
    return { tokens: await this.tokens.list({ orgId: org.orgId }) };
  }

  @Delete(":orgId/service-tokens/:tokenId")
  @OrgAction("org.tokens.manage")
  @SessionOnly()
  @HttpCode(204)
  async revokeServiceToken(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("tokenId") tokenId: string,
  ): Promise<void> {
    const p = requireUser(principal);
    await this.tokens.revokeServiceAs(org.orgId, tokenId, p.account.id);
  }
}
