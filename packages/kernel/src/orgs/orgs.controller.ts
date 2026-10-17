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
import { ApiError } from "../errors.js";
import { API_TOKENS, MEMBERS, ORGS } from "../http/tokens.js";
import { ZodPipe } from "../http/zod.pipe.js";
import type { ApiTokenRecord, ApiTokenService } from "../identity/api-tokens.js";
import { CurrentPrincipal, type Principal, requireUser } from "../identity/principal.js";
import type { Member, MembersService } from "./members.service.js";
import { CurrentOrg, OrgAction, type OrgContext } from "./org.guard.js";
import type { Org, OrgsService } from "./orgs.service.js";
import { ORG_ROLES, type OrgRole } from "./roles.js";

const CreateBody = z.object({
  name: z.string().min(1).max(100),
  slug: z.string().min(1).max(40).optional(),
});
const UpdateBody = z.object({
  name: z.string().min(1).max(100).optional(),
  slug: z.string().min(1).max(40).optional(),
});
const TransferBody = z.object({ toAccountId: z.string().min(1) });
const ServiceTokenBody = z.object({
  name: z.string().min(1).max(100),
  role: z.enum(["admin", "member", "guest"]),
  expiresAt: z.coerce
    .date()
    .refine((d) => d.getTime() > Date.now(), "must be in the future")
    .optional(),
});
const RoleBody = z.object({ role: z.enum(ORG_ROLES) });

/** 组织与成员（`/api/v1/orgs`）。组织级路由由 `@OrgAction` + OrgGuard 每请求实时鉴权。 */
@Controller("api/v1/orgs")
export class OrgsController {
  constructor(
    @Inject(ORGS) private readonly orgs: OrgsService,
    @Inject(MEMBERS) private readonly members: MembersService,
    @Inject(API_TOKENS) private readonly tokens: ApiTokenService,
  ) {}

  @Post()
  async create(
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodPipe(CreateBody)) body: z.infer<typeof CreateBody>,
  ): Promise<{ org: Org; role: "owner" }> {
    const p = requireUser(principal);
    const org = await this.orgs.create(body, p.account);
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
    @Body(new ZodPipe(UpdateBody)) body: z.infer<typeof UpdateBody>,
  ): Promise<{ org: Org }> {
    const p = requireUser(principal);
    return { org: await this.orgs.update(org.orgId, body, p.account) };
  }

  @Delete(":orgId")
  @OrgAction("org.delete")
  @HttpCode(204)
  async remove(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
  ): Promise<void> {
    const p = requireUser(principal);
    await this.orgs.softDelete(org.orgId, p.account);
  }

  @Post(":orgId/transfer")
  @OrgAction("org.transfer")
  @HttpCode(204)
  async transfer(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Body(new ZodPipe(TransferBody)) body: z.infer<typeof TransferBody>,
  ): Promise<void> {
    const p = requireUser(principal);
    await this.members.transferOwnership(org.orgId, p.account.id, body.toAccountId);
  }

  @Post(":orgId/leave")
  @OrgAction("org.read")
  @HttpCode(204)
  async leave(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
  ): Promise<void> {
    const p = requireUser(principal);
    await this.members.leave(org.orgId, p.account.id);
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
    @Body(new ZodPipe(RoleBody)) body: z.infer<typeof RoleBody>,
  ): Promise<{ accountId: string; role: OrgRole }> {
    const p = requireUser(principal);
    await this.members.changeRole(org.orgId, accountId, body.role, p.account.id);
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
    await this.members.remove(org.orgId, accountId, p.account.id);
  }

  @Post(":orgId/service-tokens")
  @OrgAction("org.tokens.manage")
  async createServiceToken(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Body(new ZodPipe(ServiceTokenBody)) body: z.infer<typeof ServiceTokenBody>,
  ): Promise<{ token: string; record: ApiTokenRecord }> {
    const p = requireUser(principal);
    return this.tokens.createServiceAs(org.orgId, p.account.id, body);
  }

  @Get(":orgId/service-tokens")
  @OrgAction("org.tokens.manage")
  async listServiceTokens(@CurrentOrg() org: OrgContext): Promise<ApiTokenRecord[]> {
    return this.tokens.list({ orgId: org.orgId });
  }

  @Delete(":orgId/service-tokens/:tokenId")
  @OrgAction("org.tokens.manage")
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
