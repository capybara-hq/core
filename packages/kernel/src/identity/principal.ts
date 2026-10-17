import { createParamDecorator, type ExecutionContext, SetMetadata } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { ApiError } from "../errors.js";
import type { Account } from "./accounts.js";

/** 一个请求的调用者：Web 会话或个人令牌代表的账号，或属于某组织的服务令牌。 */
export type Principal =
  | { kind: "user"; account: Account; via: "session"; sessionId: string }
  | { kind: "user"; account: Account; via: "pat"; tokenId: string }
  | { kind: "service"; tokenId: string; orgId: string; role: "admin" | "member" | "guest" };

/** user principal。 */
export type UserPrincipal = Extract<Principal, { kind: "user" }>;

declare module "fastify" {
  interface FastifyRequest {
    /** 由 AuthGuard 设置；`@Public` 路由上无凭据时为 undefined。 */
    principal?: Principal;
  }
}

export const PUBLIC_KEY = "capybara:auth:public";
export const SESSION_ONLY_KEY = "capybara:auth:session-only";
export const ENTERPRISE_ADMIN_KEY = "capybara:auth:enterprise-admin";
export const ALLOW_SERVICE_KEY = "capybara:auth:allow-service";

/**
 * 不要求凭据：无凭据时放行（principal 为 undefined）；带了有效凭据仍解析，无效凭据按无凭据处理。
 * 非安全方法照样要求 `X-Capybara-Csrf: 1`（防登录 CSRF）。新增公开路由必须同时更新 public-routes 元测试的清单。
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(PUBLIC_KEY, true);

/** 仅接受 Web 会话（`via: "session"`）；个人令牌 → `auth.session_required`。 */
export const SessionOnly = (): MethodDecorator => SetMetadata(SESSION_ONLY_KEY, true);

/** 仅企业管理员（user principal 且 `isEnterpriseAdmin`）；否则 `forbidden`。 */
export const EnterpriseAdmin = (): MethodDecorator & ClassDecorator =>
  SetMetadata(ENTERPRISE_ADMIN_KEY, true);

/**
 * 允许服务令牌（service principal）访问。默认拒绝：未标注的路由只接受 user principal，service → `forbidden`。
 * 组织级路由由 OrgGuard 再核对令牌所属组织与角色。
 */
export const AllowService = (): MethodDecorator & ClassDecorator =>
  SetMetadata(ALLOW_SERVICE_KEY, true);

/** 参数装饰器：取 AuthGuard 放在 `req.principal` 上的调用者。 */
export const CurrentPrincipal: () => ParameterDecorator = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) =>
    ctx.switchToHttp().getRequest<FastifyRequest>().principal,
);

/**
 * 收窄为 user principal；service → `forbidden`。
 * principal 缺失说明路由被误标 `@Public()`（非公开路由上 AuthGuard 必然已设置 principal）：
 * 抛普通 Error（500）让错误显形，而不是在 handler 里补一个 `auth.required` 掩盖它（public-routes 元测试靠此发现误标）。
 */
export function requireUser(p: Principal | undefined): UserPrincipal {
  if (!p) throw new Error("requireUser: no principal; is this route wrongly marked @Public()?");
  if (p.kind !== "user") throw new ApiError("forbidden", "This endpoint requires a user");
  return p;
}

/** 个人令牌发起的请求返回令牌 id（供审计 `actor_token_id`），Web 会话返回 undefined。 */
export function patTokenId(p: UserPrincipal): string | undefined {
  return p.via === "pat" ? p.tokenId : undefined;
}
