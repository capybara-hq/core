import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  Res,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { ApiError } from "../errors.js";
import type { Account } from "../identity/accounts.js";
import { clientMeta } from "../identity/auth.controller.js";
import { setSessionCookies } from "../identity/cookies.js";
import {
  CurrentPrincipal,
  type Principal,
  Public,
  patTokenId,
  requireUser,
} from "../identity/principal.js";
import { SessionService } from "../identity/sessions.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { CredentialThrottler } from "../infra/throttler/credential-throttler.js";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import { parseWithZod } from "../infra/validation/parse-with-zod.js";
import { ZBody } from "../infra/validation/zod-params.js";
import {
  INVITABLE_ROLES,
  type InvitableRole,
  type Invitation,
  type InvitationStatus,
  InvitationsService,
  MAX_INVITATION_HOURS,
} from "./invitations.service.js";
import { CurrentOrg, OrgAction, type OrgContext } from "./org.guard.js";
import type { OrgRole } from "./roles.js";

const CreateSchema = z.object({
  role: z.enum(INVITABLE_ROLES),
  expiresInHours: z.number().int().min(1).max(MAX_INVITATION_HOURS).optional(),
});
class InvitationCreateBody extends createZodDto(CreateSchema, "InvitationCreateBody") {}
/** Validated inside the handler, after the attempt is reserved (a signed-in principal sends none). */
const SignupBody = z.object({
  login: z.string(),
  password: z.string(),
  displayName: z.string().min(1).max(100),
});

/** Accepting an invitation is throttled per token (10) and per client IP (20) every 900 s. */
const ACCEPT_THROTTLERS = ["invitation", "invitation-ip"] as const;

/** 组织邀请：组织内管理（`/api/v1/orgs/:orgId/invitations`）与凭令牌预览 / 接受（`/api/v1/invitations/:token`，公开）。 */
@Controller("api/v1")
export class InvitationsController {
  constructor(
    @Inject(InvitationsService) private readonly invitations: InvitationsService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(KernelConfigService) private readonly config: KernelConfigService,
    @Inject(CredentialThrottler) private readonly throttler: CredentialThrottler,
  ) {}

  /** 令牌只在此返回一次。 */
  @Post("orgs/:orgId/invitations")
  @OrgAction("org.invitations.manage")
  async create(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZBody(InvitationCreateBody) body: z.infer<typeof CreateSchema>,
  ): Promise<{ invitation: Invitation; token: string }> {
    const p = requireUser(principal);
    return this.invitations.create(org.orgId, body, p.account.id, patTokenId(p));
  }

  @Get("orgs/:orgId/invitations")
  @OrgAction("org.invitations.manage")
  async list(
    @CurrentOrg() org: OrgContext,
  ): Promise<{ invitations: (Invitation & { status: InvitationStatus })[] }> {
    return { invitations: await this.invitations.list(org.orgId) };
  }

  @Delete("orgs/:orgId/invitations/:id")
  @OrgAction("org.invitations.manage")
  @HttpCode(204)
  async revoke(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("id") id: string,
  ): Promise<void> {
    const p = requireUser(principal);
    await this.invitations.revoke(org.orgId, id, p.account.id, patTokenId(p));
  }

  /** 公开预览：只给组织 id / 名称、角色与过期时间。 */
  @Get("invitations/:token")
  @Public()
  async preview(
    @Param("token") token: string,
  ): Promise<{ org: { id: string; name: string }; role: InvitableRole; expiresAt: Date }> {
    return this.invitations.preview(token);
  }

  /**
   * 接受邀请：已登录的 user principal 直接加入（body 可为空）；未登录则 body 必须是
   * `{ login, password, displayName }`，注册成功后创建会话并设 Cookie；service principal → `forbidden`。
   * 每次尝试先占用限流额度（scope `inv`：按令牌与客户端 IP），防止猜令牌、探测登录名与用 scrypt 拖垮服务；
   * 超限 → 429 `auth.rate_limited`，成功后退还。
   */
  @Post("invitations/:token/accept")
  @Public()
  @HttpCode(200)
  async accept(
    @Param("token") token: string,
    @CurrentPrincipal() principal: Principal | undefined,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ account: Account; orgId: string; role: OrgRole }> {
    if (principal?.kind === "service") {
      throw new ApiError("forbidden", "Service tokens cannot accept invitations");
    }
    const meta = clientMeta(req);
    await this.throttler.reserve(ACCEPT_THROTTLERS, req, reply);
    let result: { account: Account; orgId: string; role: OrgRole };
    if (principal) {
      result = await this.invitations.accept(token, { accountId: principal.account.id });
      await this.throttler.succeeded(ACCEPT_THROTTLERS, req);
    } else {
      const signup = parseWithZod(SignupBody, body);
      // 新账号、成员关系与会话行在同一事务里写入；Cookie 在提交之后才设置
      const { extra: session, ...rest } = await this.invitations.accept(
        token,
        { signup },
        (account) => this.sessions.create(account.id, meta),
      );
      if (!session) throw new Error("signup completed without a session");
      result = rest;
      await this.throttler.succeeded(ACCEPT_THROTTLERS, req);
      setSessionCookies(reply, session, this.config.get());
    }
    return result;
  }
}
