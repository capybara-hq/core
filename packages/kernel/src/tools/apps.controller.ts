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
import type { AppDetail, AppSummary, AppsService, ToolIssue } from "./apps.service.js";

/** HTTP 头名（RFC 9110 token）。 */
const HeaderName = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/, "Invalid header name");
const Ownership = z.enum(["org", "personal"]);

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

const ToolPatch = z
  .object({
    status: z.enum(["enabled", "disabled"]).optional(),
    defaultPolicy: z.enum(["allow", "ask", "deny"]).optional(),
  })
  .strict();

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
    return { apps: await this.apps.list(org.orgId) };
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

  @Get(":appId")
  @OrgAction("apps.use")
  async get(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("appId") appId: string,
  ): Promise<{ app: AppDetail }> {
    const p = requireUser(principal);
    return { app: await this.apps.get(org.orgId, appId, p.account.id) };
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
