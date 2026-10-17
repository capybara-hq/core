import { createHash, timingSafeEqual } from "node:crypto";
import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { KernelConfig } from "../config/schema.js";
import { ApiError } from "../errors.js";
import { KERNEL_CONFIG, SESSIONS, SETUP } from "../http/tokens.js";
import { ZodPipe } from "../http/zod.pipe.js";
import type { Account } from "../identity/accounts.js";
import { clientMeta } from "../identity/auth.controller.js";
import { setSessionCookies } from "../identity/cookies.js";
import { MAX_PASSWORD_LENGTH } from "../identity/login.js";
import { Public } from "../identity/principal.js";
import type { SessionService } from "../identity/sessions.js";
import type { Org } from "../orgs/orgs.service.js";
import type { SetupService } from "./setup.service.js";

const SetupBody = z.object({
  login: z.string().min(1).max(64),
  password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
  displayName: z.string().trim().min(1).max(100),
  orgName: z.string().max(100).optional(),
  setupToken: z.string().max(1024).optional(),
});

const sha256 = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();

/** 常数时间比较：两边先取 SHA-256，长度恒等，不因长度不同提前返回或抛错。 */
function tokenMatches(given: string | undefined, expected: string): boolean {
  return timingSafeEqual(sha256(given ?? ""), sha256(expected)) && given !== undefined;
}

/** 初始化向导（`/api/v1/setup`，均为公开路由）。 */
@Controller("api/v1/setup")
export class SetupController {
  constructor(
    @Inject(SETUP) private readonly setup: SetupService,
    @Inject(SESSIONS) private readonly sessions: SessionService,
    @Inject(KERNEL_CONFIG) private readonly config: () => KernelConfig,
  ) {}

  @Get()
  @Public()
  async status(): Promise<{ needsSetup: boolean }> {
    return this.setup.status();
  }

  /**
   * 建首个企业管理员（可选同时建组织），成功后直接登录（设会话 Cookie）。
   * 配置了 `auth.setupToken` 时 body 中的 `setupToken` 必须与之相等，否则 `setup.token_invalid`。
   */
  @Post()
  @Public()
  @HttpCode(201)
  async complete(
    @Body(new ZodPipe(SetupBody)) body: z.infer<typeof SetupBody>,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ account: Account; org?: Org }> {
    const cfg = this.config();
    const expected = cfg.auth.setupToken;
    if (expected !== undefined && !tokenMatches(body.setupToken, expected)) {
      throw new ApiError("setup.token_invalid", "Setup token is missing or invalid");
    }
    const result = await this.setup.complete({
      login: body.login,
      password: body.password,
      displayName: body.displayName,
      orgName: body.orgName,
    });
    const session = await this.sessions.create(result.account.id, clientMeta(req));
    setSessionCookies(reply, session, cfg);
    return result;
  }
}
