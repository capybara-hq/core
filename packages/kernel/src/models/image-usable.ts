import type { Logger } from "@capybara-hq/plugin-sdk";
import { ApiError } from "../errors.js";
import { ProviderListError, type ProviderRegistry } from "../runtime/providers.js";
import type { StorageService } from "../storage/storage.service.js";
import type { ModelPurposesService } from "./purposes.js";

/** The model purpose `GenerateImage` calls (image generation spec §5.4; no fallback). */
export const IMAGE_PURPOSE = "image";

/** Whether `GenerateImage` can run in an org now, and if not, why. */
export type ImageUsable = "usable" | "no-model" | "no-storage";

/**
 * The one predicate of `GenerateImage`'s availability (image generation spec §5.3), shared by the
 * tool's listing and the member-readable purpose availability the agent form reads, so the two
 * never disagree: the org's `image` purpose resolves to an image model the org can call now (an
 * unmapped, disabled or unavailable model, or a provider whose model list fails, is `no-model`),
 * and an object store is there to deliver the images (`no-storage`). Any other failure is logged
 * and rethrown: it is a kernel fault, not an unavailable model.
 */
export async function imagePurposeUsable(
  deps: {
    purposes: Pick<ModelPurposesService, "resolve">;
    providers: Pick<ProviderRegistry, "resolve">;
    storage: Pick<StorageService, "available">;
    log: Pick<Logger, "warn">;
  },
  orgId: string,
): Promise<ImageUsable> {
  try {
    const target = await deps.purposes.resolve(orgId, IMAGE_PURPOSE);
    await deps.providers.resolve(orgId, target.model, { kind: "image_generation" });
  } catch (e) {
    if (e instanceof ProviderListError) return "no-model";
    if (
      e instanceof ApiError &&
      (e.code === "model.unconfigured" || e.code === "agent.model_unavailable")
    ) {
      return "no-model";
    }
    deps.log.warn("image purpose availability check failed", { orgId, err: e });
    throw e;
  }
  return deps.storage.available ? "usable" : "no-storage";
}
