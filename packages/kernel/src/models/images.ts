import {
  type HookMediaPlaceholder,
  type HookScope,
  IMAGE_MEDIA_TYPES,
  type ImageAspectRatio,
  type ImageGenerateRequest,
  type ImageGenerateResult,
  type ImageMediaType,
  type ImageRequestHookPayload,
  type ImageResponseHookPayload,
  type ImageSize,
  isModelError,
  type Logger,
  MEDIA_LIMITS,
  ModelError,
  type ModelImageGenerationInfo,
  pickImageSize,
  sanitizeParams,
  validateImageGenerateResult,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { ApiError } from "../errors.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import {
  base64Bytes,
  fireObserve,
  type HookDenial,
  type HookRunner,
} from "../runtime/hook-calls.js";
import { modelDeniedText } from "../runtime/model-call.js";
import { ProviderRegistry } from "../runtime/providers.js";
import { ModelPurposesService } from "./purposes.js";

/** What a caller asks for (the tool or `ctx.models.generateImage`); references are bytes already. */
export interface ImageCallInput {
  prompt: string;
  /** An exact size (only `ctx.models`); must be one the model declares. */
  size?: ImageSize;
  aspectRatio?: ImageAspectRatio;
  /** Images to produce (default 1). */
  n?: number;
  /** Base64 reference images. */
  referenceImages?: { mediaType: ImageMediaType; data: string }[];
}

/** A validated call, ready for {@link ModelImages.run}. */
export interface PreparedImageCall {
  ref: { provider: string; model: string };
  info: ModelImageGenerationInfo;
  request: ImageGenerateRequest;
}

/** Who makes the call, as the hook payloads name it. */
export type ImageHookIdentity =
  | { kind: "conversation"; scope: HookScope; step: number; callId: string }
  | { kind: "extension"; extension: string; imagePurpose: string };

/** A `model.request` policy hook denied the call; nothing was sent. The caller records it. */
export class ImageCallDenied extends Error {
  constructor(readonly verdict: HookDenial) {
    super(modelDeniedText(verdict.plugin, verdict.reason));
    this.name = "ImageCallDenied";
  }
}

/**
 * Image generation calls (image generation spec §5.1, §5.2, §5.6, §6), shared by the
 * `GenerateImage` tool and `ctx.models.generateImage`:
 * - {@link prepare} resolves the org's target for a purpose of kind `image_generation` (no
 *   fallback: unmapped is `model.unconfigured`), checks the prompt (code points, at most
 *   `models.imagePromptMaxChars`), the count (at most `models.imageMaxPerCall` and the model's
 *   `maxImages`), the reference images (count, media type, `MEDIA_LIMITS.imageBytes`), picks the
 *   size ({@link pickImageSize}) and sanitizes the mapping's params against the model's
 *   declarations. Every refusal is `ApiError("validation_failed")` with an actionable text.
 * - {@link run} fires `model.request` (placeholders for references; a denial throws
 *   {@link ImageCallDenied} and sends nothing), calls `generateImage` within
 *   `models.imageTimeoutMs`, checks the result ({@link validateImageGenerateResult}: invalid is a
 *   `ModelError("server")`) and fires `model.response` (observe; media types and byte sizes, never
 *   bytes), also when the call failed, but not when the caller's signal aborted it.
 * It stores nothing and records no usage: the callers do.
 */
@Injectable()
export class ModelImages {
  constructor(
    @Inject(ModelPurposesService)
    private readonly purposes: Pick<ModelPurposesService, "resolve">,
    @Inject(ProviderRegistry) private readonly providers: Pick<ProviderRegistry, "resolve">,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<Logger, "warn">,
    /** `models.imageTimeoutMs`, `imageMaxPerCall`, `imagePromptMaxChars` (hot, read per call). */
    @Inject(KernelConfigService) private readonly config: Pick<KernelConfigService, "get">,
  ) {}

