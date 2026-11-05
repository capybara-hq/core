import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Req,
  Res,
} from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { z } from "zod";
import { ApiError } from "../errors.js";
import {
  CurrentPrincipal,
  EnterpriseAdmin,
  type Principal,
  patTokenId,
  requireUser,
} from "../identity/principal.js";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import { ZBody, ZQuery } from "../infra/validation/zod-params.js";
import {
  type ActorOpts,
  CATALOG_LIST_MAX_LIMIT,
  type CatalogItemDetail,
  type CatalogItemView,
  CatalogService,
  type PermissionsMismatch,
} from "./catalog.service.js";
import { CatalogScopeService, type ScopePreview } from "./catalog-scope.service.js";
import { sendCatalogIcon } from "./org-catalog.controller.js";
import { OrgCatalogService } from "./org-catalog.service.js";
import { type PluginConfirmResult, PluginImport, type PluginReview } from "./plugin-import.js";

const NpmBody = z.object({
  package: z.string().min(1).max(214),
  version: z.string().min(1).max(256).optional(),
});

const GitBody = z
  .object({
    url: z.string().min(1).max(2000),
    ref: z.string().min(1).max(256).optional(),
    path: z.string().min(1).max(512).optional(),
  })
  .strict();

const Scope = z.enum(["all", "optional", "named"]);
const Orgs = z.array(z.string().min(1).max(128)).max(1000);
const Hash = z.string().min(1).max(128);

const ConfirmBody = z
  .object({
    reviewHash: Hash,
    /** The new item's scope (default `optional`); `orgs` only with `named`. */
    scope: Scope.optional(),
    orgs: Orgs.optional(),
    /** Skill names suggested as pinned (spec §9.1); omitted keeps the plugin's flags. */
    pinnedSuggestions: z.array(z.string().min(1).max(64)).max(50).optional(),
  })
  .strict();

/** `{ scope, orgs? }` (a scope change) or `{ disabled: true }` (a disable), not both. */
const ScopePreviewBody = z
  .object({ scope: Scope.optional(), orgs: Orgs.optional(), disabled: z.literal(true).optional() })
  .strict()
  .refine((b) => (b.disabled === true) !== (b.scope !== undefined), {
    message: "send either scope (with orgs for named) or disabled: true",
  })
  .refine((b) => b.disabled === undefined || b.orgs === undefined, {
    message: "orgs: only allowed with scope named",
    path: ["orgs"],
  });

const ScopeBody = z.object({ scope: Scope, orgs: Orgs.optional(), scopeHash: Hash }).strict();

const DisabledBody = z.object({ disabled: z.boolean(), scopeHash: Hash.optional() }).strict();
const ShownBody = z.object({ shownToOthers: z.boolean() }).strict();

const ListQuery = z.object({
  includeDeleted: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(CATALOG_LIST_MAX_LIMIT).optional(),
  offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
});

const actorOpts = (actor: ReturnType<typeof requireUser>): ActorOpts => {
  const tokenId = patTokenId(actor);
  return tokenId !== undefined ? { actorTokenId: tokenId } : {};
};

class CatalogImportConfirmBody extends createZodDto(ConfirmBody, "CatalogImportConfirmBody") {}
class CatalogGitImportBody extends createZodDto(GitBody, "CatalogGitImportBody") {}
class CatalogItemsQuery extends createZodDto(ListQuery, "CatalogItemsQuery") {}
class CatalogNpmImportBody extends createZodDto(NpmBody, "CatalogNpmImportBody") {}
class CatalogScopePreviewBody extends createZodDto(ScopePreviewBody, "CatalogScopePreviewBody") {}
class CatalogScopeBody extends createZodDto(ScopeBody, "CatalogScopeBody") {}
class CatalogShownBody extends createZodDto(ShownBody, "CatalogShownBody") {}
class CatalogDisabledBody extends createZodDto(DisabledBody, "CatalogDisabledBody") {}

/**
 * The enterprise catalog (`/api/v1/admin/catalog/*`, enterprise admins): plugin import (upload / npm
 * prepare, then confirm, which installs the plugin's extension), the item list and detail, scope and
 * disable (previewed, then confirmed with `scopeHash`), delete. Writes re-check the enterprise admin inside the service's lock and are
 * audited.
 */
