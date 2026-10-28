import { type CanActivate, type ExecutionContext, Inject, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { FastifyRequest } from "fastify";
import { ApiError } from "../errors.js";
import { type Account, AccountsService } from "./accounts.js";
import { ApiTokenService } from "./api-tokens.js";
import { ACCESS_COOKIE } from "./cookies.js";
import {
  ALLOW_SERVICE_KEY,
  ENTERPRISE_ADMIN_KEY,
  type Principal,
  PUBLIC_KEY,
  SESSION_ONLY_KEY,
} from "./principal.js";
import { SessionService } from "./sessions.js";

/** CSRF 头：Cookie 认证的非安全请求（及所有公开路由的非安全请求）必须带 `X-Capybara-Csrf: 1`。 */
export const CSRF_HEADER = "x-capybara-csrf";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const BEARER_RE = /^Bearer\s+(\S+)$/i;

/** 凭据解析的结果；`cookie` 为 true 表示经 Cookie 认证（需要 CSRF 检查）。 */
type Resolved = { principal: Principal; cookie: boolean } | undefined;

/** 解析凭据要用的服务（{@link AuthGuard} 与 {@link authorizeEnterpriseAdmin} 共用）。 */
export interface AuthServices {
  accounts: AccountsService;
  sessions: SessionService;
  tokens: ApiTokenService;
}

function requireCsrf(req: FastifyRequest): void {
  if (req.headers[CSRF_HEADER] !== "1") {
    throw new ApiError("auth.csrf", `Missing ${CSRF_HEADER} header`);
  }
}

/** 解析凭据；无凭据返回 undefined，凭据无效抛对应的 ApiError。 */
async function resolvePrincipal(req: FastifyRequest, s: AuthServices): Promise<Resolved> {
  const bearer = BEARER_RE.exec(req.headers.authorization ?? "")?.[1];
  if (bearer !== undefined) {
    const rec = await s.tokens.authenticate(bearer);
    if (!rec) throw new ApiError("auth.required", "Authentication required");
    if (rec.kind === "service") {
      return {
        principal: {
          kind: "service",
          tokenId: rec.id,
          orgId: rec.orgId as string,
          role: rec.role as "admin" | "member" | "guest",
        },
        cookie: false,
      };
    }
    const account = await s.accounts.get(rec.accountId as string);
    if (!account) throw new ApiError("auth.required", "Authentication required");
    return {
      principal: { kind: "user", account: requireActive(account), via: "pat", tokenId: rec.id },
      cookie: false,
    };
  }
  const at = req.cookies[ACCESS_COOKIE];
  if (at) {
    // 一条查询同时完成吊销检查与账号读取
    const { account, sessionId } = await s.sessions.verifyAccess(at);
    return {
      principal: { kind: "user", account: requireActive(account), via: "session", sessionId },
      cookie: true,
    };
  }
  return undefined;
}

/**
 * 在读请求体之前（Fastify `onRequest`）按 `@EnterpriseAdmin` 路由的规则认证：无凭据 / 凭据无效 → `auth.required`
 * 等，Cookie 认证的非安全请求要求 CSRF 头，服务令牌与非企业管理员 → `forbidden`。插件包上传用它：
 * 未认证的大请求体不被读入内存。之后 {@link AuthGuard} 照常再判一次。
 */
export async function authorizeEnterpriseAdmin(
  req: FastifyRequest,
  s: AuthServices,
): Promise<void> {
  const resolved = await resolvePrincipal(req, s);
  if (!resolved) throw new ApiError("auth.required", "Authentication required");
  if (resolved.cookie && !SAFE_METHODS.has(req.method.toUpperCase())) requireCsrf(req);
  const p = resolved.principal;
  if (p.kind === "service") {
    throw new ApiError("forbidden", "Service tokens cannot access this endpoint");
  }
  if (!p.account.isEnterpriseAdmin) throw new ApiError("forbidden", "Enterprise admin required");
}

/**
 * 全局守卫（`APP_GUARD`），默认拒绝：
 * 1. `Authorization: Bearer cap_pat_…|cap_svc_…` → API 令牌；个人令牌再实时读账号状态。不做 CSRF 检查。
 * 2. 否则 Cookie `cap_at` → 会话 access token（Redis 吊销标记作快速路径，再以 PG `sessions.revoked_at` 为准，
 *    与账号读取合并为一条查询）→ 实时判断账号状态；非安全方法要求 CSRF 头。
 * 3. 都没有：`@Public` 放行，否则 `auth.required`。`@Public` 路由上凭据无效（`ApiError`）按无凭据处理
 *    （便于登出 / 刷新）；PG / Redis 故障等其他异常照常抛出。
 * 4. 路由约束：service principal 只能访问 `@AllowService` 路由（否则 `forbidden`）；
 *    `@SessionOnly` 要求 Web 会话：个人令牌 → `auth.session_required`，服务令牌（即使路由经 `@OrgAction`
 *    隐含 `@AllowService`）→ `forbidden`；`@EnterpriseAdmin` 要求企业管理员（`forbidden`）。
 * 5. `@Public` 路由的非安全方法无论是否带 Cookie 都要求 CSRF 头。
 * 账号状态每个请求都从 PG 实时读取，不在进程内缓存。插件路由 `/plugins/*` 不经过 Nest，不受此守卫约束。
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AccountsService) readonly accounts: AccountsService,
    @Inject(SessionService) readonly sessions: SessionService,
    @Inject(ApiTokenService) readonly tokens: ApiTokenService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    const targets = [ctx.getHandler(), ctx.getClass()];
    const flag = (key: string) => this.reflector.getAllAndOverride<boolean>(key, targets) === true;
    const isPublic = flag(PUBLIC_KEY);
    const unsafe = !SAFE_METHODS.has(req.method.toUpperCase());

    if (isPublic && unsafe) requireCsrf(req);

    let resolved: Resolved;
    try {
      resolved = await resolvePrincipal(req, this);
    } catch (e) {
      // 公开路由上只把「凭据无效」（ApiError）视同未携带；PG / Redis 故障等照常抛出（500），
      // 否则故障期间带着有效 Cookie 的请求会被当作匿名放行
      if (!isPublic || !(e instanceof ApiError)) throw e;
      resolved = undefined;
    }
    if (!resolved) {
      if (isPublic) return true;
      throw new ApiError("auth.required", "Authentication required");
    }
    if (resolved.cookie && unsafe) requireCsrf(req);

    const p = resolved.principal;
    req.principal = p;
    if (isPublic) return true;
    if (p.kind === "service" && !flag(ALLOW_SERVICE_KEY)) {
      throw new ApiError("forbidden", "Service tokens cannot access this endpoint");
    }
    if (flag(SESSION_ONLY_KEY) && p.kind === "service") {
      throw new ApiError("forbidden", "Service tokens cannot access this endpoint");
    }
    if (flag(SESSION_ONLY_KEY) && !(p.kind === "user" && p.via === "session")) {
      throw new ApiError("auth.session_required", "This endpoint requires a web session");
    }
    if (flag(ENTERPRISE_ADMIN_KEY) && !(p.kind === "user" && p.account.isEnterpriseAdmin)) {
      throw new ApiError("forbidden", "Enterprise admin required");
    }
    return true;
  }
}

function requireActive(account: Account): Account {
  if (account.status !== "active") {
    throw new ApiError("auth.account_disabled", "Account is disabled");
  }
  return account;
}
