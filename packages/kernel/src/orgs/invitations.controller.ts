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
import type { KernelConfig } from "../config/schema.js";
import { ApiError } from "../errors.js";
import { INVITATIONS, KERNEL_CONFIG, RATE_LIMITER, SESSIONS } from "../http/tokens.js";
import { ZodPipe } from "../http/zod.pipe.js";
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
import type { LoginRateLimiter } from "../identity/rate-limit.js";
import type { SessionService } from "../identity/sessions.js";
import {
  INVITABLE_ROLES,
  type InvitableRole,
  type Invitation,
  type InvitationStatus,
  type InvitationsService,
  MAX_INVITATION_HOURS,
} from "./invitations.service.js";
import { CurrentOrg, OrgAction, type OrgContext } from "./org.guard.js";
import type { OrgRole } from "./roles.js";

const CreateBody = z.object({
  role: z.enum(INVITABLE_ROLES),
  expiresInHours: z.number().int().min(1).max(MAX_INVITATION_HOURS).optional(),
});
const SignupBody = z.object({
  login: z.string(),
  password: z.string(),
  displayName: z.string().min(1).max(100),
});
const signupPipe = new ZodPipe(SignupBody);

/** 接受邀请的限流（scope `inv`）：同一令牌 10 次、同一客户端 IP 20 次 / 900s。 */
const ACCEPT_LIMIT_PER_TOKEN = 10;
const ACCEPT_LIMIT_PER_IP = 20;

/** 组织邀请：组织内管理（`/api/v1/orgs/:orgId/invitations`）与凭令牌预览 / 接受（`/api/v1/invitations/:token`，公开）。 */
@Controller("api/v1")
export class InvitationsController {
  constructor(
    @Inject(INVITATIONS) private readonly invitations: InvitationsService,
    @Inject(SESSIONS) private readonly sessions: SessionService,
    @Inject(KERNEL_CONFIG) private readonly config: () => KernelConfig,
    @Inject(RATE_LIMITER) private readonly limiter: LoginRateLimiter,
  ) {}

  /** 令牌只在此返回一次。 */
  @Post("orgs/:orgId/invitations")
  @OrgAction("org.invitations.manage")
  async create(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Body(new ZodPipe(CreateBody)) body: z.infer<typeof CreateBody>,
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
    const rl = await this.limiter.reserveScoped(
      "inv",
      token,
      meta.ip,
      ACCEPT_LIMIT_PER_TOKEN,
      ACCEPT_LIMIT_PER_IP,
    );
    if (!rl.allowed) {
      reply.header("retry-after", String(rl.retryAfterSeconds));
      throw new ApiError("auth.rate_limited", "Too many invitation attempts; try again later");
    }
    let result: { account: Account; orgId: string; role: OrgRole };
    if (principal) {
      result = await this.invitations.accept(token, { accountId: principal.account.id });
    } else {
      const signup = signupPipe.transform(body);
      result = await this.invitations.accept(token, { signup });
    }
    await this.limiter.succeededScoped("inv", token, meta.ip);
    if (!principal) {
      const session = await this.sessions.create(result.account.id, meta);
      setSessionCookies(reply, session, this.config());
    }
    return result;
  }
}
