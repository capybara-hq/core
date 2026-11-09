import { Controller, Delete, Get, HttpCode, Inject, Param, Post, Put, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { z } from "zod";
import { PluginGuides, type RenderedSetupGuide } from "../extensions/plugin-guides.js";
import { orgIconScope, PluginIcons } from "../extensions/plugin-icons.js";
import {
  CurrentPrincipal,
  type Principal,
  patTokenId,
  requireUser,
  SuperAdmin,
} from "../identity/principal.js";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import { ZBody, ZQuery } from "../infra/validation/zod-params.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import { roleAtLeast } from "../orgs/roles.js";
import type { ConnectorDetail, ToolIssue } from "../tools/connectors.service.js";
import type { MarketplaceImportResult } from "./catalog.service.js";
import type {
  CatalogIcon,
  OrgCatalogDetail,
  OrgCatalogItem,
  OrgInstallResult,
} from "./catalog-content.js";
import {
  CatalogConnectorInput,
  CatalogGuideQuery,
  CatalogMarketplaceRequestBody,
  CatalogRequestBody,
  CatalogRequestsListQuery,
  OrgPluginInstallBody,
  OrgPluginSwitchBody,
} from "./org-catalog.schemas.js";
import { OrgCatalogService, type SwitchResult } from "./org-catalog.service.js";
import {
  PluginInstaller,
  type PluginInstallView,
  type UninstallPreview,
  type UninstallReport,
} from "./plugin-install.js";
import { CatalogRequestsService, type CatalogRequestView } from "./requests.service.js";

/** The connectors body (ruling P2-10): the input of missing connectors, by template id, as at install. */
const ConnectorsBody = z
  .object({
    inputs: z.object({ connectors: z.record(z.string(), CatalogConnectorInput) }).strict(),
  })
  .strict();

/**
 * One more connector from a platform connector template (ruling P4-T6-8): its name and an
 * install's connector input (`config`).
 */
const TemplateConnectorBody = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    config: CatalogConnectorInput.omit({ name: true }),
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

const DecideBody = z
  .object({ approve: z.boolean(), reason: z.string().max(1000).optional() })
  .strict();

class CatalogGuideQueryDto extends createZodDto(CatalogGuideQuery, "CatalogGuideQuery") {}
class CatalogRequestsQuery extends createZodDto(CatalogRequestsListQuery, "CatalogRequestsQuery") {}
class CatalogDecideBody extends createZodDto(DecideBody, "CatalogDecideBody") {}
class OrgPluginInstallBodyDto extends createZodDto(OrgPluginInstallBody, "OrgPluginInstallBody") {}
class OrgPluginConnectorsBody extends createZodDto(ConnectorsBody, "OrgPluginConnectorsBody") {}
class OrgPluginSwitchBodyDto extends createZodDto(OrgPluginSwitchBody, "OrgPluginSwitchBody") {}
class OrgTemplateConnectorBody extends createZodDto(
  TemplateConnectorBody,
  "OrgTemplateConnectorBody",
) {}
class CatalogRequestBodyDto extends createZodDto(CatalogRequestBody, "CatalogRequestBody") {}
class CatalogMarketplaceRequestBodyDto extends createZodDto(
  CatalogMarketplaceRequestBody,
  "CatalogMarketplaceRequestBody",
) {}

/**
 * The platform catalog from an organization's view (`/api/v1/orgs/:orgId/...`, human users only):
 * - `GET catalog` (`catalog.read`, member and up; members do not see disabled items);
 * - `POST catalog/:itemId/requests` (`catalog.request`; `access` needs an org admin): requests
 *   under plugin scope (spec §5.1), `enable` into the org admins' inbox, `access` to the super
 *   admin; `POST marketplace-requests` (org admins): an `import` request for a marketplace entry;
 * - `PUT catalog/:itemId/switch` (scope phase 1): `{ enabled: true, inputs? }` installs -> 200 `{ item }`;
 *   `{ enabled: false, confirm? }` -> 200 `{ preview, confirm }`, then with the hash 200 `{ item }`;
 * - `POST catalog/:itemId/install` (an alias of switching on, no longer creates requests): the route only requires `catalog.read`; the service re-checks
 *   the plugin's component actions (`org.extensions.manage` for an extension, `connectors.manage`
 *   for templates, `skills.manage` for skills) inside the org row lock; needs_approval without a
 *   grant -> 202 `{ request }`, otherwise 201 `{ installed, install }` (the install view);
 * - `GET / DELETE plugin-installs[/:installId]` (`org.extensions.manage`; uninstall re-checks the
 *   plugin's component actions in the service);
 * - no per-org upgrade: a platform plugin has one version for the deployment, updated by the super
 *   admin (`PUT /admin/catalog/items/:id/update`, ruling F2);
 * - `POST connector-templates/:templateId/connectors` (`connectors.manage`): one more connector
 *   from a platform connector template on in the org (ruling P4-T6-8);
 * - `POST catalog-requests/:id/decide` (`catalog.decide`, org admins; `enable` and
 *   `connector_setup` requests, `{ approve, reason? }`; a `connector_setup` request is only
 *   rejected here, ruling P4-T6-6), `POST catalog-requests/:id/dismiss` (the requester, a decided
 *   request).
 */
@Controller("api/v1/orgs/:orgId")
export class OrgCatalogController {
  constructor(
    @Inject(OrgCatalogService) private readonly catalog: OrgCatalogService,
    @Inject(CatalogRequestsService) private readonly requests: CatalogRequestsService,
    @Inject(PluginInstaller) private readonly pluginInstaller: PluginInstaller,
    @Inject(PluginIcons) private readonly icons: PluginIcons,
    @Inject(PluginGuides) private readonly guides: PluginGuides,
  ) {}

  /** The org's catalog; each item carries `icon`, its icon's URL here (null without one). */
  @Get("catalog")
  @OrgAction("catalog.read")
  async list(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
  ): Promise<{ items: (OrgCatalogItem & { icon: string | null })[] }> {
    const p = requireUser(principal);
    const items = await this.catalog.list(org.orgId, p.account.id);
    const icons = await this.icons.ofItems(
      items.map((i) => i.id),
      orgIconScope(org),
    );
    return { items: items.map((i) => ({ ...i, icon: icons.get(i.id) ?? null })) };
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
    const icon = await this.catalog.icon(itemId, roleAtLeast(org.role, "admin"), org.orgId);
    await sendCatalogIcon(reply, icon);
  }

  /**
   * A setup guide of the item, rendered for this org (spec 2026-11-09-setup-guides-v2-design.md
   * §7.2): the document's blocks with the place's variables filled in, its modes, audiences and
   * checks, the unresolved variables with their reasons, the drift hash and the target. The item
   * must be one the org's catalog shows; the place and audience's action (`channels.manage`,
   * `connectors.manage`, `connectors.use`) is checked by the service.
   */
  @Get("catalog/:itemId/guides/:guideId")
  @OrgAction("catalog.read")
  async guide(
    @CurrentOrg() org: OrgContext,
    @Param("itemId") itemId: string,
    @Param("guideId") guideId: string,
    @ZQuery(CatalogGuideQueryDto) q: z.infer<typeof CatalogGuideQuery>,
  ): Promise<{ guide: RenderedSetupGuide }> {
    return { guide: await this.guides.render(org, itemId, guideId, q) };
  }

  /**
   * A request for an item (spec §5.1): `enable` (members and up, an item that is off) or `access`
   * (org admins, a `named` item shown to the org) -> 201 `{ request }`.
   */
  @Post("catalog/:itemId/requests")
  @HttpCode(201)
  @OrgAction("catalog.request")
  async request(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("itemId") itemId: string,
    @ZBody(CatalogRequestBodyDto) body: z.infer<typeof CatalogRequestBody>,
  ): Promise<{ request: CatalogRequestView }> {
    const p = requireUser(principal);
    const tokenId = patTokenId(p);
    return {
      request: await this.requests.requestItem(
        org.orgId,
        p.account.id,
        itemId,
        body,
        tokenId !== undefined ? { actorTokenId: tokenId } : {},
      ),
    };
  }

  /**
   * An org admin asks for a marketplace entry to be imported (deployment setting
   * `orgMarketplaceBrowse`) -> 201 `{ request }`.
   */
  @Post("marketplace-requests")
  @HttpCode(201)
  @OrgAction("catalog.decide")
  async marketplaceRequest(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZBody(CatalogMarketplaceRequestBodyDto) body: z.infer<typeof CatalogMarketplaceRequestBody>,
  ): Promise<{ request: CatalogRequestView }> {
    const p = requireUser(principal);
    const tokenId = patTokenId(p);
    return {
      request: await this.requests.requestImport(
        org.orgId,
        p.account.id,
        body,
        tokenId !== undefined ? { actorTokenId: tokenId } : {},
      ),
    };
  }

  @Put("catalog/:itemId/switch")
  @OrgAction("catalog.read")
  async setSwitch(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("itemId") itemId: string,
    @ZBody(OrgPluginSwitchBodyDto) body: z.infer<typeof OrgPluginSwitchBody>,
  ): Promise<{ item: OrgCatalogItem } | { preview: UninstallPreview; confirm: string }> {
    const p = requireUser(principal);
    const r: SwitchResult = await this.catalog.setSwitch(
      org.orgId,
      p.account.id,
      itemId,
      body.enabled
        ? {
            enabled: true,
            ...(body.inputs !== undefined && {
              inputs: body.inputs as Parameters<OrgCatalogService["install"]>[3],
            }),
          }
        : { enabled: false, ...(body.confirm !== undefined && { confirm: body.confirm }) },
      patTokenId(p),
    );
    return r.kind === "done" ? { item: r.item } : { preview: r.preview, confirm: r.confirm };
  }

  @Post("catalog/:itemId/install")
  @OrgAction("catalog.read")
  async install(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("itemId") itemId: string,
    @ZBody(OrgPluginInstallBodyDto) body: z.infer<typeof OrgPluginInstallBody>,
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

  /**
   * Creates the connectors an installed plugin is missing (ruling P2-10: a connector template on
   * in the org without a connector there, e.g. added by a platform update; the plugin shows
   * `needs_config`): `{ inputs: { connectors: { <templateId>: input } } }` with the same input
   * checks as an install; recorded on the install -> 201 `{ connectors: [{ templateId,
   * connectorId }] }`. Not installed -> 404 `plugin.install_not_found`; a template not missing ->
   * 400 `validation_failed`.
   */
  @Post("catalog/:itemId/connectors")
  @OrgAction("connectors.manage")
  async configureConnectors(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("itemId") itemId: string,
    @ZBody(OrgPluginConnectorsBody) body: z.infer<typeof ConnectorsBody>,
  ): Promise<{ connectors: { templateId: string; connectorId: string }[] }> {
    const p = requireUser(principal);
    const tokenId = patTokenId(p);
    return {
      connectors: await this.pluginInstaller.configureConnectors(
        org.orgId,
        p.account.id,
        itemId,
        body.inputs as Parameters<PluginInstaller["configureConnectors"]>[3],
        tokenId !== undefined ? { actorTokenId: tokenId } : {},
      ),
    };
  }

  /**
   * One more connector from a platform connector template on in the org (rulings P4-7, P4-T6-8):
   * `{ name?, config: { slug?, endpoint?, credential?, client? } }` with the checks of an install
   * -> 201 `{ connector, issues }` (as `POST connectors`). A template not usable in the org -> 404
   * `component.not_found`; off there -> 409 `component.off`; input errors -> 400 at `config.*`.
   */
  @Post("connector-templates/:templateId/connectors")
  @OrgAction("connectors.manage")
  async templateConnector(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("templateId") templateId: string,
    @ZBody(OrgTemplateConnectorBody) body: z.infer<typeof TemplateConnectorBody>,
  ): Promise<{ connector: ConnectorDetail; issues: ToolIssue[] }> {
    const p = requireUser(principal);
    const tokenId = patTokenId(p);
    return this.pluginInstaller.addTemplateConnector(
      org.orgId,
      p.account.id,
      templateId,
      {
        config: body.config as Parameters<PluginInstaller["addTemplateConnector"]>[3]["config"],
        ...(body.name !== undefined && { name: body.name }),
      },
      tokenId !== undefined ? { actorTokenId: tokenId } : {},
    );
  }

  @Get("plugin-installs")
  @OrgAction("org.extensions.manage")
  async listInstalls(@CurrentOrg() org: OrgContext): Promise<{ installs: PluginInstallView[] }> {
    return { installs: await this.pluginInstaller.list(org.orgId) };
  }

  @Delete("plugin-installs/:installId")
  @OrgAction("org.extensions.manage")
  async uninstall(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("installId") installId: string,
  ): Promise<UninstallReport> {
    const p = requireUser(principal);
    const tokenId = patTokenId(p);
    return this.catalog.uninstall(org.orgId, p.account.id, installId, tokenId);
  }

  @Post("catalog-requests/:id/decide")
  @HttpCode(200)
  @OrgAction("catalog.decide")
  async decide(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("id") id: string,
    @ZBody(CatalogDecideBody) body: z.infer<typeof DecideBody>,
  ): Promise<{ request: CatalogRequestView }> {
    const p = requireUser(principal);
    const tokenId = patTokenId(p);
    return {
      request: await this.requests.decideOrg(
        org.orgId,
        p.account.id,
        id,
        body,
        tokenId !== undefined ? { actorTokenId: tokenId } : {},
      ),
    };
  }

  /** The requester dismisses a decided request from the inbox -> 204. */
  @Post("catalog-requests/:id/dismiss")
  @HttpCode(204)
  @OrgAction("catalog.read")
  async dismiss(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("id") id: string,
  ): Promise<void> {
    const p = requireUser(principal);
    await this.requests.dismiss(org.orgId, p.account.id, id);
  }
}

/**
 * Super admins decide `access` and `import` requests (`/api/v1/admin/catalog/requests`):
 * approving an `import` returns the prepared import (`import: { stagingId, review, ... }`), confirmed
 * with `POST /api/v1/admin/catalog/imports/:stagingId/confirm`.
 */
@Controller("api/v1/admin/catalog/requests")
@SuperAdmin()
export class AdminCatalogRequestsController {
  constructor(@Inject(CatalogRequestsService) private readonly requests: CatalogRequestsService) {}

  @Get()
  async list(
    @ZQuery(CatalogRequestsQuery) q: z.infer<typeof CatalogRequestsListQuery>,
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
    @ZBody(CatalogDecideBody) body: z.infer<typeof DecideBody>,
  ): Promise<{ request: CatalogRequestView; import?: MarketplaceImportResult }> {
    const p = requireUser(principal);
    const tokenId = patTokenId(p);
    return this.requests.decideDeployment(
      p.account.id,
      id,
      body,
      tokenId !== undefined ? { actorTokenId: tokenId } : {},
    );
  }
}
