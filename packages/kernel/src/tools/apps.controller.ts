import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Put,
} from "@nestjs/common";
import { z } from "zod";
import { APPS } from "../http/tokens.js";
import { ZodPipe } from "../http/zod.pipe.js";
import {
  CurrentPrincipal,
  type Principal,
  patTokenId,
  requireUser,
} from "../identity/principal.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import { can } from "../orgs/roles.js";
import type { AppDetail, AppPreview, AppSummary, AppsService, ToolIssue } from "./apps.service.js";
import { publicEndpoint } from "./endpoint.js";

/**
 * 没有 `apps.manage` 的读者只看到端点的公开部分（URL 不带 query、只有头名，见 endpoint.ts），
 * 也看不到工具的连接器数据（可能含服务器地址）。
 */
function forViewer<T extends AppSummary>(org: OrgContext, app: T): T {
  if (can(org.role, "apps.manage")) return app;
  const view: T = { ...app, endpoint: publicEndpoint(app.endpoint) };
  if ("tools" in view) {
    (view as unknown as AppDetail).tools = (view as unknown as AppDetail).tools.map((t) => ({
      ...t,
      connectorData: null,
      pending: t.pending && { ...t.pending, connectorData: null },
    }));
  }
  return view;
}

/** HTTP 头名（RFC 9110 token）。 */
const HeaderName = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/, "Invalid header name");
const Ownership = z.enum(["org", "personal"]);
/** OAuth 端点（https 等由服务按部署配置再校验）。 */
const OAuthUrl = z.url().max(2000);
/** 令牌端点的客户端认证方式（有客户端密钥时）。 */
const TokenAuthMethod = z.enum(["client_secret_basic", "client_secret_post"]);
/** OAuth scope（RFC 6749 §3.3 scope-token）。 */
const Scopes = z
  .array(
    z
      .string()
      .min(1)
      .max(200)
      .regex(/^[\x21\x23-\x5B\x5D-\x7E]+$/, "Invalid scope"),
  )
  .max(50);

/** 认证方式：只有类型与非密钥字段；凭据值走 `credential` / 凭据接口。 */
const AuthSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }).strict(),
  z.object({ type: z.literal("bearer"), ownership: Ownership }).strict(),
  z
    .object({
      type: z.literal("api_key"),
      ownership: Ownership,
      in: z.enum(["header", "query"]),
      name: z.string().min(1).max(100),
    })
    .strict()
    .refine((a) => a.in === "query" || HeaderName.safeParse(a.name).success, {
      path: ["name"],
      message: "Invalid header name",
    }),
  z.object({ type: z.literal("basic"), ownership: Ownership }).strict(),
  z
    .object({
      type: z.literal("headers"),
      ownership: Ownership,
      names: z.array(HeaderName).min(1).max(20),
    })
    .strict(),
  z
    .object({
      type: z.literal("oauth_code"),
      ownership: z.literal("personal"),
      discovery: z.enum(["mcp", "manual"]),
      authorizationUrl: OAuthUrl.optional(),
      tokenUrl: OAuthUrl.optional(),
      scopes: Scopes.optional(),
      client: z.enum(["dcr", "manual"]),
      tokenAuthMethod: TokenAuthMethod.optional(),
    })
    .strict()
    .superRefine((a, ctx) => {
      if (a.discovery === "manual") {
        for (const k of ["authorizationUrl", "tokenUrl"] as const) {
          if (a[k] === undefined)
            ctx.addIssue({ code: "custom", path: [k], message: "Required with discovery manual" });
        }
      } else {
        for (const k of ["authorizationUrl", "tokenUrl"] as const) {
          if (a[k] !== undefined)
            ctx.addIssue({
              code: "custom",
              path: [k],
              message: "Endpoints are discovered with discovery mcp; omit this field",
            });
        }
      }
      if (a.client === "dcr" && a.discovery !== "mcp") {
        ctx.addIssue({
          code: "custom",
          path: ["client"],
          message: "Dynamic client registration requires discovery mcp",
        });
      }
    }),
  z
    .object({
      type: z.literal("oauth_client"),
      ownership: z.literal("org"),
      tokenUrl: OAuthUrl,
      scopes: Scopes.optional(),
      tokenAuthMethod: TokenAuthMethod.optional(),
    })
    .strict(),
]);

/** 凭据值：形状由 `Credentials.validate` 按认证方式校验（不回显值）；这里只限大小。 */
const CredentialValue = z
  .record(z.string().max(100), z.unknown())
  .refine((v) => JSON.stringify(v).length <= 16_384, { message: "Credential is too large" });

const CreateBody = z
  .object({
    name: z.string().trim().min(1).max(80),
    slug: z.string().max(24).optional(),
    connector: z.string().min(1).max(100),
    endpoint: z.record(z.string(), z.unknown()),
    auth: AuthSchema,
    credential: CredentialValue.optional(),
  })
  .strict();

/** 预览（Ruling A20）：与创建相同的连接器 / 端点 / 认证 / 凭据，认证可缺省（只读端点描述，不列工具）。 */
const PreviewBody = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    slug: z.string().max(24).optional(),
    connector: z.string().min(1).max(100),
    endpoint: z.record(z.string(), z.unknown()),
    auth: AuthSchema.optional(),
    credential: CredentialValue.optional(),
  })
  .strict();

