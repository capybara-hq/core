import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { z } from "zod";
import { ApiError } from "../errors.js";
import type { AdminExtensionView } from "../extensions/permission-view.js";
import { CATALOG, ORG_CATALOG, PLUGIN_IMPORT } from "../http/tokens.js";
import { ZodPipe } from "../http/zod.pipe.js";
import {
  CurrentPrincipal,
  EnterpriseAdmin,
  type Principal,
  patTokenId,
  requireUser,
} from "../identity/principal.js";
import {
  type ActorOpts,
  CATALOG_LIST_MAX_LIMIT,
  type CatalogItemDetail,
  type CatalogItemView,
  type CatalogService,
} from "./catalog.service.js";
import { sendCatalogIcon } from "./org-catalog.controller.js";
import type { OrgCatalogService } from "./org-catalog.service.js";
import type { PluginConfirmResult, PluginImport, PluginReview } from "./plugin-import.js";

const NpmBody = z.object({
  package: z.string().min(1).max(214),
  version: z.string().min(1).max(256).optional(),
});

const PolicyBody = z.object({ policy: z.enum(["allow", "needs_approval", "disabled"]) });

const InstallBody = z.object({ version: z.string().min(1).max(256) });

const ConfirmBody = z.object({
  reviewHash: z.string().min(1).max(128),
  deployExtension: z.boolean(),
});

const ListQuery = z.object({
  includeDeleted: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(CATALOG_LIST_MAX_LIMIT).optional(),
  offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
});

const actorOpts = (actor: ReturnType<typeof requireUser>): ActorOpts => {
  const tokenId = patTokenId(actor);
  return tokenId !== undefined ? { actorTokenId: tokenId } : {};
};

/**
 * The enterprise catalog (`/api/v1/admin/catalog/*`, enterprise admins): plugin import (upload / npm
 * prepare, then confirm), the item list and detail, policy, delete, and installing an item's
 * extension on the deployment. Writes re-check the enterprise admin inside the service's lock and are
 * audited.
 */
@Controller("api/v1/admin/catalog")
@EnterpriseAdmin()
export class AdminCatalogController {
  constructor(
    @Inject(CATALOG) private readonly catalog: CatalogService,
    @Inject(PLUGIN_IMPORT) private readonly pluginImport: PluginImport,
    @Inject(ORG_CATALOG) private readonly orgCatalog: OrgCatalogService,
  ) {}

