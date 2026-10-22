import { PACKAGE_KINDS, type PackageKind } from "@capybara-hq/plugin-sdk";
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Res,
} from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { z } from "zod";
import { APP_INSTALLER, DIRECTORY_REQUESTS, ORG_DIRECTORY } from "../http/tokens.js";
import { ZodPipe } from "../http/zod.pipe.js";
import {
  CurrentPrincipal,
  EnterpriseAdmin,
  type Principal,
  patTokenId,
  requireUser,
} from "../identity/principal.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import { roleAtLeast } from "../orgs/roles.js";
import type { AppInstaller, AppInstallView, UninstallReport } from "./app-install.js";
import type {
  DirectoryIcon,
  OrgDirectoryDetail,
  OrgDirectoryItem,
  OrgDirectoryService,
  OrgInstallResult,
} from "./org-directory.service.js";
import type { DirectoryRequestsService, DirectoryRequestView } from "./requests.service.js";

const KindQuery = z.object({
  kind: z.enum(PACKAGE_KINDS as [PackageKind, ...PackageKind[]]).optional(),
});

const RequestBody = z
  .object({
    note: z.string().max(1000).optional(),
    version: z.string().min(1).max(256).optional(),
  })
  .strict();

const ConnectorInput = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    slug: z.string().max(24).optional(),
    endpoint: z.record(z.string(), z.unknown()).optional(),
    credential: z.record(z.string(), z.unknown()).optional(),
    client: z
      .object({
        clientId: z.string().min(1).max(500),
        clientSecret: z.string().min(1).max(4000).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const InstallBody = z
  .object({
    version: z.string().min(1).max(256).optional(),
    connector: ConnectorInput.optional(),
    app: z
      .object({
        connectors: z.record(z.string(), ConnectorInput).default({}),
        pluginConfigs: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/**
 * 条目图标的响应头：图标可能是 SVG（可含脚本），只许网页以 `<img>` 显示；直接打开时 CSP sandbox 禁止脚本与一切外部
 * 请求，nosniff 防浏览器按内容另行判型。
 */
export async function sendDirectoryIcon(reply: FastifyReply, icon: DirectoryIcon): Promise<void> {
  await reply
    .header("content-type", icon.contentType)
    .header("x-content-type-options", "nosniff")
    .header("content-security-policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'")
    .header("cache-control", "private, max-age=300")
    .send(Buffer.from(icon.data.buffer, icon.data.byteOffset, icon.data.byteLength));
}

const DecideBody = z.object({ decision: z.enum(["approve", "reject"]) }).strict();

const AdminListQuery = z.object({
  status: z.enum(["pending", "approved", "rejected", "cancelled"]).optional(),
});

/**
 * 组织视角的企业目录（`/api/v1/orgs/:orgId/...`，只接受人类用户）：
 * - `GET directory`（`directory.read`，member 起；成员看不到 disabled）；
 * - `POST directory/:itemId/requests`（`directory.request`）成员申请，进组织管理员收件箱；
 * - `POST directory/:itemId/install`：路由只要求 `directory.read`，服务在组织行锁内按种类复核 `skills.manage` /
 *   `connectors.manage` / `org.plugins.manage`（应用三者都要）；needs_approval 且没有授予 → 202 `{ request }`，否则 201；
 * - `GET / DELETE app-installs[/:installId]`（`org.plugins.manage`；卸载另在服务里复核三项）；
 * - `POST directory-requests/:id/decide`（`directory.decide`，组织管理员）。
 */
@Controller("api/v1/orgs/:orgId")
export class OrgDirectoryController {
  constructor(
    @Inject(ORG_DIRECTORY) private readonly directory: OrgDirectoryService,
    @Inject(DIRECTORY_REQUESTS) private readonly requests: DirectoryRequestsService,
    @Inject(APP_INSTALLER) private readonly apps: AppInstaller,
  ) {}

  @Get("directory")
  @OrgAction("directory.read")
  async list(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Query(new ZodPipe(KindQuery)) q: z.infer<typeof KindQuery>,
  ): Promise<{ items: OrgDirectoryItem[] }> {
    const p = requireUser(principal);
    return { items: await this.directory.list(org.orgId, p.account.id, q.kind) };
  }

  /** 条目详情与安装向导需要的内容（成员看不到 disabled，→ 404 `directory.item_not_found`）。 */
  @Get("directory/:itemId")
  @OrgAction("directory.read")
  detail(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("itemId") itemId: string,
  ): Promise<OrgDirectoryDetail> {
    const p = requireUser(principal);
    return this.directory.detail(org.orgId, p.account.id, itemId);
  }

  /**
   * 条目图标（连接器模板 / 应用；svg 或 png），见 {@link sendDirectoryIcon}。没有图标 → 404
   * `directory.icon_not_found`；成员看不到 disabled 的条目。
   */
  @Get("directory/:itemId/icon")
  @OrgAction("directory.read")
  async icon(
    @CurrentOrg() org: OrgContext,
    @Param("itemId") itemId: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const icon = await this.directory.icon(itemId, roleAtLeast(org.role, "admin"));
    await sendDirectoryIcon(reply, icon);
  }

  @Post("directory/:itemId/requests")
  @OrgAction("directory.request")
  async request(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("itemId") itemId: string,
    @Body(new ZodPipe(RequestBody)) body: z.infer<typeof RequestBody>,
  ): Promise<{ request: DirectoryRequestView; created: boolean }> {
    const p = requireUser(principal);
    const tokenId = patTokenId(p);
    return this.requests.request(
      org.orgId,
      p.account.id,
      itemId,
      body,
      tokenId !== undefined ? { actorTokenId: tokenId } : {},
    );
  }

  @Post("directory/:itemId/install")
  @OrgAction("directory.read")
  async install(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("itemId") itemId: string,
    @Body(new ZodPipe(InstallBody)) body: z.infer<typeof InstallBody>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Omit<OrgInstallResult, "status">> {
    const p = requireUser(principal);
    const r = await this.directory.install(
      org.orgId,
      p.account.id,
      itemId,
      body as Parameters<OrgDirectoryService["install"]>[3],
      patTokenId(p),
    );
    reply.status(r.status);
    const { status: _status, ...rest } = r;
    return rest;
  }

  @Get("app-installs")
  @OrgAction("org.plugins.manage")
  async listInstalls(@CurrentOrg() org: OrgContext): Promise<{ installs: AppInstallView[] }> {
    return { installs: await this.apps.list(org.orgId) };
  }

  @Delete("app-installs/:installId")
  @OrgAction("org.plugins.manage")
  async uninstall(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("installId") installId: string,
  ): Promise<UninstallReport> {
    const p = requireUser(principal);
    const tokenId = patTokenId(p);
    return this.apps.uninstall(
      org.orgId,
      p.account.id,
      installId,
      tokenId !== undefined ? { actorTokenId: tokenId } : {},
    );
  }

  @Post("directory-requests/:id/decide")
  @HttpCode(200)
  @OrgAction("directory.decide")
  async decide(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("id") id: string,
    @Body(new ZodPipe(DecideBody)) body: z.infer<typeof DecideBody>,
  ): Promise<{ request: DirectoryRequestView }> {
    const p = requireUser(principal);
    const tokenId = patTokenId(p);
    return {
      request: await this.requests.decideOrg(
        org.orgId,
        p.account.id,
        id,
        body.decision,
        tokenId !== undefined ? { actorTokenId: tokenId } : {},
      ),
    };
  }
}

/** 企业管理员处理部署级目录申请（`/api/v1/admin/directory/requests`）。 */
@Controller("api/v1/admin/directory/requests")
@EnterpriseAdmin()
export class AdminDirectoryRequestsController {
  constructor(@Inject(DIRECTORY_REQUESTS) private readonly requests: DirectoryRequestsService) {}

  @Get()
  async list(
    @Query(new ZodPipe(AdminListQuery)) q: z.infer<typeof AdminListQuery>,
  ): Promise<{ requests: DirectoryRequestView[] }> {
    return {
      requests: await this.requests.listDeployment(
        q.status !== undefined ? { status: q.status } : {},
      ),
    };
  }

  @Post(":id/decide")
  @HttpCode(200)
  async decide(
    @CurrentPrincipal() principal: Principal,
    @Param("id") id: string,
    @Body(new ZodPipe(DecideBody)) body: z.infer<typeof DecideBody>,
  ): Promise<{ request: DirectoryRequestView }> {
    const p = requireUser(principal);
    const tokenId = patTokenId(p);
    return {
      request: await this.requests.decideDeployment(
        p.account.id,
        id,
        body.decision,
        tokenId !== undefined ? { actorTokenId: tokenId } : {},
      ),
    };
  }
}
