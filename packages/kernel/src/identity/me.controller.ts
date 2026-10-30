import type { Logger } from "@capybara-hq/plugin-sdk";
import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Req,
  Res,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { ApiError } from "../errors.js";
import { CredentialThrottler } from "../infra/throttler/credential-throttler.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import { ZBody } from "../infra/validation/zod-params.js";
import { OrgsService } from "../orgs/orgs.service.js";
import type { OrgRole } from "../orgs/roles.js";
import { type Account, AccountsService } from "./accounts.js";
import { type ApiTokenRecord, ApiTokenService, FutureIsoDate } from "./api-tokens.js";
import { MAX_PASSWORD_LENGTH } from "./login.js";
import { CurrentPrincipal, type Principal, requireUser, SessionOnly } from "./principal.js";
import { SessionService } from "./sessions.js";

/** The credential throttlers of a password change (per account, per client IP). */
const CHANGE_PASSWORD_THROTTLERS = ["change-password", "change-password-ip"] as const;

const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(12).max(MAX_PASSWORD_LENGTH),
});
class ChangePasswordBody extends createZodDto(ChangePasswordSchema, "ChangePasswordBody") {}

const TokenSchema = z.object({
  name: z.string().min(1).max(100),
  expiresAt: FutureIsoDate.optional(),
});
class PersonalTokenBody extends createZodDto(TokenSchema, "PersonalTokenBody") {}

const CurrentOrgSchema = z.object({ orgId: z.string().min(1).nullable() });
class CurrentOrgBody extends createZodDto(CurrentOrgSchema, "CurrentOrgBody") {}

type MembershipView = { orgId: string; slug: string; name: string; role: OrgRole };

/** 当前用户（`/api/v1/me`）。 */
@Controller("api/v1/me")
export class MeController {
  constructor(
    @Inject(AccountsService) private readonly accounts: AccountsService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(OrgsService) private readonly orgs: OrgsService,
    @Inject(ApiTokenService) private readonly tokens: ApiTokenService,
    @Inject(CredentialThrottler) private readonly throttler: CredentialThrottler,
    @Inject(KERNEL_LOGGER) private readonly log: Logger,
  ) {}

  @Get()
  async me(@CurrentPrincipal() principal: Principal): Promise<{
    account: Account;
    via: "session" | "pat";
    currentOrgId: string | null;
    memberships: MembershipView[];
  }> {
    const p = requireUser(principal);
    const currentOrgId =
      p.via === "session" ? ((await this.sessions.get(p.sessionId))?.currentOrgId ?? null) : null;
    const memberships = (await this.orgs.listForAccount(p.account.id)).map((o) => ({
      orgId: o.id,
      slug: o.slug,
      name: o.name,
      role: o.role,
    }));
    return { account: p.account, via: p.via, currentOrgId, memberships };
  }

  /** 切换当前组织（仅 Web 会话）；`null` 清空。非成员或已软删除的组织 → `org.not_found`。 */
  @Put("current-org")
  @SessionOnly()
  @HttpCode(204)
  async setCurrentOrg(
    @CurrentPrincipal() principal: Principal,
    @ZBody(CurrentOrgBody) body: z.infer<typeof CurrentOrgSchema>,
  ): Promise<void> {
    const p = requireUser(principal);
    if (p.via !== "session") {
      throw new ApiError("auth.session_required", "This endpoint requires a web session");
    }
    await this.sessions.switchCurrentOrg(p.sessionId, p.account.id, body.orgId);
  }

  /**
   * 改密码：核对旧密码；成功后吊销该账号除当前会话外的所有会话，并吊销其全部个人访问令牌（R24）——
   * 三者在同一个 PG 事务里生效，之后再尽力写 Redis 吊销标记。
   * Before the check one attempt is reserved (per account id 10, per client IP 50, apart from the
   * login IP budget), so a stolen session cannot guess the old password forever; over the limit →
   * 429 `auth.rate_limited`; a successful check clears the account counter.
   */
  @Put("password")
  @SessionOnly()
  @HttpCode(204)
  async changePassword(
    @CurrentPrincipal() principal: Principal,
    @ZBody(ChangePasswordBody) body: z.infer<typeof ChangePasswordSchema>,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    const p = requireUser(principal);
    if (p.via !== "session") {
      throw new ApiError("auth.session_required", "This endpoint requires a web session");
    }
    await this.throttler.reserve(CHANGE_PASSWORD_THROTTLERS, req, reply);
    if (!(await this.accounts.verifyPassword(p.account.id, body.currentPassword))) {
      throw new ApiError("auth.invalid_credentials", "Current password is incorrect");
    }
    await this.throttler.succeeded(CHANGE_PASSWORD_THROTTLERS, req);
    // 新密码、吊销其他会话（PG revoked_at）与个人令牌在同一个 PG 事务里完成
    const revoked = await this.accounts.changePassword(p.account.id, body.newPassword, p.sessionId);
    try {
      await this.sessions.markRevoked(revoked);
    } catch (err) {
      // Redis 标记只是快速路径：鉴权每次都查 PG revoked_at，这些会话已经无法使用
      this.log.warn("failed to write session revocation markers after password change", {
        accountId: p.account.id,
        err,
      });
    }
  }

  @Post("tokens")
  @SessionOnly()
  async createToken(
    @CurrentPrincipal() principal: Principal,
    @ZBody(PersonalTokenBody) body: z.infer<typeof TokenSchema>,
  ): Promise<{ token: string; record: ApiTokenRecord }> {
    const p = requireUser(principal);
    return this.tokens.createPersonal(p.account.id, body);
  }

  @Get("tokens")
  @SessionOnly()
  async listTokens(
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ tokens: ApiTokenRecord[] }> {
    const p = requireUser(principal);
    return { tokens: await this.tokens.list({ accountId: p.account.id }) };
  }

  @Delete("tokens/:tokenId")
  @SessionOnly()
  @HttpCode(204)
  async revokeToken(
    @CurrentPrincipal() principal: Principal,
    @Param("tokenId") tokenId: string,
  ): Promise<void> {
    const p = requireUser(principal);
    await this.tokens.revoke(tokenId, { accountId: p.account.id });
  }
}