  async prepare(orgId: string, purpose: string, input: ImageCallInput): Promise<PreparedImageCall> {
    const limits = this.config.get().models;
    const bad = (text: string): never => {
      throw new ApiError("validation_failed", text);
    };
    const prompt = typeof input.prompt === "string" ? input.prompt : "";
    if (prompt.trim() === "") bad("prompt must not be empty");
    const chars = [...prompt].length;
    if (chars > limits.imagePromptMaxChars) {
      bad(`prompt has ${chars} characters; the limit is ${limits.imagePromptMaxChars}`);
    }

    const target = await this.purposes.resolve(orgId, purpose);
    const { info } = await this.providers.resolve(orgId, target.model, {
      kind: "image_generation",
    });
    const gen = info.imageGeneration;
    if (gen === undefined) {
      // the registry refuses such models; kept as a guard
      throw new ApiError(
        "model.unconfigured",
        `The model configured for the "${purpose}" purpose cannot generate images`,
      );
    }

    const cap = Math.min(limits.imageMaxPerCall, gen.maxImages);
    const n = input.n ?? 1;
    if (!Number.isInteger(n) || n < 1) bad(`n must be a whole number from 1 to ${cap}`);
    if (n > cap) bad(`n must be at most ${cap} for this model`);

    const refs = input.referenceImages ?? [];
    if (refs.length > gen.maxReferenceImages) {
      bad(
        gen.maxReferenceImages === 0
          ? "this model takes no reference images"
          : `this model takes at most ${gen.maxReferenceImages} reference images`,
      );
    }
    refs.forEach((r, i) => {
      const okType = (IMAGE_MEDIA_TYPES as readonly string[]).includes(r?.mediaType);
      const okData = typeof r?.data === "string" && r.data !== "";
      if (!okType || !okData || base64Bytes(r.data) > MEDIA_LIMITS.imageBytes) {
        bad(`reference image ${i} must be PNG, JPEG, GIF or WebP up to 5 MB`);
      }
    });

    const size = pickImageSize(gen, {
      ...(input.size !== undefined && { size: input.size }),
      ...(input.aspectRatio !== undefined && { aspectRatio: input.aspectRatio }),
    });
    if (!size.ok) return bad(size.error);

    const params = sanitizeParams(info.parameters ?? [], target.params).value;
    return {
      ref: { provider: target.model.provider, model: target.model.model },
      info: structuredClone(gen),
      request: {
        model: target.model.model,
        prompt,
        size: size.size,
        n,
        ...(refs.length > 0 && {
          referenceImages: refs.map((r) => ({ mediaType: r.mediaType, data: r.data })),
        }),
        params,
      },
    };
  }