@Controller("api/v1/admin/catalog")
@EnterpriseAdmin()
export class AdminCatalogController {
  constructor(
    @Inject(CatalogService) private readonly catalog: CatalogService,
    @Inject(PluginImport) private readonly pluginImport: PluginImport,
    @Inject(OrgCatalogService) private readonly orgCatalog: OrgCatalogService,
    @Inject(CatalogScopeService) private readonly scope: CatalogScopeService,
  ) {}

  /**
   * Prepares the import of an uploaded plugin (an npm-pack tgz as the raw body,
   * `application/octet-stream`, at most `packages.maxBytes`): reads and checks the whole plugin
   * (extension, skills, connector templates; dependencies resolved for the review), stages it for 24
   * hours and returns one review `{ stagingId, review }`, confirmed with `imports/:stagingId/confirm`.
   * A pre-0.1.0 package -> 422 `catalog.legacy_format`; an invalid plugin -> 422
   * `catalog.invalid_manifest` (details list each problem); version already imported -> 409
   * `catalog.version_exists`; an item with the same name from another npm package -> 409
   * `catalog.name_conflict`; an extension named like a config-declared one -> 409.
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
    @ZBody(CatalogNpmImportBody) body: z.infer<typeof NpmBody>,
  ): Promise<{ stagingId: string; review: PluginReview }> {
    const actor = requireUser(principal);
    return this.pluginImport.prepareNpm(
      actor.account.id,
      { package: body.package, ...(body.version !== undefined && { version: body.version }) },
      actorOpts(actor),
    );
  }

  /**
   * Prepares the import of a plugin straight from git (a one-off: no marketplace is created and no
   * updates are tracked): `url` is an https git URL or `owner/repo`, `ref` a branch / tag / commit
   * (default the remote HEAD), `path` the plugin's directory in the repo (default the root). The
   * commit is resolved and recorded with host, repo and path; then as `import/file`. Git failures:
   * 502 `marketplace.git_failed`, 422 `marketplace.git_too_large` / `git_unsupported_entry`, 422
   * `marketplace.private_address` / `marketplace.redirect`.
   */
  @Post("import/git")
  @HttpCode(200)
  importGit(
    @CurrentPrincipal() principal: Principal,
    @ZBody(CatalogGitImportBody) body: z.infer<typeof GitBody>,
  ): Promise<{ stagingId: string; review: PluginReview }> {
    const actor = requireUser(principal);
    return this.catalog.importFromGit(
      actor.account.id,
      {
        url: body.url,
        ...(body.ref !== undefined && { ref: body.ref }),
        ...(body.path !== undefined && { path: body.path }),
      },
      actorOpts(actor),
    );
  }

  /**
   * A staged import's review `{ stagingId, review, permissionsMismatch? }` (the mismatch only for
   * a marketplace import whose permission summary differs from the package; the web's import page
   * loads `?staging=<id>` with it). Unknown, expired or already confirmed -> 404
   * `plugin.staging_not_found`.
   */
  @Get("imports/:stagingId")
  staged(@Param("stagingId") stagingId: string): Promise<{
    stagingId: string;
    review: PluginReview;
    permissionsMismatch?: PermissionsMismatch;
  }> {
    return this.pluginImport.staged(stagingId);
  }

  /**
   * Confirms a staged import: approves the plugin's extension when this import installs or upgrades
   * it (writes its snapshot), creates the item (with `scope`, default `optional`; `orgs` only with
   * `named`, each an existing org, else 400 `validation_failed`) or adds the version, installs and
   * enables the plugin's own extension after the commit and enqueues the item's scope sync; returns
   * `{ item, deploy }`, where `deploy` says enabled / failed (+ code), null without an extension to
   * deploy; a failed deploy does not make the committed import fail (retry from the extension admin
   * by sha256). An unknown field (the removed `deployExtension`) -> 400 `validation_failed`. A foreseeable failure (a downgrade to a version with
   * unrun migrations) is a 409 `extension.downgrade_unsupported` before anything is written.
   * Staging missing or expired -> 404 `plugin.staging_not_found`; `reviewHash` differs or the
   * extension on the deployment changed -> 409 `plugin.review_stale`. `pinnedSuggestions` (skill
   * names of the review) replaces the plugin's suggested pinning; an unknown name -> 400
   * `validation_failed`.
   */
  @Post("imports/:stagingId/confirm")
  @HttpCode(201)
  confirm(
    @CurrentPrincipal() principal: Principal,
    @Param("stagingId") stagingId: string,
    @ZBody(CatalogImportConfirmBody) body: z.infer<typeof ConfirmBody>,
  ): Promise<PluginConfirmResult> {
    const actor = requireUser(principal);
    return this.scope.confirmImport(
      actor.account.id,
      stagingId,
      {
        reviewHash: body.reviewHash,
        ...(body.scope !== undefined && { scope: body.scope }),
        ...(body.orgs !== undefined && { orgs: body.orgs }),
        ...(body.pinnedSuggestions !== undefined && { pinnedSuggestions: body.pinnedSuggestions }),
      },
      actorOpts(actor),
    );
  }

