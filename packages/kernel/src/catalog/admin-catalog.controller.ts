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
  deployPlugins: z.boolean(),
});

const ListQuery = z.object({
  kind: z.enum(PACKAGE_KINDS as [PackageKind, ...PackageKind[]]).optional(),
  includeDeleted: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(CATALOG_LIST_MAX_LIMIT).optional(),
  offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
});

const actorOpts = (actor: ReturnType<typeof requireUser>): ActorOpts => {
  const tokenId = patTokenId(actor);
  return tokenId !== undefined ? { actorTokenId: tokenId } : {};
};

/**
 * 企业目录（`/api/v1/admin/directory/*`，企业管理员）：导入（上传 / npm）、条目列表与详情、策略、删除、
 * 插件条目装到部署。写操作在服务里锁内复核企业管理员并写审计。
 */
@Controller("api/v1/admin/directory")
@EnterpriseAdmin()
export class AdminCatalogController {
  constructor(
    @Inject(CATALOG) private readonly catalog: CatalogService,
    @Inject(PLUGIN_IMPORT) private readonly pluginImport: PluginImport,
    @Inject(ORG_CATALOG) private readonly orgCatalog: OrgCatalogService,
  ) {}

  /**
   * Uploads a catalog package (raw bytes, `application/octet-stream`, limit `packages.maxBytes`):
   * plugins / apps are npm-pack tgz, connector templates and skills may also be zip. Invalid
   * package -> 400 `catalog.invalid_package` (details list each problem); version already imported
   * -> 409 `catalog.version_exists`; an item with the same name from another npm package -> 409
   * `catalog.name_conflict`; app package -> 409 `catalog.wrong_kind` (apps go through
   * `apps/prepare/*`); a plugin named like a builtin / config-declared one -> 409.
   */
  @Post("import/file")
  @HttpCode(201)
  async importFile(
    @CurrentPrincipal() principal: Principal,
    @Req() req: { body?: unknown },
  ): Promise<CatalogItemView> {
    const actor = requireUser(principal);
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.byteLength === 0) {
      throw new ApiError(
        "unsupported_media_type",
        "Send the package (.tgz or .zip) as the request body with content-type application/octet-stream",
      );
    }
    return this.catalog.importFile(
      actor.account.id,
      new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
      actorOpts(actor),
    );
  }

  /** 从配置的 npm registry 拉取（`version` 可以是版本、dist-tag 或范围，缺省 latest）。下载失败 → 502。 */
  @Post("import/npm")
  @HttpCode(201)
  importNpm(
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodPipe(NpmBody)) body: z.infer<typeof NpmBody>,
  ): Promise<CatalogItemView> {
    const actor = requireUser(principal);
    return this.catalog.importNpm(
      actor.account.id,
      { package: body.package, ...(body.version !== undefined && { version: body.version }) },
      actorOpts(actor),
    );
  }

  /**
   * App package (npm-pack tgz, raw bytes, `application/octet-stream`, limit `packages.maxBytes`):
   * parses app.yaml, fetches each plugin from npm by the lock and verifies its sha512, checks the
   * templates and skills, and once everything passes stages it for 24 hours and returns one review.
   * Invalid manifest -> 400 `plugin.invalid_manifest`; lock sha512 mismatch -> 502
   * `plugin.lock_mismatch`; a builtin / config-declared plugin outside the range -> 409
   * `plugin.extension_conflict`; not an app package -> 409 `catalog.wrong_kind`.
   */
  @Post("apps/prepare/file")
  @HttpCode(200)
  async prepareAppFile(
    @CurrentPrincipal() principal: Principal,
    @Req() req: { body?: unknown },
  ): Promise<{ stagingId: string; review: PluginReview }> {
    const actor = requireUser(principal);
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.byteLength === 0) {
      throw new ApiError(
        "unsupported_media_type",
        "Send the app package (.tgz) as the request body with content-type application/octet-stream",
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

  /** 从配置的 npm registry 拉取应用包再暂存（同 `apps/prepare/file`）。下载失败 → 502。 */
  @Post("apps/prepare/npm")
  @HttpCode(200)
  prepareAppNpm(
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
   * Confirms an app import: approves every plugin to install / upgrade at once (writes snapshots) and
   * creates the kind app catalog item; with `deployPlugins` it installs and enables them after the
   * commit and returns `{ item, deploy }`, where `deploy` lists enabled / failed (+ code) one by one; a
   * failed deploy does not make the committed import fail. A failed plugin is reinstalled from the
   * extension admin by sha256: an install keeps its snapshot, so install then enable; an upgrade's
   * snapshot was restored to the old version, so install, approve, then enable. A foreseeable failure
   * (downgrade to a version with unrun migrations) is a 409 `extension.downgrade_unsupported` before
   * anything is written.
   * Staging missing or expired -> 404 `plugin.staging_not_found`; `reviewHash` differs or the
   * plugins on the deployment changed -> 409 `plugin.review_stale`.
   */
  @Post("apps/:stagingId/confirm")
  @HttpCode(201)
  confirmApp(
    @CurrentPrincipal() principal: Principal,
    @Param("stagingId") stagingId: string,
    @Body(new ZodPipe(ConfirmBody)) body: z.infer<typeof ConfirmBody>,
  ): Promise<PluginConfirmResult> {
    const actor = requireUser(principal);
    return this.pluginImport.confirm(actor.account.id, stagingId, body, actorOpts(actor));
  }

  /**
   * 条目列表（`kind` 过滤；`includeDeleted=true` 含已删除）。分页：`limit`（缺省 200，最大 1000）与 `offset`，
   * `nextOffset` 为下一页的 offset，没有下一页为 null。
   */
  @Get("items")
  list(
    @Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>,
  ): Promise<{ items: CatalogItemView[]; nextOffset: number | null }> {
    return this.catalog.page({
      ...(q.kind !== undefined && { kind: q.kind }),
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
   * Installs a version of a plugin item to the deployment (a new install starts disabled;
   * permissions still need approval). Not a plugin item -> 409 `catalog.wrong_kind`.
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
