import { createHash } from "node:crypto";
import {
  assertValidDeclarations,
  type EmbedRequest,
  type EmbedResult,
  type ExtensionManifest,
  type ExtensionPointRef,
  type Logger,
  type ModelCallOptions,
  type ModelEmbeddingInfo,
  type ModelInfo,
  type ModelKind,
  type ModelProvider,
  type ModelRequest,
  type ModelStreamEvent,
  parseExtensionPoint,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable, Module, Optional } from "@nestjs/common";
import type { Redis } from "ioredis";
import type { z } from "zod";
import type { ModelRef } from "../agents/definition.js";
import { ApiError } from "../errors.js";
import { deploymentConfigHash } from "../extensions/config-hash.js";
import { EffectiveConfigs } from "../extensions/effective-config.js";
import { missingOverridable } from "../extensions/org-levels.js";
import { ExtensionRegistry } from "../extensions/registry.js";
import { ExtensionStateModule } from "../extensions/state.module.js";
import { CacheService } from "../infra/cache/cache.service.js";
import { Cacheable } from "../infra/cache/cacheable.decorator.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KERNEL_LOGGER, REDIS } from "../infra/tokens.js";
import { ModelEnablement, ModelEnablementModule, modelKey } from "../models/enablement.js";

/** 供应商模型列表在 Redis 中的缓存时长（秒）。 */
const MODELS_TTL_SECONDS = 600;
/**
 * Optional provider: the `listModels()` time limit (ms) instead of the config's
 * `models.listTimeoutMs` (tests).
 */
export const LIST_MODELS_TIMEOUT = Symbol("LIST_MODELS_TIMEOUT");
/**
 * 列表视图（后台模型页、组织模型页）里列模型失败的供应商在这么多秒内直接标 error、不再请求（Redis，多副本共享）。
 * 只用于列表；`resolve`（运行时）照常每次请求，失败由降级梯子重试。
 */
export const LIST_FAILURE_TTL_SECONDS = 15;
/**
 * How long the "model dropped from the list" warn is not repeated for the same (provider, model,
 * config digest): the list is re-read every {@link MODELS_TTL_SECONDS}, the warn is not.
 */
const DROPPED_WARN_TTL_SECONDS = 24 * 3600;

/**
 * The shape of a cached model list. 2: every entry carries its normalised `kind` (model platform
 * providers); a format-1 entry has none, and a kernel reading it found no chat model at all.
 */
const MODELS_CACHE_FORMAT = 2;

/**
 * The model list's cache key (`@Cacheable` stores it as `cache:<key>`). It carries the
 * plugin version and the digest of the effective config the list was read with (see
 * {@link ProviderRegistry}): after an upgrade (the parameter declarations may have changed) or a
 * config change (models added or removed) every replica validates the new list at once instead of
 * waiting for the old entry's TTL. The digest is only a hash, never config text (no secret in the
 * key). Old keys expire by TTL. Entries without a version / digest (test doubles) use `-`.
 * `f<n>` is the shape of the cached entry ({@link MODELS_CACHE_FORMAT}): a kernel that changes what
 * it caches bumps it, so during a rolling upgrade it never reads a list an older kernel wrote.
 */
const modelsKey = (p: ProviderEntry, hash: string | undefined) =>
  `capk:models:${p.plugin}:f${MODELS_CACHE_FORMAT}:${p.version ?? "-"}:${hash ?? "-"}`;
/** 列表视图的失败标记（{@link LIST_FAILURE_TTL_SECONDS}），与模型列表同样按版本与配置摘要区分。 */
const listFailedKey = (p: ProviderEntry, hash: string | undefined) =>
  `capk:models-failed:${p.plugin}:${p.version ?? "-"}:${hash ?? "-"}`;
const droppedKey = (plugin: string, hash: string | undefined, model: string) =>
  `capk:models-dropped:${plugin}:${hash ?? "-"}:${model}`;

/**
 * The digest of an org's own copy of the config. `deploymentConfigHash` masks secrets, and a copy
 * usually differs from the platform only by its key, so the org id goes into the digest: a copy
 * never shares the platform's list (or another org's), whose key may see other models.
 */
const copyHash = (orgId: string, schema: z.ZodTypeAny | undefined, config: unknown) =>
  createHash("sha256")
    .update(`${orgId}\0${deploymentConfigHash(schema, config)}`)
    .digest("hex")
    .slice(0, 16);

