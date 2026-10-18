import { Body, Controller, HttpCode, Inject, Post, Req, Res } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { KernelConfig } from "../config/schema.js";
import { ApiError } from "../errors.js";
import { ACCOUNTS, KERNEL_CONFIG, RATE_LIMITER, SESSIONS } from "../http/tokens.js";
import { ZodPipe } from "../http/zod.pipe.js";
import type { Account, AccountsService } from "./accounts.js";
import {
  ACCESS_COOKIE,
  clearSessionCookies,
  REFRESH_COOKIE,
  setSessionCookies,
} from "./cookies.js";
import { Public } from "./principal.js";
import type { LoginRateLimiter } from "./rate-limit.js";
import type { SessionService } from "./sessions.js";

const LoginBody = z.object({ login: z.string().max(256), password: z.string() });

/** 会话的客户端信息（记入 sessions 表）。`req.ip` 在 `http.trustProxy` 时取自 X-Forwarded-For。 */
export function clientMeta(req: FastifyRequest): { userAgent?: string; ip: string } {
  const ua = req.headers["user-agent"];
  return { ip: req.ip, ...(ua !== undefined && { userAgent: ua }) };
}

/** 本地登录、刷新与登出（`/api/v1/auth/*`，均为公开路由）。 */
@Controller("api/v1/auth")
export class AuthController {
  constructor(
    @Inject(ACCOUNTS) private readonly accounts: AccountsService,
    @Inject(SESSIONS) private readonly sessions: SessionService,
    @Inject(RATE_LIMITER) private readonly limiter: LoginRateLimiter,
    @Inject(KERNEL_CONFIG) private readonly config: () => KernelConfig,
  ) {}

  /**
   * 登录名不存在与密码错误返回同一错误；每次尝试先按（登录名, IP）、IP、登录名三个计数原子占用限流额度，
   * 成功后清零登录名计数并退还 IP 额度（见 LoginRateLimiter）。
   */
  @Post("login")
  @Public()
  @HttpCode(200)
  async login(
    @Body(new ZodPipe(LoginBody)) body: z.infer<typeof LoginBody>,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ account: Account }> {
    const meta = clientMeta(req);
    // 校验密码之前先原子地占用一次尝试额度：并发请求也无法绕过上限
    const rl = await this.limiter.reserve(body.login, meta.ip);
    if (!rl.allowed) {
      reply.header("retry-after", String(rl.retryAfterSeconds));
      throw new ApiError("auth.rate_limited", "Too many failed login attempts; try again later");
    }
    let account: Account | null;
    try {
      account = await this.accounts.authenticateLocal(body.login, body.password);
    } catch (e) {
      // 停用账号的密码是对的（authenticateLocal 先核对密码再看状态）：不算失败尝试，退还占用的额度
      if (e instanceof ApiError && e.code === "auth.account_disabled") {
        await this.limiter.succeeded(body.login, meta.ip);
      }
      throw e;
    }
    if (!account) throw new ApiError("auth.invalid_credentials", "Invalid login or password");
    await this.limiter.succeeded(body.login, meta.ip);
    const session = await this.sessions.create(account.id, meta);
    setSessionCookies(reply, session, this.config());
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
      setSessionCookies(reply, session, this.config());
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
