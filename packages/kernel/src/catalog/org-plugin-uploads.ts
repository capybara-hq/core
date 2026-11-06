import { Inject, Injectable } from "@nestjs/common";
import type { ActorOpts, CatalogItemView } from "./catalog.service.js";
import { CatalogScopeService } from "./catalog-scope.service.js";
import { PluginImport, type PluginReview } from "./plugin-import.js";
import type { PlatformUpdatePreview } from "./plugin-upgrade.js";

/** A staged org upload: the review, and the update preview of a new version (null: none). */
export interface OrgUploadReview {
  stagingId: string;
  review: PluginReview;
  /**
   * The platform update a new version of the org's own plugin will apply (ruling P3-12); null for
   * a first upload. Always null until owner updates are built (plan Task 5).
   */
  update: PlatformUpdatePreview | null;
}

/**
 * What a confirmed org upload did: `installed` (a new item, installed in the owner org by the scope
 * sync), `pending` (waiting for the super admin: an extension, plan Task 6), `updated` (a new
 * version of the org's own item).
 */
export type OrgUploadOutcome = "installed" | "pending" | "updated";

/**
 * An org admin's plugin upload (spec §14.1 item 1, rulings P3-7, P3-8, P3-13 to P3-15'): a `.tgz`
 * prepared and confirmed through {@link PluginImport} in owner mode (the org's own staging, its
 * admin re-checked under the org row lock), owned by the org with scope `named: [owner]`. After the
 * confirm's commit the item's scope sync is enqueued here (as `CatalogScopeService.confirmImport`
 * does; `PluginImport` cannot reach the scope service, which depends on it), and installs it in the
 * owner org.
 */
@Injectable()
export class OrgPluginUploads {
  constructor(
    @Inject(PluginImport) private readonly pluginImport: PluginImport,
    @Inject(CatalogScopeService) private readonly scope: CatalogScopeService,
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
    return { stagingId: r.stagingId, review: r.review, update: null };
  }

  /** The org's own staged upload; another org's or the platform's -> 404 `plugin.staging_not_found`. */
  async staged(orgId: string, stagingId: string): Promise<OrgUploadReview> {
    const r = await this.pluginImport.staged(stagingId, { orgId });
    return { stagingId: r.stagingId, review: r.review, update: null };
  }

  /** Confirms the org's staged upload, then enqueues the item's scope sync. */
  async confirm(
    actor: string,
    orgId: string,
    stagingId: string,
    input: { reviewHash: string; shareable?: boolean; pinnedSuggestions?: string[] },
    opts: ActorOpts = {},
  ): Promise<{ item: CatalogItemView; outcome: OrgUploadOutcome }> {
    const r = await this.pluginImport.confirm(actor, stagingId, input, {
      ...opts,
      owner: { orgId },
    });
    await this.scope.enqueueSync(r.item.id);
    // Plan Task 5 applies a new version through the platform updater; until then it is imported
    return { item: r.item, outcome: r.created ? "installed" : "updated" };
  }
}