  /**
   * Prepares the import of an uploaded plugin (an npm-pack tgz as the raw body,
   * `application/octet-stream`, at most `packages.maxBytes`): reads and checks the whole plugin
   * (extension, skills, connector templates; dependencies resolved for the review), stages it for 24
   * hours and returns one review `{ stagingId, review }`, confirmed with `imports/:stagingId/confirm`.
   * A pre-0.1.0 package -> 422 `catalog.legacy_format`; an invalid plugin -> 422
   * `catalog.invalid_manifest` (details list each problem); version already imported -> 409
   * `catalog.version_exists`; an item with the same name from another npm package -> 409
   * `catalog.name_conflict`; an extension named like a builtin / config-declared one -> 409.
   */
  @Post("import/file")
  @HttpCode(200)
  async importFile(
    @CurrentPrincipal() principal: Principal,
    @Req() req: { body?: unknown },
  ): Promise<{ stagingId: string; review: PluginReview }> {
    const actor = requireUser(principal);
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.byteLength === 0) {
      throw new ApiError(
        "unsupported_media_type",
        "Send the plugin package (.tgz) as the request body with content-type application/octet-stream",
      );
    }
    const r = await this.pluginImport.prepare(
      actor.account.id,
      new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
      { kind: "file", ref: "upload" },
      actorOpts(actor),
    );
    return { stagingId: r.stagingId, review: r.review };
  }

  /**
   * Prepares the import of a plugin from the configured npm registry (`version` may be a version, a
   * dist-tag or a range, default latest; verified by `dist.integrity`), as `import/file`. Download
   * failure -> 502.
   */
  @Post("import/npm")
  @HttpCode(200)
  importNpm(
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodPipe(NpmBody)) body: z.infer<typeof NpmBody>,
  ): Promise<{ stagingId: string; review: PluginReview }> {
    const actor = requireUser(principal);
    return this.pluginImport.prepareNpm(
      actor.account.id,
      { package: body.package, ...(body.version !== undefined && { version: body.version }) },
      actorOpts(actor),
    );
  }

  /**
   * A staged import's review `{ stagingId, review }` (the web's import page loads
   * `?staging=<id>` with it). Unknown, expired or already confirmed -> 404
   * `plugin.staging_not_found`.
   */
  @Get("imports/:stagingId")
  staged(
    @Param("stagingId") stagingId: string,
  ): Promise<{ stagingId: string; review: PluginReview }> {
    return this.pluginImport.staged(stagingId);
  }

  /**
   * Confirms a staged import: approves the plugin's extension when this import installs it (writes
   * its snapshot) and creates the item or adds the version; with `deployExtension` it installs and
   * enables the plugin's own extension after the commit and returns `{ item, deploy }`, where
   * `deploy` says enabled / failed (+ code); a failed deploy does not make the committed import fail
   * (retry from the extension admin by sha256). A foreseeable failure (a downgrade to a version with
   * unrun migrations) is a 409 `extension.downgrade_unsupported` before anything is written.
   * Staging missing or expired -> 404 `plugin.staging_not_found`; `reviewHash` differs or the
   * extension on the deployment changed -> 409 `plugin.review_stale`.
   */
  @Post("imports/:stagingId/confirm")
  @HttpCode(201)
  confirm(
    @CurrentPrincipal() principal: Principal,
    @Param("stagingId") stagingId: string,
    @Body(new ZodPipe(ConfirmBody)) body: z.infer<typeof ConfirmBody>,
  ): Promise<PluginConfirmResult> {
    const actor = requireUser(principal);
    return this.pluginImport.confirm(actor.account.id, stagingId, body, actorOpts(actor));
  }

  /**
   * The item list (`includeDeleted=true` includes deleted items). Paging: `limit` (default 200, at
   * most 1000) and `offset`; `nextOffset` is the next page's offset, null when there is none.
   */
  @Get("items")
  list(
    @Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>,
  ): Promise<{ items: CatalogItemView[]; nextOffset: number | null }> {
    return this.catalog.page({
      includeDeleted: q.includeDeleted === "true",
      ...(q.limit !== undefined && { limit: q.limit }),
      ...(q.offset !== undefined && { offset: q.offset }),
    });
  }

  /**
   * 条目详情与各版本，另给出 `hasIcon`（最新版本有图标，`GET items/:id/icon` 可取）；不存在 → 404
   * `catalog.item_not_found`。
   */
  @Get("items/:id")
  async get(@Param("id") id: string): Promise<CatalogItemDetail & { hasIcon: boolean }> {
    const detail = await this.catalog.get(id);
    return { ...detail, hasIcon: await this.orgCatalog.hasIcon(id) };
  }

  /**
   * The item's icon (disabled items included; same response headers as the org side, see
   * `sendCatalogIcon`). No icon -> 404 `catalog.icon_not_found`.
   */
  @Get("items/:id/icon")
  async icon(@Param("id") id: string, @Res() reply: FastifyReply): Promise<void> {
    await sendCatalogIcon(reply, await this.orgCatalog.icon(id, true));
  }

  /** 改策略（allow / needs_approval / disabled）。 */
  @Put("items/:id/policy")
  setPolicy(
    @CurrentPrincipal() principal: Principal,
    @Param("id") id: string,
    @Body(new ZodPipe(PolicyBody)) body: z.infer<typeof PolicyBody>,
  ): Promise<CatalogItemView> {
    const actor = requireUser(principal);
    return this.catalog.setPolicy(actor.account.id, id, body.policy, actorOpts(actor));
  }

  /** 删除条目（软删除，已安装的组件不受影响）。 */
  @Delete("items/:id")
  @HttpCode(204)
  async remove(@CurrentPrincipal() principal: Principal, @Param("id") id: string): Promise<void> {
    const actor = requireUser(principal);
    await this.catalog.remove(actor.account.id, id, actorOpts(actor));
  }

  /**
   * Installs the extension of a version of an item on the deployment (a new install starts disabled;
   * unapproved permissions still need approval). A version without an extension -> 409
   * `catalog.no_extension`.
   */
  @Post("items/:id/install-deployment")
  @HttpCode(200)
  installToDeployment(
    @CurrentPrincipal() principal: Principal,
    @Param("id") id: string,
    @Body(new ZodPipe(InstallBody)) body: z.infer<typeof InstallBody>,
  ): Promise<AdminExtensionView> {
    const actor = requireUser(principal);
    return this.catalog.installToDeployment(actor.account.id, id, body.version, actorOpts(actor));
  }
}
