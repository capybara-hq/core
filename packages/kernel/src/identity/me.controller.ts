import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put } from "@nestjs/common";
import { z } from "zod";
import { ApiError } from "../errors.js";
import { ACCOUNTS, API_TOKENS, ORGS, SESSIONS } from "../http/tokens.js";
import { ZodPipe } from "../http/zod.pipe.js";
import type { OrgsService } from "../orgs/orgs.service.js";
import type { OrgRole } from "../orgs/roles.js";
import type { Account, AccountsService } from "./accounts.js";
import type { ApiTokenRecord, ApiTokenService } from "./api-tokens.js";
import { MAX_PASSWORD_LENGTH } from "./login.js";
import { CurrentPrincipal, type Principal, requireUser, SessionOnly } from "./principal.js";
import type { SessionService } from "./sessions.js";

const ChangePasswordBody = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(12).max(MAX_PASSWORD_LENGTH),
});

const TokenBody = z.object({
  name: z.string().min(1).max(100),
  expiresAt: z.coerce
    .date()
    .refine((d) => d.getTime() > Date.now(), "must be in the future")
    .optional(),
});

const CurrentOrgBody = z.object({ orgId: z.string().min(1).nullable() });

type MembershipView = { orgId: string; slug: string; name: string; role: OrgRole };

/** 当前用户（`/api/v1/me`）。 */
@Controller("api/v1/me")
export class MeController {
  constructor(
    @Inject(ACCOUNTS) private readonly accounts: AccountsService,
    @Inject(SESSIONS) private readonly sessions: SessionService,
    @Inject(ORGS) private readonly orgs: OrgsService,
    @Inject(API_TOKENS) private readonly tokens: ApiTokenService,
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
    @Body(new ZodPipe(CurrentOrgBody)) body: z.infer<typeof CurrentOrgBody>,
  ): Promise<void> {
    const p = requireUser(principal);
    if (p.via !== "session") {
      throw new ApiError("auth.session_required", "This endpoint requires a web session");
    }
    if (body.orgId !== null) {
      const mine = await this.orgs.listForAccount(p.account.id);
      if (!mine.some((o) => o.id === body.orgId)) {
        throw new ApiError("org.not_found", "Organization not found");
      }
    }
    await this.sessions.setCurrentOrg(p.sessionId, body.orgId);
  }

  /** 改密码：核对旧密码；成功后吊销该账号除当前会话外的所有会话。 */
  @Put("password")
  @SessionOnly()
  @HttpCode(204)
  async changePassword(
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodPipe(ChangePasswordBody)) body: z.infer<typeof ChangePasswordBody>,
  ): Promise<void> {
    const p = requireUser(principal);
    if (p.via !== "session") {
      throw new ApiError("auth.session_required", "This endpoint requires a web session");
    }
    if (!(await this.accounts.verifyPassword(p.account.id, body.currentPassword))) {
      throw new ApiError("auth.invalid_credentials", "Current password is incorrect");
    }
    await this.accounts.setPassword(p.account.id, body.newPassword);
    await this.sessions.revokeAllForAccount(p.account.id, p.sessionId);
  }

  @Post("tokens")
  @SessionOnly()
  async createToken(
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodPipe(TokenBody)) body: z.infer<typeof TokenBody>,
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
