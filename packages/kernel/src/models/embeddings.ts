import {
  type EmbedRequest,
  type ExtensionEmbedRequest,
  type ExtensionEmbedResult,
  type ExtensionModelTarget,
  type ExtensionPermissions,
  type Logger,
  type ModelEmbeddingInfo,
  ModelError,
  validateEmbedResult,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { ApiError } from "../errors.js";
import { isExtensionEnabled } from "../extensions/enabled.js";
import { afterCommit } from "../infra/database/after-commit.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { KernelEvents } from "../infra/events/kernel-events.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import { ProviderRegistry } from "../runtime/providers.js";
import { ModelPurposesService, type PurposeTarget } from "./purposes.js";

/** An extension's `permissions.models` (what it declared, as approved in its manifest). */
export type DeclaredModelPurposes = NonNullable<ExtensionPermissions["models"]>;

/** Most texts one `ctx.models.embed` call may carry (the kernel splits them by `maxBatch`). */
export const EMBED_MAX_INPUTS = 2048;

/**
 * The `ctx.models` broker for embeddings (model platform spec B §5.4). Every call:
 * - accepts only a purpose the calling extension declared in `permissions.models` with
 *   `kind: "embedding"` (`model.purpose_unknown` otherwise: the manifest is what was approved), for
 *   an org that enabled the extension (`extension.not_enabled`);
 * - resolves the org's effective target ({@link ModelPurposesService.resolve}: unmapped, or mapped
 *   to a model the org cannot use, is `model.unconfigured`) and the model in the org's view, enabled
 *   and of kind `embedding` ({@link ProviderRegistry.resolve}, bound to the org's effective config);
 * - splits the input into batches of the model's `maxBatch`, calls the provider's `embed` once per
 *   batch in order with the extension's signal, checks each result ({@link validateEmbedResult}: a
 *   wrong count, dimension or a non-finite number is a `ModelError` of kind `server`), and
 *   concatenates the vectors; no retries (an extension retries itself if it wants to);
 * - writes one `model_usage` row (the sum of the batches' input tokens) and announces it after the
 *   commit (`model_usage.recorded`: the usage reporter's `ModelUsageJobs` enqueues its
 *   `usage.report` delivery; the usage sweep catches up a lost one). A call that fails after the
 *   provider answered some batches (an invalid result, a later batch failing) still records their
 *   input tokens before the error reaches the extension; one that fails before any answer records
 *   nothing.
 * Purpose params are not sent: an `embed` request carries none (`EmbedRequest`).
 */
@Injectable()
export class ModelEmbeddings {
  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(ModelPurposesService)
    private readonly purposes: Pick<ModelPurposesService, "resolve">,
    @Inject(ProviderRegistry) private readonly providers: Pick<ProviderRegistry, "resolve">,
    /** `model_usage.recorded`: the usage reporter enqueues the row's delivery. */
    @Inject(KernelEvents) private readonly events: Pick<KernelEvents, "emit">,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<Logger, "warn">,
  ) {}

  /** Refuses a purpose `plugin` did not declare with kind `embedding`, or an org it is off in. */
  private async admit(
    plugin: string,
    declared: DeclaredModelPurposes,
    orgId: string,
    purpose: string,
  ): Promise<void> {
    if (!declared.some((d) => d.purpose === purpose && d.kind === "embedding")) {
      throw new ApiError(
        "model.purpose_unknown",
        `Extension ${plugin} declared no embedding purpose "${purpose}" in permissions.models`,
      );
    }
    if (!(await isExtensionEnabled(this.kdb.db, orgId, plugin))) {
      throw new ApiError(
        "extension.not_enabled",
        `Extension ${plugin} is not enabled in organization ${orgId}`,
      );
    }
  }

  /** The org's target for the purpose and the model bound to the org's config. */
  private async target(orgId: string, purpose: string) {
    const target: PurposeTarget = await this.purposes.resolve(orgId, purpose);
    const { provider, info } = await this.providers.resolve(orgId, target.model, {
      kind: "embedding",
    });
    if (info.embedding === undefined || provider.embed === undefined) {
      // the registry drops such models from the list; kept as a guard
      throw new ApiError(
        "model.unconfigured",
        `The model configured for the "${purpose}" purpose cannot embed`,
      );
    }
    return {
      ref: target.model,
      info: info.embedding,
      embed: provider.embed.bind(provider) as NonNullable<typeof provider.embed>,
    };
  }

  /** `ctx.models.embed` for `plugin` (its declared purposes), aborted by `signal`. */
  async embed(
    plugin: string,
    declared: DeclaredModelPurposes,
    req: ExtensionEmbedRequest,
    signal: AbortSignal,
  ): Promise<ExtensionEmbedResult> {
    checkRequest(req);
    await this.admit(plugin, declared, req.orgId, req.purpose);
    const t = await this.target(req.orgId, req.purpose);
    const dimensions = req.dimensions ?? t.info.defaultDimensions;
    if (!t.info.dimensions.includes(dimensions)) {
      throw new ApiError(
        "validation_failed",
        `Model ${t.ref.provider}/${t.ref.model} cannot produce ${dimensions} dimensions (it offers ${t.info.dimensions.join(", ")})`,
      );
    }
    const model = { provider: t.ref.provider, id: t.ref.model };
    if (req.input.length === 0) return { vectors: [], model, dimensions };
    const vectors: number[][] = [];
    /** Input tokens of the batches the provider answered (billed even if the call fails later). */
    let inputTokens = 0;
    let answered = 0;
    const size = Math.max(1, t.info.maxBatch);
    try {
      for (let i = 0; i < req.input.length; i += size) {
        signal.throwIfAborted();
        const batch: EmbedRequest = {
          model: t.ref.model,
          input: req.input.slice(i, i + size),
          ...(req.dimensions !== undefined && { dimensions: req.dimensions }),
          ...(req.inputType !== undefined && { inputType: req.inputType }),
        };
        const res = await t.embed(batch, { signal });
        answered++;
        inputTokens += tokensOf(res);
        const problem = checkResult(batch, t.info, res);
        if (problem !== null) {
          throw new ModelError(
            "server",
            `Model ${model.provider}/${model.id} returned an invalid embedding: ${problem}`,
          );
        }
        for (const v of res.vectors) vectors.push(v);
      }
    } catch (err) {
      // the batches already answered were billed by the provider: recorded, then the error
      if (answered > 0) {
        await this.record(plugin, req.orgId, req.purpose, model, inputTokens).catch((e) =>
          this.log.warn("cannot record the usage of a failed embed call", {
            plugin,
            orgId: req.orgId,
            err: e,
          }),
        );
      }
      throw err;
    }
    await this.record(plugin, req.orgId, req.purpose, model, inputTokens);
    return { vectors, model, dimensions };
  }

  /** `ctx.models.describe` for `plugin`: null when the purpose maps to no model the org can use. */
  async describe(
    plugin: string,
    declared: DeclaredModelPurposes,
    req: { orgId: string; purpose: string },
  ): Promise<ExtensionModelTarget | null> {
    if (typeof req?.orgId !== "string" || typeof req.purpose !== "string") {
      throw new ApiError("validation_failed", "describe needs orgId and purpose strings");
    }
    await this.admit(plugin, declared, req.orgId, req.purpose);
    try {
      const t = await this.target(req.orgId, req.purpose);
      return {
        provider: t.ref.provider,
        id: t.ref.model,
        kind: "embedding",
        embedding: structuredClone(t.info),
      };
    } catch (e) {
      if (e instanceof ApiError && e.code === "model.unconfigured") return null;
      throw e;
    }
  }

  /** One `model_usage` row; its `usage.report` delivery is enqueued after the commit. */
  @Transactional()
  private async record(
    plugin: string,
    orgId: string,
    purpose: string,
    model: { provider: string; id: string },
    inputTokens: number,
  ): Promise<void> {
    const row = await this.kdb.db
      .insertInto("model_usage")
      .values({
        org_id: orgId,
        extension: plugin,
        purpose,
        provider: model.provider,
        model: model.id,
        input_tokens: Math.round(inputTokens),
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    afterCommit(() => this.events.emit("model_usage.recorded", { id: row.id }));
  }
}

/** A result's input tokens when it reports a usable number, else 0 (an invalid result). */
function tokensOf(res: unknown): number {
  const n = (res as { usage?: { inputTokens?: unknown } } | null)?.usage?.inputTokens;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
}

/** The request's shape (an extension is untyped JavaScript at run time). */
function checkRequest(req: ExtensionEmbedRequest): void {
  const bad = (why: string): never => {
    throw new ApiError("validation_failed", `Invalid embed request: ${why}`);
  };
  if (typeof req !== "object" || req === null) bad("expected an object");
  if (typeof req.orgId !== "string" || req.orgId === "") bad("orgId must be a string");
  if (typeof req.purpose !== "string" || req.purpose === "") bad("purpose must be a string");
  if (!Array.isArray(req.input) || req.input.some((t) => typeof t !== "string")) {
    bad("input must be an array of strings");
  }
  if (req.input.length > EMBED_MAX_INPUTS) bad(`at most ${EMBED_MAX_INPUTS} inputs per call`);
  if (req.dimensions !== undefined && !Number.isInteger(req.dimensions)) {
    bad("dimensions must be an integer");
  }
  if (req.inputType !== undefined && req.inputType !== "query" && req.inputType !== "document") {
    bad('inputType must be "query" or "document"');
  }
}

/** {@link validateEmbedResult}, plus the result's own shape (a provider is untyped at run time). */
function checkResult(req: EmbedRequest, info: ModelEmbeddingInfo, res: unknown): string | null {
  const r = res as { vectors?: unknown; usage?: { inputTokens?: unknown } } | null;
  if (typeof r !== "object" || r === null || !Array.isArray(r.vectors)) return "no vectors";
  if (!r.vectors.every((v) => Array.isArray(v))) return "a vector is not an array";
  const tokens = r.usage?.inputTokens;
  if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 0) {
    return "usage.inputTokens is not a non-negative number";
  }
  return validateEmbedResult(req, info, r as Parameters<typeof validateEmbedResult>[2]);
}
