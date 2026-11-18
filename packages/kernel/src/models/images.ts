import {
  type ExtensionImageGenerateRequest,
  type ExtensionImageGenerateResult,
  type ExtensionModelTarget,
  type HookMediaPlaceholder,
  type HookScope,
  IMAGE_ASPECT_RATIOS,
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
import { isExtensionEnabled } from "../extensions/enabled.js";
import { audit } from "../identity/audit.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import {
  base64Bytes,
  fireObserve,
  type HookDenial,
  type HookRunner,
  imageDeniedAudit,
} from "../runtime/hook-calls.js";
import { modelDeniedText } from "../runtime/model-call.js";
import { ProviderRegistry } from "../runtime/providers.js";
import { UsageReportJobs } from "../runtime/usage-report-jobs.js";
import type { DeclaredModelPurposes } from "./embeddings.js";
import { ModelPurposesService } from "./purposes.js";

/** Standard padded base64 (the check `validateImageGenerateResult` applies to results). */
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
/** `MEDIA_LIMITS.imageBytes` in MB, for the reference-image error text. */
const IMAGE_LIMIT_MB = MEDIA_LIMITS.imageBytes / 1_048_576;

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
 * They store nothing and record no usage: the callers do. For extensions (spec §5.5, §8, §9),
 * {@link generateForExtension} is `ctx.models.generateImage`: the admission of `ctx.models.embed`
 * for kind `image_generation` (a purpose the extension declared with that kind, otherwise
 * `model.purpose_unknown`; an org that enabled the extension, otherwise `extension.not_enabled`),
 * then {@link prepare} and {@link run}; a policy denial writes one `hook.denied` audit row and
 * rejects with `ApiError("model.hook_denied")`; a successful call writes one `model_usage` row
 * (`kind = 'image_generation'`, its input tokens and images) and owes its `usage.report` delivery
 * in the same transaction ({@link recordExtensionUsage}). A call that fails or is denied records
 * no usage. The kernel stores no image of an extension call: the extension gets the bytes.
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
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    /** An extension call's `usage.report` delivery, owed with its `model_usage` row. */
    @Inject(UsageReportJobs) private readonly usage: Pick<UsageReportJobs, "oweModelUsage">,
  ) {}

  /** Refuses a purpose `plugin` did not declare with kind `image_generation`, or an org it is off in. */
  private async admit(
    plugin: string,
    declared: DeclaredModelPurposes,
    orgId: string,
    purpose: string,
  ): Promise<void> {
    if (!declared.some((d) => d.purpose === purpose && d.kind === "image_generation")) {
      throw new ApiError(
        "model.purpose_unknown",
        `Extension ${plugin} declared no image generation purpose "${purpose}" in permissions.models`,
      );
    }
    if (!(await isExtensionEnabled(this.kdb.db, orgId, plugin))) {
      throw new ApiError(
        "extension.not_enabled",
        `Extension ${plugin} is not enabled in organization ${orgId}`,
      );
    }
  }

  /**
   * `ctx.models.generateImage` for `plugin` (its declared purposes), aborted by `signal` (the
   * instance's) and the request's own signal; `hooks` is the host's hook registry
   * (`model.request`, `model.response`), absent only for a ctx built without a host (tests).
   */
  async generateForExtension(
    plugin: string,
    declared: DeclaredModelPurposes,
    request: ExtensionImageGenerateRequest,
    signal: AbortSignal,
    hooks: HookRunner | undefined,
  ): Promise<ExtensionImageGenerateResult> {
    checkExtensionRequest(request);
    // a copy, read once: what the hooks see is what is sent, whatever the extension does with its
    // own request object meanwhile
    const { orgId, purpose } = request;
    const input: ImageCallInput = {
      prompt: request.prompt,
      ...(request.size !== undefined && {
        size: { width: request.size.width, height: request.size.height },
      }),
      ...(request.aspectRatio !== undefined && { aspectRatio: request.aspectRatio }),
      ...(request.n !== undefined && { n: request.n }),
      ...(request.referenceImages !== undefined && {
        referenceImages: request.referenceImages.map((r) => ({
          mediaType: r?.mediaType,
          data: r?.data,
        })),
      }),
    };
    await this.admit(plugin, declared, orgId, purpose);
    const prepared = await this.prepare(orgId, purpose, input);
    const callSignal = request.signal ? AbortSignal.any([signal, request.signal]) : signal;
    const who: ImageHookIdentity = { kind: "extension", extension: plugin, imagePurpose: purpose };
    let res: ImageGenerateResult;
    try {
      res = await this.run(orgId, prepared, who, callSignal, hooks);
    } catch (err) {
      if (!(err instanceof ImageCallDenied)) throw err;
      const call = {
        orgId,
        extension: plugin,
        imagePurpose: purpose,
        provider: prepared.ref.provider,
        model: prepared.ref.model,
      };
      await audit(this.kdb.db, imageDeniedAudit(call, err.verdict));
      this.log.warn("image generation call blocked by a policy hook", {
        plugin,
        orgId,
        hookPlugin: err.verdict.plugin,
        cause: err.verdict.cause,
      });
      throw new ApiError("model.hook_denied", err.message);
    }
    await this.recordExtensionUsage(plugin, orgId, purpose, prepared.ref, res);
    return {
      images: res.images.map((i) => ({ mediaType: i.mediaType, data: i.data })),
      ...(typeof res.revisedPrompt === "string" && { revisedPrompt: res.revisedPrompt }),
      model: { provider: prepared.ref.provider, id: prepared.ref.model },
      size: { width: prepared.request.size.width, height: prepared.request.size.height },
    };
  }

  /**
   * `ctx.models.describe` of an image generation purpose for `plugin`: the org's effective target
   * with its `imageGeneration` facts, or null when the purpose maps to no model the org can use.
   */
  async describeForExtension(
    plugin: string,
    declared: DeclaredModelPurposes,
    req: { orgId: string; purpose: string },
  ): Promise<ExtensionModelTarget | null> {
    if (typeof req?.orgId !== "string" || typeof req.purpose !== "string") {
      throw new ApiError("validation_failed", "describe needs orgId and purpose strings");
    }
    await this.admit(plugin, declared, req.orgId, req.purpose);
    try {
      const target = await this.purposes.resolve(req.orgId, req.purpose);
      const { info } = await this.providers.resolve(req.orgId, target.model, {
        kind: "image_generation",
      });
      if (info.imageGeneration === undefined) return null;
      return {
        provider: target.model.provider,
        id: target.model.model,
        kind: "image_generation",
        imageGeneration: structuredClone(info.imageGeneration),
      };
    } catch (e) {
      if (e instanceof ApiError && e.code === "model.unconfigured") return null;
      throw e;
    }
  }

  /**
   * One `model_usage` row of an extension call (`kind = 'image_generation'`, the result's tokens
   * and images) with its owed `usage.report` delivery, in one transaction.
   */
  @Transactional()
  private async recordExtensionUsage(
    plugin: string,
    orgId: string,
    purpose: string,
    ref: { provider: string; model: string },
    res: ImageGenerateResult,
  ): Promise<void> {
    const row = await this.kdb.db
      .insertInto("model_usage")
      .values({
        org_id: orgId,
        extension: plugin,
        purpose,
        kind: "image_generation",
        provider: ref.provider,
        model: ref.model,
        input_tokens: countOf(res.usage?.inputTokens) ?? 0,
        output_tokens: countOf(res.usage?.outputTokens) ?? 0,
        cache_read_tokens: countOf(res.usage?.cacheReadTokens) ?? 0,
        cache_write_tokens: countOf(res.usage?.cacheWriteTokens) ?? 0,
        output_images: countOf(res.usage?.outputImages) ?? res.images.length,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await this.usage.oweModelUsage(row.id, orgId);
  }

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
      const okData = typeof r?.data === "string" && BASE64.test(r.data);
      if (!okType || !okData || base64Bytes(r.data) > MEDIA_LIMITS.imageBytes) {
        bad(`reference image ${i} must be PNG, JPEG, GIF or WebP up to ${IMAGE_LIMIT_MB} MB`);
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

/** A usable usage count: a finite non-negative number, rounded; otherwise undefined. */
function countOf(n: unknown): number | undefined {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.round(n) : undefined;
}

/**
 * The shape of a `ctx.models.generateImage` request (an extension is untyped JavaScript at run
 * time); the values themselves (prompt, size, count, references) are checked by `prepare`.
 */
function checkExtensionRequest(req: ExtensionImageGenerateRequest): void {
  const bad = (why: string): never => {
    throw new ApiError("validation_failed", `Invalid generateImage request: ${why}`);
  };
  if (typeof req !== "object" || req === null) bad("expected an object");
  if (typeof req.orgId !== "string" || req.orgId === "") bad("orgId must be a string");
  if (typeof req.purpose !== "string" || req.purpose === "") bad("purpose must be a string");
  if (typeof req.prompt !== "string") bad("prompt must be a string");
  if (
    req.size !== undefined &&
    (typeof req.size !== "object" ||
      req.size === null ||
      !Number.isInteger(req.size.width) ||
      !Number.isInteger(req.size.height))
  ) {
    bad("size must be { width, height } in whole pixels");
  }
  if (
    req.aspectRatio !== undefined &&
    !(IMAGE_ASPECT_RATIOS as readonly string[]).includes(req.aspectRatio)
  ) {
    bad(`aspectRatio must be one of ${IMAGE_ASPECT_RATIOS.join(", ")}`);
  }
  if (req.n !== undefined && typeof req.n !== "number") bad("n must be a number");
  if (req.referenceImages !== undefined && !Array.isArray(req.referenceImages)) {
    bad("referenceImages must be an array");
  }
  if (req.signal !== undefined && !(req.signal instanceof AbortSignal)) {
    bad("signal must be an AbortSignal");
  }
}
