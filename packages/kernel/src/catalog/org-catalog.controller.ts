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
import { CATALOG_REQUESTS, ORG_CATALOG, PLUGIN_INSTALLER } from "../http/tokens.js";
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
import { CredentialValue } from "../tools/connectors.controller.js";
import type {
  CatalogIcon,
  OrgCatalogDetail,
  OrgCatalogItem,
  OrgCatalogService,
  OrgInstallResult,
} from "./org-catalog.service.js";
import type { PluginInstaller, PluginInstallView, UninstallReport } from "./plugin-install.js";
import type { CatalogRequestsService, CatalogRequestView } from "./requests.service.js";

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
    credential: CredentialValue.optional(),
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
    plugin: z
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
export async function sendCatalogIcon(reply: FastifyReply, icon: CatalogIcon): Promise<void> {
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
 * The enterprise catalog from an organization's view (`/api/v1/orgs/:orgId/...`, human users only):
 * - `GET catalog` (`catalog.read`, member and up; members do not see disabled items);
 * - `POST catalog/:itemId/requests` (`catalog.request`): a member request, into the org admins'
 *   inbox;
 * - `POST catalog/:itemId/install`: the route only requires `catalog.read`; the service re-checks
 *   `skills.manage` / `connectors.manage` / `org.plugins.manage` by kind inside the org row lock
 *   (plugins need all three); needs_approval without a grant -> 202 `{ request }`, otherwise 201;
 * - `GET / DELETE plugin-installs[/:installId]` (`org.plugins.manage`; uninstall re-checks all
 *   three in the service);
 * - `POST catalog-requests/:id/decide` (`catalog.decide`, org admins).
 */
@Controller("api/v1/orgs/:orgId")
export class OrgCatalogController {
  constructor(
    @Inject(ORG_CATALOG) private readonly catalog: OrgCatalogService,
    @Inject(CATALOG_REQUESTS) private readonly requests: CatalogRequestsService,
    @Inject(PLUGIN_INSTALLER) private readonly pluginInstaller: PluginInstaller,
  ) {}

  @Get("catalog")
  @OrgAction("catalog.read")
  async list(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Query(new ZodPipe(KindQuery)) q: z.infer<typeof KindQuery>,
  ): Promise<{ items: OrgCatalogItem[] }> {
    const p = requireUser(principal);
    return { items: await this.catalog.list(org.orgId, p.account.id, q.kind) };
  }

  /**
   * Item detail and what the install wizard needs (members do not see disabled items -> 404
   * `catalog.item_not_found`).
   */
  @Get("catalog/:itemId")
  @OrgAction("catalog.read")
  detail(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("itemId") itemId: string,
  ): Promise<OrgCatalogDetail> {
    const p = requireUser(principal);
    return this.catalog.detail(org.orgId, p.account.id, itemId);
  }

  /**
   * The item's icon (connector templates / plugins; svg or png), see {@link sendCatalogIcon}. No icon
   * -> 404 `catalog.icon_not_found`; members do not see disabled items.
   */
  @Get("catalog/:itemId/icon")
  @OrgAction("catalog.read")
  async icon(
    @CurrentOrg() org: OrgContext,
    @Param("itemId") itemId: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const icon = await this.catalog.icon(itemId, roleAtLeast(org.role, "admin"));
    await sendCatalogIcon(reply, icon);
  }

  @Post("catalog/:itemId/requests")
  @OrgAction("catalog.request")
  async request(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("itemId") itemId: string,
    @Body(new ZodPipe(RequestBody)) body: z.infer<typeof RequestBody>,
  ): Promise<{ request: CatalogRequestView; created: boolean }> {
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

  @Post("catalog/:itemId/install")
  @OrgAction("catalog.read")
  async install(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("itemId") itemId: string,
    @Body(new ZodPipe(InstallBody)) body: z.infer<typeof InstallBody>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Omit<OrgInstallResult, "status">> {
    const p = requireUser(principal);
    const r = await this.catalog.install(
      org.orgId,
      p.account.id,
      itemId,
      body as Parameters<OrgCatalogService["install"]>[3],
      patTokenId(p),
    );
    reply.status(r.status);
    const { status: _status, ...rest } = r;
    return rest;
  }

  @Get("plugin-installs")
  @OrgAction("org.plugins.manage")
  async listInstalls(@CurrentOrg() org: OrgContext): Promise<{ installs: PluginInstallView[] }> {
    return { installs: await this.pluginInstaller.list(org.orgId) };
  }

  @Delete("plugin-installs/:installId")
  @OrgAction("org.plugins.manage")
  async uninstall(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("installId") installId: string,
  ): Promise<UninstallReport> {
    const p = requireUser(principal);
    const tokenId = patTokenId(p);
    return this.pluginInstaller.uninstall(
      org.orgId,
      p.account.id,
      installId,
      tokenId !== undefined ? { actorTokenId: tokenId } : {},
    );
  }

  @Post("catalog-requests/:id/decide")
  @HttpCode(200)
  @OrgAction("catalog.decide")
  async decide(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("id") id: string,
    @Body(new ZodPipe(DecideBody)) body: z.infer<typeof DecideBody>,
  ): Promise<{ request: CatalogRequestView }> {
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

/** Enterprise admins decide deployment-level catalog requests (`/api/v1/admin/catalog/requests`). */
@Controller("api/v1/admin/catalog/requests")
@EnterpriseAdmin()
export class AdminCatalogRequestsController {
  constructor(@Inject(CATALOG_REQUESTS) private readonly requests: CatalogRequestsService) {}

  @Get()
  async list(
    @Query(new ZodPipe(AdminListQuery)) q: z.infer<typeof AdminListQuery>,
  ): Promise<{ requests: CatalogRequestView[] }> {
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
  ): Promise<{ request: CatalogRequestView }> {
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