interface ProviderEntry {
  plugin: string;
  impl: ModelProvider;
  version?: string | undefined;
  /** The platform config's digest (`deploymentConfigHash`), shared by every following org. */
  configHash?: string | undefined;
}

/**
 * The host view the registry needs: a subset of `ExtensionRegistry` (version, digest and
 * `current` optional, for test doubles).
 */
export interface ProviderHost {
  list(extensionPointName: string): {
    plugin: string;
    capability: ExtensionPointRef;
    impl: unknown;
    version?: string;
    configHash?: string;
  }[];
  /** The running instance: its manifest (deployment schema) and platform config. */
  current?(plugin: string): { manifest: ExtensionManifest; config: unknown } | undefined;
}

const CAPABILITY = "model-provider";

/** The model kinds this kernel knows; another kind (a newer plugin) is listed as `other`. */
const KNOWN_KINDS: ReadonlySet<string> = new Set<ModelKind>([
  "chat",
  "embedding",
  "rerank",
  "image_generation",
  "video_generation",
  "speech_to_text",
  "text_to_speech",
]);

/** A listed model with its kind normalised: absent means `chat`, an unknown kind is `other`. */
export type KernelModelInfo = Omit<ModelInfo, "kind"> & { kind: ModelKind | "other" };

/**
 * A model of a view that shows disabled models too: the platform view of `listWithStatus` (`disabled`
 * = on the platform's list) and an org's `catalog` (`disabled` = on the org's list). Absent in the
 * enabled-only views.
 */
export type ListedModelInfo = KernelModelInfo & { disabled?: boolean };

/** A model `resolve` returns: only `chat` and `embedding` models are callable. */
export type ResolvedModelInfo = Omit<ModelInfo, "kind"> & { kind: "chat" | "embedding" };

/**
 * The kind a `resolve` caller needs (default `chat`: every streaming caller); `callable` accepts
 * either callable kind (a purpose target checked against the purpose's own kind).
 */
export type ExpectedKind = "chat" | "embedding" | "callable";

/**
 * A provider bound to one org's call options (`orgId` and the effective config, spec B §5.5): the
 * kernel's callers pass only the signal. Built per `resolve`, never cached; the config stays in
 * the closure (never on the object, so logging or serialising it shows no secret).
 */
export interface BoundProvider {
  stream(req: ModelRequest, opts: { signal: AbortSignal }): AsyncIterable<ModelStreamEvent>;
  /** Present when the provider implements `embed`. */
  embed?(req: EmbedRequest, opts: { signal: AbortSignal }): Promise<EmbedResult>;
}

function bindProvider(impl: ModelProvider, call: ModelCallOptions): BoundProvider {
  const bound: BoundProvider = {
    stream: (req, opts) => impl.stream(req, { signal: opts.signal, ...call }),
  };
  if (typeof impl.embed === "function") {
    bound.embed = (req, opts) =>
      (impl.embed as NonNullable<ModelProvider["embed"]>)(req, { signal: opts.signal, ...call });
  }
  return bound;
}

/**
 * 一个供应商在后台的视图：供应商名即插件名；`status: "error"` 时 `models` 为空、`error` 为内核的说明。
 * `org_configured` (the platform view only): the platform config leaves a required overridable
 * field empty, so each org configures the provider itself; no list.
 */
export interface ProviderStatus {
  provider: string;
  plugin: string;
  status: "ok" | "error" | "org_configured";
  error?: string;
  models: ListedModelInfo[];
}

const positiveInt = (n: unknown): boolean => typeof n === "number" && Number.isInteger(n) && n > 0;

/**
 * Whether an embedding model's info is usable: at least one dimension, every dimension and the
 * limits positive integers, and `defaultDimensions` one of `dimensions`. A model failing this is
 * dropped from the list (every default call on it would fail validation).
 */
function isValidEmbeddingInfo(e: ModelEmbeddingInfo): boolean {
  return (
    Array.isArray(e.dimensions) &&
    e.dimensions.length > 0 &&
    e.dimensions.every(positiveInt) &&
    positiveInt(e.defaultDimensions) &&
    e.dimensions.includes(e.defaultDimensions) &&
    positiveInt(e.maxInputTokens) &&
    positiveInt(e.maxBatch)
  );
}

