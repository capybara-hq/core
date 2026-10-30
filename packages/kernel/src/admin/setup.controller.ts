import { createHash, timingSafeEqual } from "node:crypto";
import { Controller, Get, HttpCode, Inject, Post, Req, Res } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { ApiError } from "../errors.js";
import type { Account } from "../identity/accounts.js";
import { clientMeta } from "../identity/auth.controller.js";
import { setSessionCookies } from "../identity/cookies.js";
import { MAX_PASSWORD_LENGTH } from "../identity/login.js";
import { Public } from "../identity/principal.js";
import { SessionService } from "../identity/sessions.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { CredentialThrottler } from "../infra/throttler/credential-throttler.js";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import { ZBody } from "../infra/validation/zod-params.js";
import type { Org } from "../orgs/orgs.service.js";
import { SetupService } from "./setup.service.js";

const SetupSchema = z.object({
  login: z.string().min(1).max(64),
  password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
  displayName: z.string().trim().min(1).max(100),
  orgName: z.string().max(100).optional(),
  setupToken: z.string().max(1024).optional(),
});
class SetupBody extends createZodDto(SetupSchema, "SetupBody") {}

/**
 * The setup token's credential throttlers: 10 per client IP, 100 for the whole deployment per
 * 900 s (the total stops guessing from many IPs; a long token never hits it in normal use).
 */
const SETUP_THROTTLERS = ["setup-token", "setup-ip"] as const;

const sha256 = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();

/** 常数时间比较：两边先取 SHA-256，长度恒等，不因长度不同提前返回或抛错。 */
function tokenMatches(given: string | undefined, expected: string): boolean {
  return timingSafeEqual(sha256(given ?? ""), sha256(expected)) && given !== undefined;
}

/** 初始化向导（`/api/v1/setup`，均为公开路由）。 */
@Controller("api/v1/setup")
export class SetupController {
  constructor(
    @Inject(SetupService) private readonly setup: SetupService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(KernelConfigService) private readonly config: KernelConfigService,
    @Inject(CredentialThrottler) private readonly throttler: CredentialThrottler,
  ) {}

  @Get()
  @Public()
  async status(): Promise<{ needsSetup: boolean }> {
    return this.setup.status();
  }

  /**
   * 建首个企业管理员（可选同时建组织），成功后直接登录（设会话 Cookie）。
   * 配置了 `auth.setupToken` 时 body 中的 `setupToken` 必须与之相等，否则 `setup.token_invalid`；
   * 核对前先占用限流额度，超限 → 429 `auth.rate_limited`，核对通过后退还。
   */
  @Post()
  @Public()
  @HttpCode(201)
  async complete(
    @ZBody(SetupBody) body: z.infer<typeof SetupSchema>,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ account: Account; org?: Org }> {
    const cfg = this.config.get();
    const expected = cfg.auth.setupToken;
    if (expected !== undefined) {
      await this.throttler.reserve(SETUP_THROTTLERS, req, reply);
      if (!tokenMatches(body.setupToken, expected)) {
        throw new ApiError("setup.token_invalid", "Setup token is missing or invalid");
      }
      await this.throttler.succeeded(SETUP_THROTTLERS, req);
    }
    // 会话行与账号 / 组织在同一事务里写入；Cookie 在提交之后才设置
    const meta = clientMeta(req);
    const { extra: session, ...result } = await this.setup.complete(
      {
        login: body.login,
        password: body.password,
        displayName: body.displayName,
        orgName: body.orgName,
      },
      // runs in the setup's transaction
      (account) => this.sessions.create(account.id, meta),
    );
    if (!session) throw new Error("setup completed without a session");
    setSessionCookies(reply, session, cfg);
    return result;
  }
}
