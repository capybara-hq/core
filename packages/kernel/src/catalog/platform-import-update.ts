import { Inject, Injectable } from "@nestjs/common";
import { ApiError } from "../errors.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import type { ActorOpts, CatalogItemView } from "./catalog.service.js";
import { PluginImport, type StagedTarget } from "./plugin-import.js";
import {
  PlatformPluginUpdater,
  type PlatformUpdatePreview,
  type PlatformUpdateResult,
} from "./plugin-upgrade.js";

/** `POST /api/v1/admin/catalog/imports/:stagingId/update`: the import and the update it applied. */
export interface PlatformImportUpdateResult {
  item: CatalogItemView;
  update: PlatformUpdateResult;
}

const notInstalled = (name: string) =>
  new ApiError(
    "plugin.upgrade_target_invalid",
    `Plugin ${name} is not a platform plugin of this deployment yet; install it with the import review instead`,
    [{ reason: "not_installed" }],
  );

/**
 * The platform's update of an installed plugin to a version staged for import (the one wizard of
 * the admin plugin pages, maintainer decision 2026-11-13): the import review (prepared as any
 * import, `PluginImport.prepare`) and the platform update preview of the staged version
 * ({@link preview}: `PlatformPluginUpdater.previewStaged`, the target read from the staging) are
 * confirmed together ({@link confirm} with the review's `reviewHash` and the preview's `diffHash`).
 * Nothing is written before that confirm: cancelling the wizard leaves only the staging row, which
 * expires like any staged import.
 *
 * The confirm holds the item's update lock (`PlatformPluginUpdater.withItemLock`, one per item
 * across replicas: another update -> 409 `plugin.install_in_progress`), recomputes the preview
 * (another `diffHash` -> 409 `plugin.upgrade_stale`, nothing written), commits the import without
 * deploying its extension (the permission snapshot is written as the review approved it), then
 * runs the platform update, which moves the extension with its own rollback and writes the
 * components in one transaction. When that update fails, the platform stays on its version, the
 * extension where it was and its previous approval is put back; the imported version stays in the
 * catalog (its 版本 tab, and 更新到 retries the update with the plain update preview): 409
 * `plugin.imported_not_updated` says so, with the cause in the details. No in-process state.
 */
@Injectable()
export class PlatformImportUpdate {
  constructor(
    @Inject(PluginImport) private readonly pluginImport: PluginImport,
    @Inject(PlatformPluginUpdater) private readonly updater: PlatformPluginUpdater,
    @Inject(KERNEL_LOGGER) private readonly log: KernelLogger,
  ) {}

  /**
   * The platform update the staged version would apply (writes nothing). The staging must be a
   * platform staging (else 404 `plugin.staging_not_found`) of a new version of a live
   * platform-owned plugin (else 409 `plugin.upgrade_target_invalid`, reason `not_installed`); the
   * updater's refusals apply as for any update preview. `needsApproval` is false: the confirm
   * approves the permissions the review shows.
   */
  async preview(stagingId: string): Promise<PlatformUpdatePreview> {
    const st = await this.target(stagingId);
    return this.previewOf(st);
  }

  /** Confirms the import and the update together (see the class comment). */
  async confirm(
    actor: string,
    stagingId: string,
    input: { reviewHash: string; diffHash: string },
    opts: ActorOpts = {},
  ): Promise<PlatformImportUpdateResult> {
    const st = await this.target(stagingId);
    return this.updater.withItemLock(st.itemId, async () => {
      const preview = await this.previewOf(st);
      if (preview.diffHash !== input.diffHash) {
        throw new ApiError(
          "plugin.upgrade_stale",
          `What updating plugin ${preview.name} to ${st.version} does changed since the preview; preview it again`,
        );
      }
      // The review hash is checked by the import's confirm (409 plugin.review_stale, nothing
      // written)
      const imported = await this.pluginImport.confirm(
        actor,
        stagingId,
        { reviewHash: input.reviewHash, deploy: false },
        opts,
      );
      try {
        const update = await this.updater.updateHeld(
          actor,
          st.itemId,
          { version: st.version, diffHash: input.diffHash },
          opts,
        );
        return { item: await this.pluginImport.view(st.itemId), update };
      } catch (e) {
        let restored = imported.approval === undefined;
        if (imported.approval !== undefined) {
          try {
            restored = await this.pluginImport.restoreApproval(actor, imported.approval, opts);
          } catch (err) {
            this.log.error("cannot restore an extension's approval after a failed update", {
              itemId: st.itemId,
              err,
            });
          }
        }
        const cause = e instanceof ApiError ? e : undefined;
        throw new ApiError(
          "plugin.imported_not_updated",
          `Version ${st.version} of plugin ${preview.name} was imported, but updating the platform to it failed (${cause?.code ?? "internal"}); the platform stays on ${preview.from ?? "(none)"}. Update to ${st.version} from the plugin's page to retry`,
          [
            {
              version: st.version,
              from: preview.from,
              code: cause?.code ?? "internal",
              ...(cause !== undefined && { message: cause.message }),
              ...(cause?.details !== undefined && { causeDetails: cause.details }),
              approvalRestored: restored,
            },
          ],
        );
      }
    });
  }

  /** The staged target, which must be a new version of a live platform-owned plugin. */
  private async target(stagingId: string): Promise<StagedTarget> {
    const st = await this.pluginImport.stagedTarget(stagingId);
    if (!st.existing) {
      throw notInstalled((await this.pluginImport.staged(stagingId)).review.name);
    }
    return st;
  }

  private async previewOf(st: StagedTarget): Promise<PlatformUpdatePreview> {
    const p = await this.updater.previewStaged(st.itemId, st.version, st.target);
    return p.extension === null ? p : { ...p, extension: { ...p.extension, needsApproval: false } };
  }
}