/**
 * 供应商的 `listModels()` 失败（上游不可用等）。仍是 `agent.model_unavailable`，HTTP 调用方照常
 * 得到该错误码；运行时（`runModelStep`）据此类型把它当作可重试的失败交给降级梯子，
 * 与「供应商未安装 / 模型不存在 / 参数声明不合规」（不可重试）区分开。
 */
export class ProviderListError extends ApiError {
  constructor(
    readonly provider: string,
    cause: unknown,
  ) {
    super("agent.model_unavailable", `Model provider ${provider} failed to list its models`);
    this.name = "ProviderListError";
    this.cause = cause;
  }
}

/** Where a provider's calls for one org (or the platform) go: the call options and list digest. */
type Target =
  | { ok: true; call: ModelCallOptions; hash: string | undefined }
  | { ok: false; reason: "org_configured" | "needs_config" | "not_enabled" };

/**
 * The model provider registry: a provider is an extension that provides `model-provider@2` (the
 * provider's name is the plugin's name).
 *
 * Org-bound (spec B §5.5, A §6): every list and call is made for an org with the provider's
 * effective config there (`EffectiveConfigs.get`), passed as `{ orgId, config }`. A provider is on
 * in an org only when the org enabled it, like every other extension (`enabledExtensionsQuery`: the
 * org's switch on, or a required bootstrap plugin); one not enabled there, or whose effective
 * config is not valid there, offers no models there. The admin view (no org) lists with the
 * platform config.
 *
 * Each list is validated per model (spec B §5.1): kinds are normalised (absent = `chat`, unknown =
 * `other`); a chat model failing `assertValidDeclarations`, or an `embedding` model without
 * `embedding` info or from a provider without `embed`, is dropped with a warn, the rest of the
 * provider stays usable. Only `chat` and `embedding` models resolve.
 *
 * Each list (`@2`-shaped) is cached in Redis (`@Cacheable`, key
 * `cache:capk:models:<provider>:f<format>:<plugin version>:<config digest>`, 600 s), never in
 * process memory: every replica shares it. The digest is the platform config's for every org that
 * follows the platform (one shared list), and a per-org digest for an org's own copy.
 */
@Injectable()
export class ProviderRegistry {
  constructor(
    @Inject(ExtensionRegistry) private readonly host: ProviderHost,
    @Inject(EffectiveConfigs) private readonly effective: Pick<EffectiveConfigs, "get">,
    @Inject(CacheService) readonly cacheService: CacheService,
    @Inject(REDIS) private readonly kv: Redis,
    @Inject(KernelConfigService) private readonly config: Pick<KernelConfigService, "get">,
    @Inject(ModelEnablement)
    private readonly enablement: Pick<ModelEnablement, "disabled" | "enabledIn">,
    @Inject(KERNEL_LOGGER) private readonly log?: Pick<Logger, "warn">,
    /** Overrides `models.listTimeoutMs` (tests). */
    @Optional()
    @Inject(LIST_MODELS_TIMEOUT)
    private readonly listTimeoutOverride?: number,
  ) {}