  /**
   * The item list (`includeDeleted=true` includes deleted items). Paging: `limit` (default 200, at
   * most 1000) and `offset`; `nextOffset` is the next page's offset, null when there is none.
   */
  @Get("items")
  list(
    @ZQuery(CatalogItemsQuery) q: z.infer<typeof ListQuery>,
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

  /**
   * What a scope change (`{ scope, orgs? }`, `orgs` only with `named`) or a disable
   * (`{ disabled: true }`) would take away: `{ affected: [{ orgId, orgName, agents }], needsConfig,
   * scopeHash }` (spec §5 rule 8; nothing written). A builtin item -> 409 `plugin.builtin`; unknown
   * orgs -> 400 `validation_failed`.
   */
  @Post("items/:id/scope/preview")
  @HttpCode(200)
  previewScope(
    @Param("id") id: string,
    @ZBody(CatalogScopePreviewBody) body: z.infer<typeof ScopePreviewBody>,
  ): Promise<ScopePreview> {
    return this.scope.preview(
      id,
      body.scope === undefined
        ? { disabled: true }
        : { scope: body.scope, ...(body.orgs !== undefined && { orgs: body.orgs }) },
    );
  }

  /**
   * Changes the scope, confirmed with the preview's `scopeHash` (recomputed under the item row lock;
   * a difference -> 409 `plugin.scope_stale`); bumps the scope version, audits
   * `catalog.scope_changed` and enqueues the scope sync. Builtin -> 409 `plugin.builtin`.
   */
  @Put("items/:id/scope")
  setScope(
    @CurrentPrincipal() principal: Principal,
    @Param("id") id: string,
    @ZBody(CatalogScopeBody) body: z.infer<typeof ScopeBody>,
  ): Promise<CatalogItemView> {
    const actor = requireUser(principal);
    return this.scope.setScope(
      actor.account.id,
      id,
      {
        scope: body.scope,
        scopeHash: body.scopeHash,
        ...(body.orgs !== undefined && { orgs: body.orgs }),
      },
      actorOpts(actor),
    );
  }

  /**
   * Disables the plugin on the whole deployment (`scopeHash` of the `{ disabled: true }` preview
   * required; the scope sync then uninstalls it everywhere, its scope and the org switches are kept)
   * or enables it again (no hash; the sync reinstalls where it is wanted). Builtin -> 409
   * `plugin.builtin`; a stale hash -> 409 `plugin.scope_stale`.
   */
  @Put("items/:id/disabled")
  setDisabled(
    @CurrentPrincipal() principal: Principal,
    @Param("id") id: string,
    @ZBody(CatalogDisabledBody) body: z.infer<typeof DisabledBody>,
  ): Promise<CatalogItemView> {
    const actor = requireUser(principal);
    return this.scope.setDisabled(
      actor.account.id,
      id,
      {
        disabled: body.disabled,
        ...(body.scopeHash !== undefined && { scopeHash: body.scopeHash }),
      },
      actorOpts(actor),
    );
  }

  /**
   * Whether orgs outside a `named` item's list see it as requestable (spec §5.1 rule 1). Hiding it
   * keeps pending requests as they are; new requests from unlisted orgs are then 404. Never makes
   * anything usable, so no preview and no scope sync. Audits `catalog.shown_changed`.
   */
  @Put("items/:id/shown")
  setShown(
    @CurrentPrincipal() principal: Principal,
    @Param("id") id: string,
    @ZBody(CatalogShownBody) body: z.infer<typeof ShownBody>,
  ): Promise<CatalogItemView> {
    const actor = requireUser(principal);
    return this.scope.setShown(actor.account.id, id, body.shownToOthers, actorOpts(actor));
  }

  /** 删除条目（软删除，已安装的组件不受影响）。 */
  @Delete("items/:id")
  @HttpCode(204)
  async remove(@CurrentPrincipal() principal: Principal, @Param("id") id: string): Promise<void> {
    const actor = requireUser(principal);
    await this.catalog.remove(actor.account.id, id, actorOpts(actor));
  }
}
