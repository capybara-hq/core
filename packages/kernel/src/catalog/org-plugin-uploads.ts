import { createHash } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { ApiError } from "../errors.js";
import type { SingleProviderNote } from "../extensions/single-provider.js";
import { canonicalJson } from "../tools/canonical-json.js";
import type { ActorOpts, CatalogItemView } from "./catalog.service.js";
import { CatalogScopeService } from "./catalog-scope.service.js";
import { PluginImport, type PluginReview, type StagedTarget } from "./plugin-import.js";
import { PlatformPluginUpdater, type PlatformUpdatePreview } from "./plugin-upgrade.js";

/** A staged org upload: the review, and the update preview of a new version (null: none). */
export interface OrgUploadReview {
  stagingId: string;
  /**
   * The review. For a new version of the org's own plugin its `reviewHash` covers the update
   * preview too (one hash, ruling P3-12): confirm with it.
   */
  review: PluginReview;
  /**
   * The platform update a new version of the org's own plugin without an extension applies at
   * once (ruling P3-12); null for a first upload and for a version with an extension (it waits for
   * the super admin, plan Task 6).
   */
  update: PlatformUpdatePreview | null;
}

/**
 * What a confirmed org upload did: `installed` (a new item, installed in the owner org by the scope
 * sync), `pending` (waiting for the super admin: an extension, plan Task 6), `updated` (a new
 * version of the org's own item, applied through the platform updater).
 */
export type OrgUploadOutcome = "installed" | "pending" | "updated";

/** An org upload's confirmation. */
export interface OrgUploadResult {
  item: CatalogItemView;
  outcome: OrgUploadOutcome;
  /**
   * The update installed the plugin's extension but left it disabled (a single-provider extension
   * point another enabled extension holds; `PlatformUpdateResult.extensionLeftDisabled`).
   */
  extensionLeftDisabled?: SingleProviderNote;
}

/** The hash an org confirms a new version with: the review's and the update's (P3-12). */
export function ownerUpdateHash(reviewHash: string, diffHash: string): string {
  return createHash("sha256")
    .update(canonicalJson({ reviewHash, diffHash }))
    .digest("hex")
    .slice(0, 32);
}

const reviewStale = (name: string, version: string) =>
  new ApiError(
    "plugin.review_stale",
    `The review of plugin ${name} ${version} is out of date (it changed, or its extension on this deployment changed since it was prepared); review it again`,
  );

/**
 * An org admin's plugin upload (spec §14.1 item 1, rulings P3-7, P3-8, P3-12, P3-13 to P3-15'): a
 * `.tgz` prepared and confirmed through {@link PluginImport} in owner mode (the org's own staging,
 * its admin re-checked under the org row lock), owned by the org with scope `named: [owner]`. After
 * the confirm's commit the item's scope sync is enqueued here (as `CatalogScopeService.confirmImport`
 * does; `PluginImport` cannot reach the scope service, which depends on it), and installs it in the
 * owner org.
 *
 * A new version of the org's own plugin without an extension (P3-12, P3-12') is reviewed with the
 * platform update it applies (`PlatformPluginUpdater.previewForOwner` on the staged target,
 * pre-flight F3) and one hash ({@link ownerUpdateHash}); the confirm checks it, commits the version,
 * then runs `updateAsOwner` with that diff. A failed update leaves the version imported; the same
 * tgz uploaded again gets an update-only review (F4) whose confirm retries the update. Pinned
 * suggestions are the plugin's own on a new version (they would change the reviewed update).
 */
@Injectable()
export class OrgPluginUploads {
  constructor(
    @Inject(PluginImport) private readonly pluginImport: PluginImport,
    @Inject(CatalogScopeService) private readonly scope: CatalogScopeService,
    @Inject(PlatformPluginUpdater) private readonly updater: PlatformPluginUpdater,
  ) {}

  /** Reads, checks and stages the uploaded tgz for the org (see `PluginImport.prepare`). */
  async prepare(
    actor: string,
    orgId: string,
    bytes: Uint8Array,
    opts: ActorOpts = {},
  ): Promise<OrgUploadReview> {
    const r = await this.pluginImport.prepare(
      actor,
      bytes,
      { kind: "file", ref: "upload" },
      { ...opts, owner: { orgId } },
    );
    return this.withUpdate(orgId, r.stagingId, r.review);
  }

  /** The org's own staged upload; another org's or the platform's -> 404 `plugin.staging_not_found`. */
  async staged(orgId: string, stagingId: string): Promise<OrgUploadReview> {
    const r = await this.pluginImport.staged(stagingId, { orgId });
    return this.withUpdate(orgId, r.stagingId, r.review);
  }

  /** Confirms the org's staged upload (applying a new version), then enqueues the scope sync. */
  async confirm(
    actor: string,
    orgId: string,
    stagingId: string,
    input: { reviewHash: string; shareable?: boolean },
    opts: ActorOpts = {},
  ): Promise<OrgUploadResult> {
    const st = await this.pluginImport.stagedTarget(stagingId, { orgId });
    if (!appliesAtOnce(st)) {
      const r = await this.pluginImport.confirm(actor, stagingId, input, {
        ...opts,
        owner: { orgId },
      });
      // A version waiting for the super admin is synced by their confirmation (P3-10)
      if (r.pending) return { item: r.item, outcome: "pending" };
      await this.scope.enqueueSync(r.item.id);
      return { item: r.item, outcome: r.firstVersion ? "installed" : "updated" };
    }
    // The one hash covers the review and the update (P3-12): both recomputed now
    const preview = await this.updater.previewForOwner(orgId, st.itemId, st.version, st.target);
    if (input.reviewHash !== ownerUpdateHash(st.reviewHash, preview.diffHash)) {
      throw reviewStale(preview.name, st.version);
    }
    const r = await this.pluginImport.confirm(
      actor,
      stagingId,
      {
        reviewHash: st.reviewHash,
        ...(input.shareable !== undefined && { shareable: input.shareable }),
      },
      { ...opts, owner: { orgId } },
    );
    // The version is committed; a failed update leaves it imported (uploading it again retries)
    const u = await this.updater.updateAsOwner(
      orgId,
      actor,
      r.item.id,
      st.version,
      preview.diffHash,
      opts,
    );
    return {
      item: await this.pluginImport.view(r.item.id),
      outcome: "updated",
      ...(u.extensionLeftDisabled !== undefined && {
        extensionLeftDisabled: u.extensionLeftDisabled,
      }),
    };
  }

  /** The review with the update preview of a new version and the combined hash (P3-12). */
  private async withUpdate(
    orgId: string,
    stagingId: string,
    review: PluginReview,
  ): Promise<OrgUploadReview> {
    const st = await this.pluginImport.stagedTarget(stagingId, { orgId });
    if (!appliesAtOnce(st)) return { stagingId, review, update: null };
    const update = await this.updater.previewForOwner(orgId, st.itemId, st.version, st.target);
    return {
      stagingId,
      review: { ...review, reviewHash: ownerUpdateHash(review.reviewHash, update.diffHash) },
      update,
    };
  }
}

/**
 * A new version of the org's own plugin without an extension: applied at once through the
 * platform updater (P3-12). Not while the item's first version still waits for the super admin:
 * such an upload replaces that first version instead (`PluginImport.commit`, plan Task 6).
 */
function appliesAtOnce(st: StagedTarget): boolean {
  return st.existing && !st.extension && !st.awaiting;
}