  async run(
    orgId: string,
    prepared: PreparedImageCall,
    who: ImageHookIdentity,
    signal: AbortSignal,
    hooks: HookRunner | undefined,
  ): Promise<ImageGenerateResult & { latencyMs: number }> {
    const { ref, info, request } = prepared;
    const { provider } = await this.providers.resolve(orgId, ref, { kind: "image_generation" });
    if (provider.generateImage === undefined) {
      throw new ApiError(
        "model.unconfigured",
        `Model ${ref.provider}/${ref.model} cannot generate images`,
      );
    }
    const generate = provider.generateImage.bind(provider) as NonNullable<
      typeof provider.generateImage
    >;
    const identity = identityFields(who);
    const base = { purpose: "image" as const, orgId, provider: ref.provider, model: ref.model };

    if (hooks?.has("model.request")) {
      const payload: ImageRequestHookPayload = {
        ...base,
        prompt: request.prompt,
        size: { ...request.size },
        n: request.n,
        referenceImages: (request.referenceImages ?? []).map(
          (r): HookMediaPlaceholder => ({
            type: "media_omitted",
            kind: "image",
            mediaType: r.mediaType,
            size: base64Bytes(r.data),
          }),
        ),
        ...identity,
      };
      // an abort while the hooks run rejects with the caller's reason (never a deny)
      const verdict = await hooks.run("model.request", payload, signal);
      if (!verdict.allowed) throw new ImageCallDenied(verdict);
    }
    signal.throwIfAborted();

    const sentAt = Date.now();
    const respond = (r: Omit<ImageResponseHookPayload, keyof typeof base | "latencyMs">) => {
      if (!hooks) return;
      fireObserve(
        hooks,
        "model.response",
        { ...base, ...identity, ...r, latencyMs: Date.now() - sentAt },
        signal,
        this.log,
      );
    };
    let res: ImageGenerateResult;
    try {
      res = await this.callWithTimeout(generate, request, signal, ref);
      const problem = validateImageGenerateResult(request, info, res);
      if (problem !== null) {
        throw new ModelError(
          "server",
          `Model ${ref.provider}/${ref.model} returned an invalid image result: ${problem}`,
        );
      }
    } catch (err) {
      // a call the caller aborted gets no model.response (as a chat call the user stopped)
      if (!signal.aborted) {
        respond({
          outcome: "failed",
          images: [],
          usage: null,
          errorCode: isModelError(err) ? `model.${err.kind}` : "model.unknown",
        });
      }
      throw err;
    }
    const latencyMs = Date.now() - sentAt;
    respond({
      outcome: "ok",
      images: res.images.map((i) => ({ mediaType: i.mediaType, size: base64Bytes(i.data) })),
      ...(typeof res.revisedPrompt === "string" && { revisedPrompt: res.revisedPrompt }),
      usage: res.usage ?? null,
    });
    return { ...res, latencyMs };
  }

  /**
   * One `generateImage` call, limited by `models.imageTimeoutMs` (hot, read per call): at the limit
   * the call's signal aborts and the call fails with `ModelError("timeout")`, even when the
   * provider ignores the signal (its late answer is dropped).
   */
  private async callWithTimeout(
    generate: (
      req: ImageGenerateRequest,
      opts: { signal: AbortSignal },
    ) => Promise<ImageGenerateResult>,
    request: ImageGenerateRequest,
    signal: AbortSignal,
    ref: { provider: string; model: string },
  ): Promise<ImageGenerateResult> {
    const ms = this.config.get().models.imageTimeoutMs;
    const timer = new AbortController();
    const both = AbortSignal.any([signal, timer.signal]);
    let handle: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const call = Promise.resolve().then(() => generate(request, { signal: both }));
    call.catch(() => {});
    try {
      return await Promise.race([
        call,
        new Promise<never>((_, reject) => {
          handle = setTimeout(() => {
            const err = new ModelError(
              "timeout",
              `Model ${ref.provider}/${ref.model} did not finish generating images within ${ms} ms`,
            );
            timer.abort(err);
            reject(err);
          }, ms);
          onAbort = () => reject(signal.reason);
          signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
    } finally {
      clearTimeout(handle);
      // the caller's signal may outlive the call (an extension's ctx.signal): drop the listener
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  }
}

/** The identity fields of the hook payloads: conversation fields or the extension's. */
function identityFields(
  who: ImageHookIdentity,
): Pick<
  ImageRequestHookPayload,
  | "accountId"
  | "agentId"
  | "agentVersion"
  | "conversationId"
  | "runId"
  | "parent"
  | "step"
  | "callId"
  | "extension"
  | "imagePurpose"
> {
  if (who.kind === "extension") {
    return { extension: who.extension, imagePurpose: who.imagePurpose };
  }
  const s = who.scope;
  return {
    accountId: s.accountId,
    agentId: s.agentId,
    agentVersion: s.agentVersion,
    conversationId: s.conversationId,
    runId: s.runId,
    ...(s.parent !== undefined && { parent: { ...s.parent } }),
    step: who.step,
    callId: who.callId,
  };
}
