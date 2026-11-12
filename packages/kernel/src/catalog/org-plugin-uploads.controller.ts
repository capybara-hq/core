import { Controller, Delete, Get, HttpCode, Inject, Post, Put, Req } from "@nestjs/common";
import type { z } from "zod";
import { ApiError } from "../errors.js";
import {
  CurrentPrincipal,
  type Principal,
  patTokenId,
  requireUser,
} from "../identity/principal.js";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import { ZBody, ZParam } from "../infra/validation/zod-params.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import type { ActorOpts } from "./catalog.service.js";
import { CatalogScopeService } from "./catalog-scope.service.js";
import {
  OrgPluginUploads,
  type OrgUploadResult,
  type OrgUploadReview,
} from "./org-plugin-uploads.js";
import {
  OrgUploadConfirmBody as ConfirmBody,
  OrgOwnedDeleteBody as DeleteBody,
  OrgOwnedPluginParams as OwnedParams,
  OrgOwnedShareableBody as ShareableBody,
  OrgUploadStagingParams as StagingParams,
} from "./org-plugin-uploads.schemas.js";
import { type OwnedDeletePreview, OwnedItems } from "./owned-items.js";

class OrgUploadStagingParamsDto extends createZodDto(StagingParams, "OrgUploadStagingParams") {}
class OrgUploadConfirmBodyDto extends createZodDto(ConfirmBody, "OrgUploadConfirmBody") {}
class OrgOwnedPluginParamsDto extends createZodDto(OwnedParams, "OrgOwnedPluginParams") {}
class OrgOwnedShareableBodyDto extends createZodDto(ShareableBody, "OrgOwnedShareableBody") {}
class OrgOwnedDeleteBodyDto extends createZodDto(DeleteBody, "OrgOwnedDeleteBody") {}

const actorOpts = (actor: ReturnType<typeof requireUser>): ActorOpts => {
  const tokenId = patTokenId(actor);
  return tokenId !== undefined ? { actorTokenId: tokenId } : {};
};

/**
 * An org admin's plugin uploads (`/api/v1/orgs/:orgId/catalog/uploads/*`, spec §14, rulings P3-7,
 * P3-8): a `.tgz` without an extension, prepared (one review) and confirmed like the super admin's
 * import, owned by the org. Writes re-check the org admin under the org row lock.
 */
@Controller("api/v1/orgs/:orgId/catalog/uploads")
export class OrgPluginUploadsController {
  constructor(@Inject(OrgPluginUploads) private readonly uploads: OrgPluginUploads) {}

  /**
   * Prepares an upload (the tgz as the raw body, `application/octet-stream`, at most
   * `packages.maxBytes`): `{ stagingId, review, update }`, the staging kept 24 hours for this org.
   * The checks of the platform import, plus: `customSkills` = deny with skills or agent templates,
   * or `customConnectors` = deny with connector templates -> 403 `catalog.custom_disabled`
   * (ruling P3-15'); a name live for another owner -> 409 `plugin.name_taken` (details
   * `[{ owner }]`); a dependency the org cannot use -> 409 `plugin.dependency_unavailable`
   * (details `[{ dependencies }]`).
   */
  @Post("file")
  @HttpCode(200)
  @OrgAction("catalog.upload")
  async upload(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Req() req: { body?: unknown },
  ): Promise<OrgUploadReview> {
    const actor = requireUser(principal);
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.byteLength === 0) {
      throw new ApiError(
        "unsupported_media_type",
        "Send the plugin package (.tgz) as the request body with content-type application/octet-stream",
      );
    }
    return this.uploads.prepare(
      actor.account.id,
      org.orgId,
      new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
      actorOpts(actor),
    );
  }

  /** The org's staged upload; unknown, expired, confirmed, another org's or the platform's -> 404. */
  @Get(":stagingId")
  @OrgAction("catalog.upload")
  staged(
    @CurrentOrg() org: OrgContext,
    @ZParam(OrgUploadStagingParamsDto) params: z.infer<typeof StagingParams>,
  ): Promise<OrgUploadReview> {
    return this.uploads.staged(org.orgId, params.stagingId);
  }

  /**
   * Confirms the org's staged upload (201 `{ item, outcome }`): a new item owned by the org, scope
   * `named: [org]`, not shown to other orgs, `shareable` as sent (default false), installed in the
   * org by the scope sync (`installed`); a new version of its own item (`updated`). The checks of
   * prepare run again under the item name's lock (the first confirm of a name wins). A package
   * with an extension waits for the super admin (`pending`, ruling P3-10): stored, its extension
   * name claimed (another package's -> 409 `extension.name_conflict` naming the owner), nothing
   * installed or usable until confirmed in 待确认; a later upload replaces the pending version
   * (P3-11). A version without an extension for an item whose first version still waits replaces
   * that upload and is installed at once (`installed`).
   */
  @Post(":stagingId/confirm")
  @HttpCode(201)
  @OrgAction("catalog.upload")
  confirm(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(OrgUploadStagingParamsDto) params: z.infer<typeof StagingParams>,
    @ZBody(OrgUploadConfirmBodyDto) body: z.infer<typeof ConfirmBody>,
  ): Promise<OrgUploadResult> {
    const actor = requireUser(principal);
    return this.uploads.confirm(
      actor.account.id,
      org.orgId,
      params.stagingId,
      {
        reviewHash: body.reviewHash,
        ...(body.shareable !== undefined && { shareable: body.shareable }),
      },
      actorOpts(actor),
    );
  }
}

