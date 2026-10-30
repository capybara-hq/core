import { Controller, HttpCode, Inject, Post, Req, Res } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { ApiError } from "../errors.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { CredentialThrottler } from "../infra/throttler/credential-throttler.js";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import { ZBody } from "../infra/validation/zod-params.js";
import { type Account, AccountsService } from "./accounts.js";
import {
  ACCESS_COOKIE,
  clearSessionCookies,
  REFRESH_COOKIE,
  setSessionCookies,
} from "./cookies.js";
import { Public } from "./principal.js";
import { SessionService } from "./sessions.js";

const LoginBodySchema = z.object({ login: z.string().max(256), password: z.string() });
class LoginBody extends createZodDto(LoginBodySchema, "LoginBody") {}

/** The credential throttlers of a login attempt (R25: per (login, IP), per IP, per login). */
const LOGIN_THROTTLERS = ["login", "login-ip", "login-account"] as const;

/** 会话的客户端信息（记入 sessions 表）。`req.ip` 在 `http.trustProxy` 时取自 X-Forwarded-For。 */
export function clientMeta(req: FastifyRequest): { userAgent?: string; ip: string } {
  const ua = req.headers["user-agent"];
  return { ip: req.ip, ...(ua !== undefined && { userAgent: ua }) };
}

/** 本地登录、刷新与登出（`/api/v1/auth/*`，均为公开路由）。 */
@Controller("api/v1/auth")
export class AuthController {
  constructor(
    @Inject(AccountsService) private readonly accounts: AccountsService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(CredentialThrottler) private readonly throttler: CredentialThrottler,
    @Inject(KernelConfigService) private readonly config: KernelConfigService,
  ) {}

  /**
   * An unknown login and a wrong password answer the same error. Every attempt first reserves one
   * attempt on the (login, IP), IP and login counters atomically; success clears the login
   * counters and gives the IP attempt back (`CredentialThrottler`).
   */
  @Post("login")
  @Public()
  @HttpCode(200)
  async login(
    @ZBody(LoginBody) body: z.infer<typeof LoginBodySchema>,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ account: Account }> {
    const meta = clientMeta(req);
    // reserve before checking the password, atomically: concurrent requests cannot pass the limit
    await this.throttler.reserve(LOGIN_THROTTLERS, req, reply);
    let account: Account | null;
    try {
      account = await this.accounts.authenticateLocal(body.login, body.password);
    } catch (e) {
      // a disabled account's password is right (authenticateLocal checks it before the status):
      // not a failed attempt, the reservation is given back
      if (e instanceof ApiError && e.code === "auth.account_disabled") {
        await this.throttler.succeeded(LOGIN_THROTTLERS, req);
      }
      throw e;
    }
    if (!account) throw new ApiError("auth.invalid_credentials", "Invalid login or password");
    await this.throttler.succeeded(LOGIN_THROTTLERS, req);
    const session = await this.sessions.create(account.id, meta);
    setSessionCookies(reply, session, this.config.get());
    return { account };
  }

  /**
   * 用 `cap_rt` 换新的一对 Cookie。失败时清 Cookie；但 `auth.refresh_race` 不清——
   * 并发的另一个请求刚换到了新 Cookie，这里清掉会覆盖它。
   */
  @Post("refresh")
  @Public()
  @HttpCode(200)
  async refresh(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ account: Account }> {
    try {
      const rt = req.cookies[REFRESH_COOKIE];
      if (!rt) throw new ApiError("auth.refresh_invalid", "Refresh token is missing");
      const session = await this.sessions.refresh(rt, clientMeta(req));
      const account = await this.accounts.get(session.accountId);
      if (!account) throw new ApiError("auth.refresh_invalid", "Refresh token is invalid");
      setSessionCookies(reply, session, this.config.get());
      return { account };
    } catch (e) {
      if (!(e instanceof ApiError && e.code === "auth.refresh_race")) clearSessionCookies(reply);
      throw e;
    }
  }

  /** 吊销 Cookie 对应的会话（access token 过期也接受，验签失败忽略），总是清 Cookie。 */
  @Post("logout")
  @Public()
  @HttpCode(204)
  async logout(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    clearSessionCookies(reply);
    const at = req.cookies[ACCESS_COOKIE];
    const rt = req.cookies[REFRESH_COOKIE];
    if (at) {
      const sid = await this.sessions.sessionIdFromAccess(at);
      if (sid !== undefined) await this.sessions.revoke(sid);
    }
    if (rt) await this.sessions.revokeByRefresh(rt);
  }
}
