import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { KernelConfig } from "../../config/schema.js";
import { KERNEL_CONFIG, OAUTH_FLOW } from "../../http/tokens.js";
import { ZodPipe } from "../../http/zod.pipe.js";
import { CurrentPrincipal, type Principal, Public, requireUser } from "../../identity/principal.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../../orgs/org.guard.js";
import {
  browserBinding,
  isSafeReturnPath,
  OAUTH_BINDING_COOKIE,
  OAUTH_CALLBACK_PATH,
  OAUTH_STATE_TTL_SECONDS,
  type OAuthFlow,
} from "./flow.js";

const ConnectBody = z
  .object({
    returnTo: z
      .string()
      .max(500)
      .refine(isSafeReturnPath, { message: "returnTo must be a relative path on this site" })
      .optional(),
  })
  .strict();

/** 查询参数只取单值字符串（重复参数 / 数组按缺失处理）。 */
const one = (v: unknown): string | undefined =>
  typeof v === "string" && v.length <= 4096 ? v : undefined;

/**
 * 发起 OAuth 连接（`POST /orgs/:orgId/apps/:appId/connect`，`apps.use`，仅用户主体）：返回授权 URL，并写浏览器绑定
 * Cookie `cap_oauth`（HttpOnly、SameSite=Lax——授权服务器回跳是跨站顶级 GET 导航、Lax 会带上；Path 只到回调）。
 */
@Controller("api/v1/orgs/:orgId/apps")
export class OAuthConnectController {
  constructor(
    @Inject(OAUTH_FLOW) private readonly flow: OAuthFlow,
    @Inject(KERNEL_CONFIG) private readonly config: () => KernelConfig,
  ) {}

  @Post(":appId/connect")
  @HttpCode(200)
  @OrgAction("apps.use")
  async connect(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("appId") appId: string,
    @Body(new ZodPipe(ConnectBody)) body: z.infer<typeof ConnectBody>,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ authorizationUrl: string }> {
    const p = requireUser(principal);
    const binding = browserBinding(req.cookies[OAUTH_BINDING_COOKIE]);
    const out = await this.flow.start(org.orgId, appId, p.account.id, body.returnTo, binding);
    reply.setCookie(OAUTH_BINDING_COOKIE, binding, {
      path: OAUTH_CALLBACK_PATH,
      httpOnly: true,
      sameSite: "lax",
      secure: this.config().auth.cookieSecure,
      maxAge: OAUTH_STATE_TTL_SECONDS,
    });
    return out;
  }
}

/**
 * 授权服务器的回跳（`GET /api/v1/oauth/callback`，公开路由：浏览器从授权服务器跳回来，会话 Cookie 可能已过期；
 * 身份由 state 与浏览器绑定 Cookie 确定）。总是 302 回网页，结果放在 `connected` / `oauth_error` 参数里。
 */
@Controller("api/v1/oauth")
export class OAuthCallbackController {
  constructor(@Inject(OAUTH_FLOW) private readonly flow: OAuthFlow) {}

  @Get("callback")
  @Public()
  async callback(
    @Query() q: Record<string, unknown>,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const location = await this.flow.callback(
      { code: one(q.code), state: one(q.state), error: one(q.error), iss: one(q.iss) },
      req.cookies[OAUTH_BINDING_COOKIE],
    );
    await reply.header("cache-control", "no-store").redirect(location, 302);
  }
}
