import type { Logger } from "@capybara-hq/plugin-sdk";
import { ApiError } from "../errors.js";
import type { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { ProviderListError, type ProviderRegistry } from "../runtime/providers.js";
import type { StorageService } from "../storage/storage.service.js";
import type { ModelPurposesService } from "./purposes.js";

/** The model purpose `GenerateImage` calls (image generation spec §5.4; no fallback). */
export const IMAGE_PURPOSE = "image";

/** The image counts one call may ask for in an org: the config cap and the model's own limits. */
export interface ImageInputCaps {
  maxImages: number;
  maxReferenceImages: number;
}

/**
 * The one place the effective counts are decided (the tool's listed schema and
 * `ModelImages.prepare`'s refusals both read it): images per call are the lower of
 * `models.imageMaxPerCall` and the model's `maxImages`; reference images are the model's own.
 */
export function imageInputCaps(
  limits: { imageMaxPerCall: number },
  gen: { maxImages: number; maxReferenceImages: number },
): ImageInputCaps {
  return {
    maxImages: Math.min(limits.imageMaxPerCall, gen.maxImages),
    maxReferenceImages: gen.maxReferenceImages,
  };
}

/** Whether `GenerateImage` can run in an org now (with the counts it accepts), or why not. */
export type ImagePurposeState =
  | ({ usable: "usable" } & ImageInputCaps)
  | { usable: "no-model" | "no-storage" };

const MEMO_KEY = "image-purpose-state";

/**
 * The one predicate of `GenerateImage`'s availability (image generation spec §5.3), shared by the
 * tool's listing and the member-readable purpose availability the agent form reads, so the two
 * never disagree: the org's `image` purpose resolves to an image model the org can call now (an
 * unmapped, disabled or unavailable model, or a provider whose model list fails, is `no-model`),
 * and an object store is there to deliver the images (`no-storage`). A usable state carries the
 * effective {@link ImageInputCaps}. Any other failure is logged and rethrown: it is a kernel
 * fault, not an unavailable model. `memo` (one listing) keeps the answer for the listing's
 * `unavailable` and `specFor` calls.
 */
export function imagePurposeState(
  deps: {
    purposes: Pick<ModelPurposesService, "resolve">;
    providers: Pick<ProviderRegistry, "resolve">;
    storage: Pick<StorageService, "available">;
    log: Pick<Logger, "warn">;
    config: Pick<KernelConfigService, "get">;
  },
  orgId: string,
  memo?: Map<string, unknown>,
): Promise<ImagePurposeState> {
  const key = `${MEMO_KEY}:${orgId}`;
  const known = memo?.get(key) as Promise<ImagePurposeState> | undefined;
  if (known !== undefined) return known;
  const state = compute(deps, orgId);
  memo?.set(key, state);
  return state;
}

async function compute(
  deps: Parameters<typeof imagePurposeState>[0],
  orgId: string,
): Promise<ImagePurposeState> {
  let gen: { maxImages: number; maxReferenceImages: number } | undefined;
  try {
    const target = await deps.purposes.resolve(orgId, IMAGE_PURPOSE);
    const { info } = await deps.providers.resolve(orgId, target.model, {
      kind: "image_generation",
    });
    gen = info.imageGeneration;
  } catch (e) {
    if (e instanceof ProviderListError) return { usable: "no-model" };
    if (
      e instanceof ApiError &&
      (e.code === "model.unconfigured" || e.code === "agent.model_unavailable")
    ) {
      return { usable: "no-model" };
    }
    deps.log.warn("image purpose availability check failed", { orgId, err: e });
    throw e;
  }
  if (gen === undefined) return { usable: "no-model" };
  if (!deps.storage.available) return { usable: "no-storage" };
  return { usable: "usable", ...imageInputCaps(deps.config.get().models, gen) };
}