const ToolPatch = z
  .object({
    status: z.enum(["enabled", "disabled"]).optional(),
    defaultPolicy: z.enum(["allow", "ask", "deny"]).optional(),
  })
  .strict();

const ReviewBody = z.object({ action: z.enum(["approve", "reject"]) }).strict();

const UpdateBody = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    status: z.enum(["active", "disabled"]).optional(),
    tools: z
      .record(z.string().max(200), ToolPatch)
      .refine((v) => Object.keys(v).length <= 1000, { message: "Too many tools" })
      .optional(),
    allowUnannotated: z.boolean().optional(),
  })
  .strict();

/**
 * 应用（`/api/v1/orgs/:orgId/apps`）：读与个人凭据用 `apps.use`（访客起），安装 / 修改 / 删除 / 刷新 /
 * 组织凭据用 `apps.manage`（管理员起）；两者都仅限用户主体。
 */
@Controller("api/v1/orgs/:orgId/apps")
export class AppsController {
  constructor(@Inject(APPS) private readonly apps: AppsService) {}

  @Get()
  @OrgAction("apps.use")
  async list(@CurrentOrg() org: OrgContext): Promise<{ apps: AppSummary[] }> {
    return { apps: (await this.apps.list(org.orgId)).map((a) => forViewer(org, a)) };
  }

  @Post()
  @OrgAction("apps.manage")
  async create(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Body(new ZodPipe(CreateBody)) body: z.infer<typeof CreateBody>,
  ): Promise<{ app: AppDetail; issues: ToolIssue[] }> {
    const p = requireUser(principal);
    return this.apps.create(org.orgId, p.account.id, body, patTokenId(p));
  }

  /**
   * 预览（安装向导）：读端点描述（认证提示、操作清单）并在能认证时列出工具，什么都不写。
   * 创建与预览的请求体可带最大 2 MB 的 OpenAPI 文档，路由级 bodyLimit 见 http/app.ts。
   */
  @Post("preview")
  @HttpCode(200)
  @OrgAction("apps.manage")
  async preview(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Body(new ZodPipe(PreviewBody)) body: z.infer<typeof PreviewBody>,
  ): Promise<AppPreview> {
    requireUser(principal);
    return this.apps.preview(org.orgId, body);
  }

  @Get(":appId")
  @OrgAction("apps.use")
  async get(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("appId") appId: string,
  ): Promise<{ app: AppDetail }> {
    const p = requireUser(principal);
    return { app: forViewer(org, await this.apps.get(org.orgId, appId, p.account.id)) };
  }

  @Patch(":appId")
  @OrgAction("apps.manage")
  async update(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("appId") appId: string,
    @Body(new ZodPipe(UpdateBody)) body: z.infer<typeof UpdateBody>,
  ): Promise<{ app: AppDetail }> {
    const p = requireUser(principal);
    return { app: await this.apps.update(org.orgId, appId, p.account.id, body, patTokenId(p)) };
  }

  @Delete(":appId")
  @HttpCode(204)
  @OrgAction("apps.manage")
  async remove(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("appId") appId: string,
  ): Promise<void> {
    const p = requireUser(principal);
    await this.apps.remove(org.orgId, appId, p.account.id, patTokenId(p));
  }

  @Post(":appId/refresh")
  @HttpCode(200)
  @OrgAction("apps.manage")
  async refresh(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("appId") appId: string,
  ): Promise<{
    app: AppDetail;
    issues: ToolIssue[];
    changes: { added: string[]; removed: string[]; changed: string[] };
  }> {
    const p = requireUser(principal);
    return this.apps.refresh(org.orgId, appId, p.account.id, patTokenId(p));
  }

  /** 复核待复核的工具（漂移检测，spec 7.3）：approve 采用新定义并启用，reject 停用并保留旧定义。 */
  @Post(":appId/tools/:name/review")
  @HttpCode(200)
  @OrgAction("apps.manage")
  async review(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("appId") appId: string,
    @Param("name") name: string,
    @Body(new ZodPipe(ReviewBody)) body: z.infer<typeof ReviewBody>,
  ): Promise<{ app: AppDetail }> {
    const p = requireUser(principal);
    return {
      app: await this.apps.reviewTool(
        org.orgId,
        appId,
        name,
        body.action,
        p.account.id,
        patTokenId(p),
      ),
    };
  }

  @Put(":appId/credentials/org")
  @HttpCode(204)
  @OrgAction("apps.manage")
  async setOrgCredential(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("appId") appId: string,
    @Body(new ZodPipe(CredentialValue)) body: z.infer<typeof CredentialValue>,
  ): Promise<void> {
    const p = requireUser(principal);
    await this.apps.setCredential(org.orgId, appId, p.account.id, "org", body, patTokenId(p));
  }

  @Put(":appId/credentials/me")
  @HttpCode(204)
  @OrgAction("apps.use")
  async setMyCredential(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("appId") appId: string,
    @Body(new ZodPipe(CredentialValue)) body: z.infer<typeof CredentialValue>,
  ): Promise<void> {
    const p = requireUser(principal);
    await this.apps.setCredential(org.orgId, appId, p.account.id, "personal", body, patTokenId(p));
  }

  @Delete(":appId/credentials/me")
  @HttpCode(204)
  @OrgAction("apps.use")
  async clearMyCredential(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("appId") appId: string,
  ): Promise<void> {
    const p = requireUser(principal);
    await this.apps.clearMyCredential(org.orgId, appId, p.account.id, patTokenId(p));
  }
}
