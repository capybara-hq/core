import { Controller, Delete, Get, HttpCode, Inject, Post, Req } from "@nestjs/common";
import { z } from "zod";
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
import type { ActorOpts, CatalogItemView } from "./catalog.service.js";
import { CatalogScopeService } from "./catalog-scope.service.js";
import {
  OrgPluginUploads,
  type OrgUploadOutcome,
  type OrgUploadReview,
} from "./org-plugin-uploads.js";

const StagingParams = z.object({ stagingId: z.string().min(1).max(100) });
const OwnedParams = z.object({ id: z.string().min(1).max(100) });

const ConfirmBody = z
  .object({
    reviewHash: z.string().min(1).max(128),
    /** The org shares the new item with other orgs (default false, P3-16). */
    shareable: z.boolean().optional(),
    /** Skill names suggested as pinned (spec §9.1); omitted keeps the plugin's flags. */
    pinnedSuggestions: z.array(z.string().min(1).max(64)).max(50).optional(),
  })
  .strict();

class OrgUploadStagingParams extends createZodDto(StagingParams, "OrgUploadStagingParams") {}
class OrgUploadConfirmBody extends createZodDto(ConfirmBody, "OrgUploadConfirmBody") {}
class OrgOwnedPluginParams extends createZodDto(OwnedParams, "OrgOwnedPluginParams") {}

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
    @ZParam(OrgUploadStagingParams) params: z.infer<typeof StagingParams>,
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
    @ZParam(OrgUploadStagingParams) params: z.infer<typeof StagingParams>,
    @ZBody(OrgUploadConfirmBody) body: z.infer<typeof ConfirmBody>,
  ): Promise<{ item: CatalogItemView; outcome: OrgUploadOutcome }> {
    const actor = requireUser(principal);
    return this.uploads.confirm(
      actor.account.id,
      org.orgId,
      params.stagingId,
      {
        reviewHash: body.reviewHash,
        ...(body.shareable !== undefined && { shareable: body.shareable }),
        ...(body.pinnedSuggestions !== undefined && { pinnedSuggestions: body.pinnedSuggestions }),
      },
      actorOpts(actor),
    );
  }
}

/**
 * The org's own plugins (`/api/v1/orgs/:orgId/owned-plugins/*`, spec §14): the owner org's admin
 * withdraws a pending upload. Writes re-check the org admin under the org row lock.
 */
@Controller("api/v1/orgs/:orgId/owned-plugins")
export class OrgOwnedPluginsController {
  constructor(@Inject(CatalogScopeService) private readonly scope: CatalogScopeService) {}

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
    @ZParam(OrgOwnedPluginParams) params: z.infer<typeof OwnedParams>,
  ): Promise<void> {
    const actor = requireUser(principal);
    await this.scope.withdraw(org.orgId, actor.account.id, params.id, actorOpts(actor));
  }
}
