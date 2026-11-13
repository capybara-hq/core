import type { SuggestedAppearance } from "@capybara-hq/plugin-sdk";
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
import { type ClientBuildSummary, ClientBuilds } from "../client/client-builds.service.js";
import { ApiError } from "../errors.js";
import { PluginGuides, type RenderedSetupGuide } from "../extensions/plugin-guides.js";
import { PluginIcons } from "../extensions/plugin-icons.js";
import {
  CurrentPrincipal,
  type Principal,
  patTokenId,
  requireUser,
  SuperAdmin,
} from "../identity/principal.js";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import { ZBody, ZQuery } from "../infra/validation/zod-params.js";
import {
  AdminCatalogGuideQuery,
  CatalogImportUpdateBody,
  CatalogItemsQuery,
  CatalogUpdateBody,
  CatalogUpdatePreviewBody,
  CatalogDisabledBody as DisabledBody,
  CatalogGitImportBody as GitBody,
  CatalogHash as Hash,
  CatalogNpmImportBody as NpmBody,
  CatalogScopeOrgs as Orgs,
  CatalogScope as Scope,
  CatalogScopeBody as ScopeBody,
  CatalogScopePreviewBody as ScopePreviewBody,
  CatalogShownBody as ShownBody,
} from "./admin-catalog.schemas.js";
import { AppearanceApplyBody } from "./appearance.schemas.js";
import {
  type AppearanceResult,
  AppearanceService,
  suggestedAppearanceOf,
} from "./appearance.service.js";
import {
  type ActorOpts,
  type CatalogItemDetail,
  type CatalogItemView,
  CatalogService,
  type PermissionsMismatch,
} from "./catalog.service.js";
import { CatalogScopeService, type ScopePreview } from "./catalog-scope.service.js";
import { sendCatalogIcon } from "./org-catalog.controller.js";
import { OrgCatalogService } from "./org-catalog.service.js";
import { PlatformImportUpdate, type PlatformImportUpdateResult } from "./platform-import-update.js";
import { type PluginConfirmResult, PluginImport, type PluginReview } from "./plugin-import.js";
import {
  PlatformPluginUpdater,
  type PlatformUpdatePreview,
  type PlatformUpdateResult,
} from "./plugin-upgrade.js";

const ConfirmBody = z
  .object({
    reviewHash: Hash,
    /** The new item's scope (default `optional`); `orgs` only with `named`. */
    scope: Scope.optional(),
    orgs: Orgs.optional(),
  })
  .strict();

const ConfirmPermissionsBody = z.object({ permissionsHash: Hash }).strict();
/** The reason shown to the owner org in its `upload_rejected` notice (optional). */
const RejectBody = z.object({ reason: z.string().trim().min(1).max(1000).optional() }).strict();

const actorOpts = (actor: ReturnType<typeof requireUser>): ActorOpts => {
  const tokenId = patTokenId(actor);
  return tokenId !== undefined ? { actorTokenId: tokenId } : {};
};

class CatalogImportConfirmBody extends createZodDto(ConfirmBody, "CatalogImportConfirmBody") {}
class CatalogGitImportBody extends createZodDto(GitBody, "CatalogGitImportBody") {}
class AdminCatalogGuideQueryDto extends createZodDto(
  AdminCatalogGuideQuery,
  "AdminCatalogGuideQuery",
) {}
class CatalogItemsQueryDto extends createZodDto(CatalogItemsQuery, "CatalogItemsQuery") {}
class CatalogNpmImportBody extends createZodDto(NpmBody, "CatalogNpmImportBody") {}
class CatalogScopePreviewBody extends createZodDto(ScopePreviewBody, "CatalogScopePreviewBody") {}
class CatalogScopeBody extends createZodDto(ScopeBody, "CatalogScopeBody") {}
class CatalogConfirmPermissionsBody extends createZodDto(
  ConfirmPermissionsBody,
  "CatalogConfirmPermissionsBody",
) {}
class CatalogShownBody extends createZodDto(ShownBody, "CatalogShownBody") {}
class CatalogRejectBody extends createZodDto(RejectBody, "CatalogRejectBody") {}
class CatalogDisabledBody extends createZodDto(DisabledBody, "CatalogDisabledBody") {}
class CatalogUpdatePreviewBodyDto extends createZodDto(
  CatalogUpdatePreviewBody,
  "CatalogUpdatePreviewBody",
) {}
class CatalogUpdateBodyDto extends createZodDto(CatalogUpdateBody, "CatalogUpdateBody") {}
class CatalogImportUpdateBodyDto extends createZodDto(
  CatalogImportUpdateBody,
  "CatalogImportUpdateBody",
) {}
class AppearanceApplyBodyDto extends createZodDto(AppearanceApplyBody, "AppearanceApplyBody") {}