  /**
   * `listModels()` with a time limit: a timeout counts as a failure; the provider's call runs on in
   * the background and its result is dropped.
   */
  private async listModelsWithTimeout(
    impl: ModelProvider,
    call: ModelCallOptions,
  ): Promise<ModelInfo[]> {
    const ms = this.listTimeoutOverride ?? this.config.get().models.listTimeoutMs;
    let timer: NodeJS.Timeout | undefined;
    const call$ = Promise.resolve().then(() => impl.listModels(call));
    call$.catch(() => {});
    try {
      return await Promise.race([
        call$,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`listModels timed out after ${ms}ms`)), ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Whether a model provider is usable in `orgId` (org readiness, web-order spec §3.8,
   * `ReadinessService`), from extension state, the org's switches and its config only: never calls
   * a vendor, so a provider whose vendor is down still counts. True when a provider loaded on this
   * replica is enabled in `orgId` with a valid effective config there.
   */
  async hasProvider(orgId: string): Promise<boolean> {
    const on = await this.enablement.enabledIn(orgId);
    for (const p of this.providers()) {
      if (on.has(p.plugin) && (await this.target(p, orgId, on)).ok) return true;
    }
    return false;
  }

  /** One implementation per plugin, in the order plugins first appear; another major is ignored. */
  private providers(): ProviderEntry[] {
    const chosen = new Map<string, ProviderEntry>();
    for (const p of this.host.list(CAPABILITY)) {
      if (parseExtensionPoint(p.capability).major !== 2) {
        this.log?.warn("unsupported model-provider major version; ignored", {
          provider: p.plugin,
          capability: p.capability,
        });
        continue;
      }
      if (chosen.has(p.plugin)) continue;
      chosen.set(p.plugin, {
        plugin: p.plugin,
        impl: p.impl as ModelProvider,
        version: p.version,
        configHash: p.configHash,
      });
    }
    return [...chosen.values()];
  }

  /**
   * The call options and list digest of `p` for `orgId`, or for the platform when `orgId` is
   * undefined (the admin view). An org: its effective config (not valid -> `needs_config`); the
   * platform's digest while it follows the platform, a per-org one for its copy. The platform: its
   * own config (a required overridable field left empty -> `org_configured`). `on`: the
   * extensions enabled in the org (`ModelEnablement.enabledIn`); a provider not in it ->
   * `not_enabled`. Unused for the platform.
   */
  private async target(
    p: ProviderEntry,
    orgId: string | undefined,
    on: ReadonlySet<string> = new Set(),
  ): Promise<Target> {
    const inst = this.host.current?.(p.plugin);
    const schema = inst?.manifest.config?.deployment as z.ZodTypeAny | undefined;
    if (orgId === undefined) {
      if (schema && missingOverridable(schema, inst?.config).length > 0) {
        return { ok: false, reason: "org_configured" };
      }
      return { ok: true, call: { config: inst?.config }, hash: p.configHash };
    }
    if (!on.has(p.plugin)) return { ok: false, reason: "not_enabled" };
    const eff = await this.effective.get(orgId, p.plugin);
    if (!eff.ok) return { ok: false, reason: "needs_config" };
    return {
      ok: true,
      call: { orgId, config: eff.config },
      hash: eff.source === "platform" ? p.configHash : copyHash(orgId, schema, eff.config),
    };
  }

  private models(p: ProviderEntry, t: Target & { ok: true }): Promise<KernelModelInfo[]> {
    return this.validatedModels(modelsKey(p, t.hash), p, t.call, t.hash);
  }

  /** The provider's validated model list, cached under `key` (see {@link modelsKey}). */
  @Cacheable({ key: "#{0}", ttl: MODELS_TTL_SECONDS })
  private async validatedModels(
    _key: string,
    p: ProviderEntry,
    call: ModelCallOptions,
    hash: string | undefined,
  ): Promise<KernelModelInfo[]> {
    const { plugin: provider, impl } = p;
    let models: ModelInfo[];
    try {
      models = await this.listModelsWithTimeout(impl, call);
    } catch (err) {
      throw new ProviderListError(provider, err);
    }
    const out: KernelModelInfo[] = [];
    for (const m of models) {
      const kind: ModelKind | "other" =
        m.kind === undefined ? "chat" : KNOWN_KINDS.has(m.kind) ? m.kind : "other";
      let problem: string | undefined;
      let cause: unknown;
      if (kind === "chat") {
        try {
          assertValidDeclarations(provider, m.parameters);
        } catch (err) {
          problem = "invalid parameter declarations";
          cause = err;
        }
      } else if (kind === "embedding") {
        if (!m.embedding) problem = "an embedding model without embedding info";
        else if (!isValidEmbeddingInfo(m.embedding)) problem = "malformed embedding info";
        else if (typeof impl.embed !== "function") {
          problem = "an embedding model from a provider without embed";
        }
      }
      if (problem !== undefined) {
        await this.warnDropped(provider, m.id, hash, problem, cause);
        continue;
      }
      out.push({ ...m, kind });
    }
    return out;
  }

  /** One warn per (provider, model, config digest) within {@link DROPPED_WARN_TTL_SECONDS}. */
  private async warnDropped(
    provider: string,
    model: string,
    hash: string | undefined,
    problem: string,
    cause: unknown,
  ): Promise<void> {
    const key = droppedKey(provider, hash, model);
    if ((await this.kv.get(key)) !== null) return;
    await this.kv.set(key, "1", "EX", DROPPED_WARN_TTL_SECONDS);
    this.log?.warn("model dropped from the provider's list", {
      provider,
      model,
      problem,
      ...(cause !== undefined && { err: cause }),
    });
  }

  /**
   * 每个供应商及其模型（按插件加载顺序），for `orgId`：列模型失败或在该组织需要配置的供应商跳过。Only
   * enabled models (neither the platform nor the org disabled them, spec B §5.3), optionally of
   * one `kind`.
   */
  async list(
    orgId: string,
    opts: { kind?: ModelKind | "other" } = {},
  ): Promise<{ provider: string; models: KernelModelInfo[] }[]> {
    return (await this.listWithStatus(orgId)).flatMap((p) =>
      p.status === "ok"
        ? [
            {
              provider: p.provider,
              models:
                opts.kind === undefined ? p.models : p.models.filter((m) => m.kind === opts.kind),
            },
          ]
        : [],
    );
  }

  /**
   * An org's catalog (the org settings page, spec B §5.3): every provider as in
   * {@link listWithStatus} for the org, with every model the platform left on, each carrying
   * `disabled` for the org's own list. Reads the same cached lists (no extra provider call).
   */
  async catalog(orgId: string): Promise<ProviderStatus[]> {
    const [statuses, platform, org] = await Promise.all([
      this.statuses(orgId),
      this.enablement.disabled(null),
      this.enablement.disabled(orgId),
    ]);
    return statuses.map((p) => ({
      ...p,
      models: p.models
        .filter((m) => !platform.has(modelKey(p.provider, m.id)))
        .map((m) => ({ ...m, disabled: org.has(modelKey(p.provider, m.id)) })),
    }));
  }

  /**
   * Every installed provider with its status (in plugin load order), for `orgId` (the providers it enabled, their enabled
   * models only), or the platform view when undefined (`/admin/models`: every model, `disabled`
   * from the platform's list only).
   * See {@link statuses} for the statuses.
   */
  async listWithStatus(orgId?: string): Promise<ProviderStatus[]> {
    const [statuses, platform, org] = await Promise.all([
      this.statuses(orgId),
      this.enablement.disabled(null),
      orgId === undefined ? Promise.resolve(new Set<string>()) : this.enablement.disabled(orgId),
    ]);
    return statuses.map((p) => ({
      ...p,
      models:
        orgId === undefined
          ? p.models.map((m) => ({ ...m, disabled: platform.has(modelKey(p.provider, m.id)) }))
          : p.models.filter((m) => {
              const key = modelKey(p.provider, m.id);
              return !platform.has(key) && !org.has(key);
            }),
    }));
  }

  /**
   * Every installed provider's full list and status, for `orgId` or the platform: a provider whose
   * model listing fails (including passing `models.listTimeoutMs`) gets `error` with empty
   * `models` without affecting the others, and is not asked again for
   * {@link LIST_FAILURE_TTL_SECONDS} seconds. For an org only the providers it enabled are
   * listed (one it did not enable is absent); one that needs configuration there gets `error`. The
   * platform view of a provider whose platform config leaves a required overridable field empty
   * gets `org_configured`. `error` is only the kernel's own English message (the upstream error
   * text is never exposed; it goes to a warn log). No disabled list applied.
   */
  private async statuses(orgId: string | undefined): Promise<ProviderStatus[]> {
    const on = orgId === undefined ? new Set<string>() : await this.enablement.enabledIn(orgId);
    const providers = this.providers().filter((p) => orgId === undefined || on.has(p.plugin));
    const settled = await Promise.allSettled(
      providers.map(async (p): Promise<KernelModelInfo[] | "org_configured" | "needs_config"> => {
        const t = await this.target(p, orgId, on);
        if (!t.ok) {
          // an org's providers are filtered to the enabled ones above
          if (t.reason === "not_enabled") throw new Error(`${p.plugin} is not enabled here`);
          return t.reason;
        }
        const failed = listFailedKey(p, t.hash);
        // a provider that failed just now: mark it error for a while without waiting on it (each
        // provider has its own time limit too)
        if ((await this.kv.get(failed)) !== null) {
          throw new ProviderListError(p.plugin, new Error("listModels failed recently"));
        }
        try {
          return await this.models(p, t);
        } catch (err) {
          if (err instanceof ProviderListError) {
            await this.kv.set(failed, "1", "EX", LIST_FAILURE_TTL_SECONDS);
          }
          throw err;
        }
      }),
    );
    return settled.map((r, i): ProviderStatus => {
      const provider = (providers[i] as { plugin: string }).plugin;
      if (r.status === "fulfilled") {
        if (r.value === "org_configured") {
          return { provider, plugin: provider, status: "org_configured", models: [] };
        }
        if (r.value === "needs_config") {
          const error = `Model provider ${provider} needs configuration in this organization`;
          return { provider, plugin: provider, status: "error", error, models: [] };
        }
        return { provider, plugin: provider, status: "ok", models: r.value };
      }
      this.log?.warn("model provider listModels failed; skipped", { provider, err: r.reason });
      const error =
        r.reason instanceof ApiError
          ? r.reason.message
          : `Model provider ${provider} failed to list its models`;
      return { provider, plugin: provider, status: "error", error, models: [] };
    });
  }

  /**
   * 解析模型引用 for `orgId`，返回绑定到该组织调用选项的供应商与模型信息。
   * 供应商未安装、在该组织需要配置、模型不存在（或被丢弃）、不是 `opts.kind`（default `chat`: a
   * streaming caller never gets an embedding model）或被平台 / 该组织停用 → `agent.model_unavailable`；
   * 供应商 `listModels()` 失败 → `ProviderListError`（同一错误码，运行时视为可重试）。
   */
  async resolve(
    orgId: string,
    ref: ModelRef,
    opts: { kind?: ExpectedKind } = {},
  ): Promise<{ provider: BoundProvider; info: ResolvedModelInfo }> {
    const { p, t, info } = await this.lookup(orgId, ref, opts.kind ?? "chat");
    return { provider: bindProvider(p.impl, t.call), info };
  }

  /**
   * The model's info in the platform view (deployment-level settings such as a purpose's
   * deployment default; no call is ever made there), by {@link resolve}'s rules. A provider each
   * org configures itself has no platform list: `agent.model_unavailable`. Only the platform's
   * disabled list applies.
   */
  async platformInfo(
    ref: ModelRef,
    opts: { kind?: ExpectedKind } = {},
  ): Promise<ResolvedModelInfo> {
    return (await this.lookup(undefined, ref, opts.kind ?? "chat")).info;
  }

  private async lookup(
    orgId: string | undefined,
    ref: ModelRef,
    kind: ExpectedKind,
  ): Promise<{ p: ProviderEntry; t: Target & { ok: true }; info: ResolvedModelInfo }> {
    const unavailable = () =>
      new ApiError(
        "agent.model_unavailable",
        `Model ${ref.provider}/${ref.model} is not available`,
      );
    const p = this.providers().find((x) => x.plugin === ref.provider);
    if (!p) throw unavailable();
    const on = orgId === undefined ? new Set<string>() : await this.enablement.enabledIn(orgId);
    const t = await this.target(p, orgId, on);
    if (!t.ok) {
      throw new ApiError(
        "agent.model_unavailable",
        t.reason === "org_configured"
          ? `Model provider ${ref.provider} is configured by each organization`
          : t.reason === "not_enabled"
            ? `Model provider ${ref.provider} is not enabled in this organization`
            : `Model provider ${ref.provider} needs configuration in this organization`,
      );
    }
    const info = (await this.models(p, t)).find((m) => m.id === ref.model);
    if (!info || (info.kind !== "chat" && info.kind !== "embedding")) throw unavailable();
    if (kind !== "callable" && info.kind !== kind) {
      throw new ApiError(
        "agent.model_unavailable",
        `Model ${ref.provider}/${ref.model} is not ${kind === "embedding" ? "an" : "a"} ${kind} model`,
      );
    }
    const key = modelKey(ref.provider, ref.model);
    const [platform, org] = await Promise.all([
      this.enablement.disabled(null),
      orgId === undefined ? Promise.resolve(new Set<string>()) : this.enablement.disabled(orgId),
    ]);
    if (platform.has(key) || org.has(key)) {
      throw new ApiError(
        "agent.model_unavailable",
        `Model ${ref.provider}/${ref.model} is disabled`,
      );
    }
    return { p, t, info: info as ResolvedModelInfo };
  }
}

/** The model provider registry (one instance; the models and agents domains read it). */
@Module({
  imports: [ExtensionStateModule, ModelEnablementModule],
  providers: [ProviderRegistry],
  exports: [ProviderRegistry],
})
export class ProvidersModule {}
