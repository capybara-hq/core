import { Body, Controller, Get, HttpCode, Inject, Put } from "@nestjs/common";
import { z } from "zod";
import { ApiError } from "../errors.js";
import { ACCOUNTS, SESSIONS } from "../http/tokens.js";
import { ZodPipe } from "../http/zod.pipe.js";
import type { Account, AccountsService } from "./accounts.js";
import { MAX_PASSWORD_LENGTH } from "./login.js";
import { CurrentPrincipal, type Principal, requireUser, SessionOnly } from "./principal.js";
import type { SessionService } from "./sessions.js";

const ChangePasswordBody = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(12).max(MAX_PASSWORD_LENGTH),
});

/** 当前用户（`/api/v1/me`）。 */
@Controller("api/v1/me")
export class MeController {
  constructor(
    @Inject(ACCOUNTS) private readonly accounts: AccountsService,
    @Inject(SESSIONS) private readonly sessions: SessionService,
  ) {}

  @Get()
  async me(
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ account: Account; via: "session" | "pat"; currentOrgId: string | null }> {
    const p = requireUser(principal);
    const currentOrgId =
      p.via === "session" ? ((await this.sessions.get(p.sessionId))?.currentOrgId ?? null) : null;
    return { account: p.account, via: p.via, currentOrgId };
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
}