/**
 * The platform catalog (`/api/v1/admin/catalog/*`, super admins): plugin import (upload / npm
 * prepare, then confirm, which installs the plugin's extension), the item list and detail, scope and
 * disable (previewed, then confirmed with `scopeHash`), delete. Writes re-check the super admin inside the service's lock and are
 * audited.
 */
@Controller("api/v1/admin/catalog")
@SuperAdmin()
export class AdminCatalogController {
  constructor(
    @Inject(CatalogService) private readonly catalog: CatalogService,
    @Inject(PluginImport) private readonly pluginImport: PluginImport,
    @Inject(OrgCatalogService) private readonly orgCatalog: OrgCatalogService,
    @Inject(CatalogScopeService) private readonly scope: CatalogScopeService,
    @Inject(PlatformPluginUpdater) private readonly updater: PlatformPluginUpdater,
    @Inject(PlatformImportUpdate) private readonly importUpdate: PlatformImportUpdate,
    @Inject(PluginIcons) private readonly icons: PluginIcons,
    @Inject(AppearanceService) private readonly appearance: AppearanceService,
    @Inject(ClientBuilds) private readonly clientBuilds: ClientBuilds,
    @Inject(PluginGuides) private readonly guides: PluginGuides,
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
   * extension on the deployment changed -> 409 `plugin.review_stale`. The removed `pinnedSuggestions`
   * is an unknown field (400 `validation_failed`).
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
      },
      actorOpts(actor),
    );
  }

  /**
   * What confirming a staged new version of an installed platform plugin would do as the platform
   * update (`PlatformImportUpdate`, the one 更新到 wizard): the update preview of the staged
   * version, nothing written (cancelling the wizard leaves only the staging row). Not a platform
   * plugin yet -> 409 `plugin.upgrade_target_invalid` (reason `not_installed`); staging missing ->
   * 404 `plugin.staging_not_found`; otherwise as `items/:id/update/preview`.
   */
  @Get("imports/:stagingId/update-preview")
  importUpdatePreview(@Param("stagingId") stagingId: string): Promise<PlatformUpdatePreview> {
    return this.importUpdate.preview(stagingId);
  }

  /**
   * Imports the staged version and updates the platform plugin to it, confirmed with the import
   * review's `reviewHash` and the update preview's `diffHash` (201 `{ item, update }`). Stale review
   * -> 409 `plugin.review_stale`, stale preview -> 409 `plugin.upgrade_stale`, another update
   * running -> 409 `plugin.install_in_progress`: nothing written. The update failing after the
   * import -> 409 `plugin.imported_not_updated` (the version stays in the catalog, the platform on
   * its version, the extension's approval put back; details name the cause).
   */
  @Post("imports/:stagingId/update")
  @HttpCode(201)
  importAndUpdate(
    @CurrentPrincipal() principal: Principal,
    @Param("stagingId") stagingId: string,
    @ZBody(CatalogImportUpdateBodyDto) body: z.infer<typeof CatalogImportUpdateBody>,
  ): Promise<PlatformImportUpdateResult> {
    const actor = requireUser(principal);
    return this.importUpdate.confirm(actor.account.id, stagingId, body, actorOpts(actor));
  }

  /**
   * The item list (`includeDeleted=true` includes deleted items). Paging: `limit` (default 200, at
   * most 1000) and `offset`; `nextOffset` is the next page's offset, null when there is none.
   */
  @Get("items")
  async list(
    @ZQuery(CatalogItemsQueryDto) q: z.infer<typeof CatalogItemsQuery>,
  ): Promise<{ items: (CatalogItemView & { icon: string | null })[]; nextOffset: number | null }> {
    const page = await this.catalog.page({
      includeDeleted: q.includeDeleted === "true",
      ...(q.pending === "true" && { pending: true }),
      ...(q.limit !== undefined && { limit: q.limit }),
      ...(q.offset !== undefined && { offset: q.offset }),
    });
    // Each item's icon (admin route; a deleted item has none)
    const icons = await this.icons.ofItems(
      page.items.map((i) => i.id),
      { kind: "admin" },
    );
    return { ...page, items: page.items.map((i) => ({ ...i, icon: icons.get(i.id) ?? null })) };
  }

  /**
   * The item with its versions, plus `hasIcon` (the latest version has an icon, served by `GET
   * items/:id/icon`) and `suggestedAppearance` (the platform version's, null without one: the page
   * offers 应用此插件的外观 when set). Each version carries `client`: its extension package's
   * client build (files with sizes, total, client API version; null without one), what the
   * permission confirmation of an org's upload shows in its 客户端代码 group (client extensions spec
   * §5.4). Unknown -> 404 `catalog.item_not_found`.
   */
  @Get("items/:id")
  async get(@Param("id") id: string): Promise<
    Omit<CatalogItemDetail, "versions"> & {
      versions: (CatalogItemDetail["versions"][number] & { client: ClientBuildSummary | null })[];
      hasIcon: boolean;
      suggestedAppearance: SuggestedAppearance | null;
    }
  > {
    const detail = await this.catalog.get(id);
    const platform = detail.versions.find((v) => v.version === detail.item.platformVersion);
    const [hasIcon, builds] = await Promise.all([
      this.orgCatalog.hasIcon(id),
      this.clientBuilds.summaries(
        detail.versions.flatMap((v) => (v.extensionSha256 === null ? [] : [v.extensionSha256])),
      ),
    ]);
    return {
      ...detail,
      versions: detail.versions.map((v) => ({
        ...v,
        client: v.extensionSha256 === null ? null : (builds.get(v.extensionSha256) ?? null),
      })),
      hasIcon,
      suggestedAppearance: suggestedAppearanceOf(platform?.manifest),
    };
  }

  /**
   * 应用此插件的外观 (client extensions spec §6.5): sets the plugin's suggested theme as the platform
   * default theme and each suggested replacement as the platform arrangement's `use` of its slot, in
   * one transaction. `dryRun: true` answers the same changes and writes nothing. A theme that cannot
   * be the platform default -> 400 `theme.not_available` (nothing written); a replacement not
   * available on the platform is skipped. No such item, or no suggestion -> 404
   * `catalog.item_not_found`.
   */
  @Post("items/:id/appearance")
  @HttpCode(200)
  applyAppearance(
    @CurrentPrincipal() principal: Principal,
    @Param("id") id: string,
    @ZBody(AppearanceApplyBodyDto) body: z.infer<typeof AppearanceApplyBody>,
  ): Promise<AppearanceResult> {
    const actor = requireUser(principal);
    const tokenId = patTokenId(actor);
    return this.appearance.apply(
      { platform: true },
      id,
      { accountId: actor.account.id, ...(tokenId !== undefined && { tokenId }) },
      body.dryRun === true,
    );
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
   * A setup guide of the item as the platform sees it (spec 2026-11-09-setup-guides-v2-design.md
   * §9.3; the admin console's connector template page): any live item, the admin audience, no org
   * (`orgName` unresolved, reason `no_org`), no target, no checks run. Unknown item -> 404
   * `catalog.item_not_found`, unknown guide -> 404 `catalog.guide_not_found`.
   */
  @Get(":itemId/guides/:guideId")
  async guide(
    @Param("itemId") itemId: string,
    @Param("guideId") guideId: string,
    @ZQuery(AdminCatalogGuideQueryDto) q: z.infer<typeof AdminCatalogGuideQuery>,
  ): Promise<{ guide: RenderedSetupGuide }> {
    return { guide: await this.guides.renderForPlatform(itemId, guideId, q) };
  }

  /**
   * What a scope change (`{ scope, orgs? }`, `orgs` only with `named`) or a disable
   * (`{ disabled: true }`) would take away: `{ affected: [{ orgId, orgName, agents,
   * connectorsKept }], needsConfig, scopeHash }` (spec §5 rule 8; nothing written; the connectors
   * stay as the orgs' own). A builtin item -> 409 `plugin.builtin`; unknown
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
   * Confirms the item's extension permissions (the admin's 待确认; body `{ permissionsHash }` from
   * the item view): approves the current permission set (snapshot source `web`) and installs and
   * enables an extension that was never deployed. A changed set -> 409 `extension.approval_stale`;
   * nothing to confirm -> 409 `extension.not_pending`. Returns the item. An org's upload
   * (`owner.kind` org, ruling P3-10): the digest of its pending version's package; a first version
   * is installed, approved, enabled and synced, a new version applied by the platform update
   * (the item removed meanwhile -> 409 `catalog.item_removed`, P3-21).
   */
  @Post("items/:id/confirm")
  @HttpCode(200)
  confirmPermissions(
    @CurrentPrincipal() principal: Principal,
    @Param("id") id: string,
    @ZBody(CatalogConfirmPermissionsBody) body: z.infer<typeof ConfirmPermissionsBody>,
  ): Promise<CatalogItemView> {
    const actor = requireUser(principal);
    return this.scope.confirmPermissions(
      actor.account.id,
      id,
      body.permissionsHash,
      actorOpts(actor),
    );
  }

  /**
   * Rejects an org upload's pending version (ruling P3-10; body `{ reason? }`, told to the owner
   * org in `upload_rejected`): a first version is removed (its name free again), a new version's
   * pending state cleared. Nothing pending, or a platform item (pre-flight F11) -> 409
   * `extension.not_pending`. 204.
   */
  @Post("items/:id/reject")
  @HttpCode(204)
  async reject(
    @CurrentPrincipal() principal: Principal,
    @Param("id") id: string,
    @ZBody(CatalogRejectBody) body: z.infer<typeof RejectBody>,
  ): Promise<void> {
    const actor = requireUser(principal);
    await this.scope.reject(actor.account.id, id, body.reason ?? null, actorOpts(actor));
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

  /**
   * What updating the platform plugin to `version` would do (spec §7.1, `PlatformPluginUpdater`):
   * `{ itemId, name, from, to, components: [{ kind, id, name, change: added | removed | upgrade |
   * downgrade | same, from, to, updatedOnOwn, ownScope, pinnedOrgs, kept? }], extension,
   * connectorOrgs: [{ orgId, connectors, needsConfig }], diffHash }`. Nothing written. The same
   * version, a target the deployment's extension or a dependent plugin cannot take -> 409
   * `plugin.upgrade_target_invalid`; an added skill named like one in use where the plugin is on
   * -> 409 `plugin.skill_conflict`; disabled -> 403 `catalog.item_disabled`.
   */
  @Post("items/:id/update/preview")
  @HttpCode(200)
  previewUpdate(
    @Param("id") id: string,
    @ZBody(CatalogUpdatePreviewBodyDto) body: z.infer<typeof CatalogUpdatePreviewBody>,
  ): Promise<PlatformUpdatePreview> {
    return this.updater.preview(id, body.version);
  }

  /**
   * Updates the platform plugin, confirmed with the preview's `diffHash` (recomputed under the item
   * lock; a difference -> 409 `plugin.upgrade_stale`; another update running -> 409
   * `plugin.install_in_progress`). A failure undoes everything -> 502 `plugin.upgrade_failed`.
   * Audits `plugin.platform_updated`. A version an org upload waits with (or an item whose first
   * version waits) -> 409 `catalog.item_pending`: confirm it in 待确认 (pre-flight F8); the
   * preview answers the same.
   */
  @Put("items/:id/update")
  update(
    @CurrentPrincipal() principal: Principal,
    @Param("id") id: string,
    @ZBody(CatalogUpdateBodyDto) body: z.infer<typeof CatalogUpdateBody>,
  ): Promise<PlatformUpdateResult> {
    const actor = requireUser(principal);
    return this.updater.update(actor.account.id, id, body, actorOpts(actor));
  }

  /** 删除条目（软删除，已安装的组件不受影响）。 */
  @Delete("items/:id")
  @HttpCode(204)
  async remove(@CurrentPrincipal() principal: Principal, @Param("id") id: string): Promise<void> {
    const actor = requireUser(principal);
    await this.catalog.remove(actor.account.id, id, actorOpts(actor));
  }
}
