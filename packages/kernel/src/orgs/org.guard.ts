import {
  applyDecorators,
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
  UseGuards,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { FastifyRequest } from "fastify";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { KERNEL_DB } from "../http/tokens.js";
import { AllowService } from "../identity/principal.js";
import { type OrgAction as Action, can, HUMAN_ONLY, type OrgRole } from "./roles.js";

/** OrgGuard 放在请求上的组织上下文。 */
export interface OrgContext {
  orgId: string;
  role: OrgRole;
}

declare module "fastify" {
  interface FastifyRequest {
    /** 由 OrgGuard 设置（仅 `@OrgAction` 路由）。 */
    org?: OrgContext;
  }
}

export const ORG_ACTION_KEY = "capybara:org:action";

/**
 * 组织级路由：声明所需动作，读路径参数 `:orgId`，由 OrgGuard（在全局 AuthGuard 之后）判定。
 * 隐含 `@AllowService()`：服务令牌能到达 OrgGuard，再由它核对所属组织与 HUMAN_ONLY。
 */
export function OrgAction(action: Action): MethodDecorator & ClassDecorator {
  return applyDecorators(SetMetadata(ORG_ACTION_KEY, action), AllowService(), UseGuards(OrgGuard));
}

/** 参数装饰器：取 OrgGuard 放在 `req.org` 上的 `{ orgId, role }`。 */
export const CurrentOrg: () => ParameterDecorator = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest<FastifyRequest>().org,
);

const notFound = () => new ApiError("org.not_found", "Organization not found");

/**
 * 组织守卫：每个请求实时从 PG 读组织与成员角色（不缓存）。
 * - 组织不存在、已软删除、或调用者不是成员 → 404 `org.not_found`（不泄露组织是否存在）。
 * - user principal 的角色取 memberships；service principal 只认令牌所属组织，角色取令牌上的 role。
 * - HUMAN_ONLY 动作遇到 service principal → 403 `forbidden`；角色不足 → 403 `forbidden`。
 */
@Injectable()
export class OrgGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(KERNEL_DB) private readonly db: KernelSchemaDb,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const action = this.reflector.getAllAndOverride<Action | undefined>(ORG_ACTION_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!action) throw new Error("OrgGuard: route has no @OrgAction()");
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    const p = req.principal;
    if (!p) throw new Error("OrgGuard: no principal; is this route wrongly marked @Public()?");
    const orgId = (req.params as Record<string, string | undefined>).orgId;
    if (!orgId) throw new Error("OrgGuard: route has no :orgId parameter");

    let role: OrgRole;
    if (p.kind === "service") {
      if (p.orgId !== orgId) throw notFound();
      const live = await this.db
        .selectFrom("orgs")
        .select("id")
        .where("id", "=", orgId)
        .where("deleted_at", "is", null)
        .executeTakeFirst();
      if (!live) throw notFound();
      if (HUMAN_ONLY.has(action)) {
        throw new ApiError("forbidden", "Service tokens cannot perform this action");
      }
      role = p.role;
    } else {
      const m = await this.db
        .selectFrom("memberships")
        .innerJoin("orgs", "orgs.id", "memberships.org_id")
        .select("memberships.role")
        .where("memberships.org_id", "=", orgId)
        .where("memberships.account_id", "=", p.account.id)
        .where("orgs.deleted_at", "is", null)
        .executeTakeFirst();
      if (!m) throw notFound();
      role = m.role;
    }
    if (!can(role, action)) throw new ApiError("forbidden", "Insufficient organization role");
    req.org = { orgId, role };
    return true;
  }
}