/**
 * The org's own plugins (`/api/v1/orgs/:orgId/owned-plugins/*`, spec §14, P3-17 to P3-19): the
 * owner org's admin withdraws a pending upload, toggles 可共享 and deletes the plugin after a
 * preview. Another org's or a platform plugin -> 404. Writes re-check the org admin under the org
 * row lock.
 */
@Controller("api/v1/orgs/:orgId/owned-plugins")
export class OrgOwnedPluginsController {
  constructor(
    @Inject(CatalogScopeService) private readonly scope: CatalogScopeService,
    @Inject(OwnedItems) private readonly owned: OwnedItems,
  ) {}

  /**
   * Sets 可共享 (ruling P3-2: the plugin and its component rows in one transaction; turning it
   * off keeps the orgs already associated and hides it from new ones, ruling P3-25). 204.
   */
  @Put(":id/shareable")
  @HttpCode(204)
  @OrgAction("catalog.upload")
  async setShareable(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(OrgOwnedPluginParamsDto) params: z.infer<typeof OwnedParams>,
    @ZBody(OrgOwnedShareableBodyDto) body: z.infer<typeof ShareableBody>,
  ): Promise<void> {
    const actor = requireUser(principal);
    await this.owned.setShareable(
      org.orgId,
      actor.account.id,
      { kind: "plugin", id: params.id },
      body.shareable,
      actorOpts(actor),
    );
  }

  /**
   * What deleting the plugin does (P3-19, nothing written): `outcome` `removed` (no other org
   * uses it) or `transferred` (to the platform), `orgs` the other orgs using it, `agents` the
   * org's agents that lose it, and the `previewHash` to confirm.
   */
  @Post(":id/delete/preview")
  @HttpCode(200)
  @OrgAction("catalog.upload")
  previewDelete(
    @CurrentOrg() org: OrgContext,
    @ZParam(OrgOwnedPluginParamsDto) params: z.infer<typeof OwnedParams>,
  ): Promise<OwnedDeletePreview> {
    return this.owned.previewDelete(org.orgId, params.id);
  }

  /**
   * Deletes the plugin after its preview: removed, or transferred to the platform when another
   * org uses it (platform notice `ownership_transferred`). A preview that changed meanwhile ->
   * 409 `catalog.preview_stale`. 204.
   */
  @Post(":id/delete")
  @HttpCode(204)
  @OrgAction("catalog.upload")
  async delete(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(OrgOwnedPluginParamsDto) params: z.infer<typeof OwnedParams>,
    @ZBody(OrgOwnedDeleteBodyDto) body: z.infer<typeof DeleteBody>,
  ): Promise<void> {
    const actor = requireUser(principal);
    await this.owned.delete(
      org.orgId,
      actor.account.id,
      params.id,
      body.previewHash,
      actorOpts(actor),
    );
  }

  /**
   * Withdraws the org's pending upload of the plugin (ruling P3-10, no notice): a first version
   * is removed (its name free again), a new version's pending state cleared (the platform version
   * keeps running). Another org's or a platform plugin -> 404; nothing pending -> 409
   * `extension.not_pending`. 204.
   */
  @Delete(":id/pending")
  @HttpCode(204)
  @OrgAction("catalog.upload")
  async withdraw(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(OrgOwnedPluginParamsDto) params: z.infer<typeof OwnedParams>,
  ): Promise<void> {
    const actor = requireUser(principal);
    await this.scope.withdraw(org.orgId, actor.account.id, params.id, actorOpts(actor));
  }
}
