import {
  assertValidDeclarations,
  EFFORT_VALUES,
  type Effort,
  type ExtensionPointRef,
  type Logger,
  type ModelInfo,
  type ModelInfoV1,
  type ModelParameter,
  type ModelProvider,
  type ModelProviderV1,
  type ModelRequestV1,
  parseExtensionPoint,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable, Module, Optional } from "@nestjs/common";
import type { Redis } from "ioredis";
import type { ModelRef } from "../agents/definition.js";
import { ApiError } from "../errors.js";
import { ExtensionRegistry, ExtensionRegistryModule } from "../extensions/registry.js";
import { CacheService } from "../infra/cache/cache.service.js";
import { Cacheable } from "../infra/cache/cacheable.decorator.js";
import { KERNEL_LOGGER, REDIS } from "../infra/tokens.js";

/** 供应商模型列表在 Redis 中的缓存时长（秒）。 */
const MODELS_TTL_SECONDS = 600;
/** 单个供应商 `listModels()` 的时限（毫秒）：一个卡住的供应商不拖住整个列表与解析。 */
export const LIST_MODELS_TIMEOUT_MS = 10_000;
/** Optional provider: the `listModels()` time limit (ms) instead of {@link LIST_MODELS_TIMEOUT_MS} (tests). */
export const LIST_MODELS_TIMEOUT = Symbol("LIST_MODELS_TIMEOUT");
/**
 * 列表视图（后台模型页、组织模型页）里列模型失败的供应商在这么多秒内直接标 error、不再请求（Redis，多副本共享）。
 * 只用于列表；`resolve`（运行时）照常每次请求，失败由降级梯子重试。
 */
export const LIST_FAILURE_TTL_SECONDS = 15;
/**
 * The model list's cache key (`@Cacheable` stores it as `cache:<key>`). It carries the provider's
 * contract major: after a plugin moves from `@1` to `@2` it never reads the list written through
 * the `@1` adapter (both are `@2`-shaped, the shape cannot tell them apart). It also carries the
 * plugin version and the deployment config digest: after an upgrade (the parameter declarations may
 * have changed) or a deployment config change (models added or removed) every replica validates
 * the new declarations at once instead of waiting for the old entry's TTL. The digest is only a
 * hash, never config text (no secret in the key). Old keys expire by TTL. Entries without a
 * version / digest (test doubles) use `-`.
 */
const modelsKey = (p: ProviderEntry) =>
  `capk:models:${p.plugin}:v${p.major}:${p.version ?? "-"}:${p.configHash ?? "-"}`;
/** 列表视图的失败标记（{@link LIST_FAILURE_TTL_SECONDS}），与模型列表同样按版本与配置摘要区分。 */
const listFailedKey = (p: ProviderEntry) =>
  `capk:models-failed:${p.plugin}:v${p.major}:${p.version ?? "-"}:${p.configHash ?? "-"}`;

interface ProviderEntry {
  plugin: string;
  major: 1 | 2;
  impl: ModelProvider;
  version?: string | undefined;
  configHash?: string | undefined;
}

/** The host view the registry needs: a subset of `ExtensionHost.list` (version and digest optional, for test doubles). */
export interface ProviderHost {
  list(extensionPointName: string): {
    plugin: string;
    capability: ExtensionPointRef;
    impl: unknown;
    version?: string;
    configHash?: string;
  }[];
}

const CAPABILITY = "model-provider";

/** 一个供应商在后台的视图：供应商名即插件名；`status: "error"` 时 `models` 为空、`error` 为内核的说明。 */
export interface ProviderStatus {
  provider: string;
  plugin: string;
  status: "ok" | "error";
  error?: string;
  models: ModelInfo[];
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

/**
 * `@1` 适配层为 `capabilities.effort` 为真的模型补的 effort 旋钮：五档，不给默认值
 * （各家 API 的默认值不同；给了默认值会让未设置 effort 的 agent 每次都静默发送它）。
 */
const V1_EFFORT_KNOB: ModelParameter = {
  key: "effort",
  standard: "effort",
  schema: { type: "string", enum: [...EFFORT_VALUES] },
  label: { zh: "思考深度", en: "Effort" },
};

/**
 * 把 `model-provider@1` 实现包成 `@2`：
 * - `listModels`：`parameters` 由 `capabilities.effort` 推导（为真时只有 effort 旋钮，否则为空）；
 * - `stream`：`params.effort` 映射为 `req.effort`，其余参数丢弃（`@1` 没有对应字段）；
 *   没有 `params.effort` 时保留请求自带的 `effort`。
 */
export function adaptModelProviderV1(impl: ModelProviderV1): ModelProvider {
  return {
    async listModels() {
      const models = await impl.listModels();
      return models.map(
        (m: ModelInfoV1): ModelInfo => ({
          ...m,
          parameters: m.capabilities.effort ? [structuredClone(V1_EFFORT_KNOB)] : [],
        }),
      );
    },
    stream(req, opts) {
      // `@1` 没有 toolChoice：不传（旧插件按自己的默认处理）
      const { params, toolChoice: _toolChoice, ...rest } = req;
      const out: ModelRequestV1 = rest;
      const effort = params?.effort;
      if (typeof effort === "string" && (EFFORT_VALUES as readonly string[]).includes(effort)) {
        out.effort = effort as Effort;
      }
      return impl.stream(out, opts);
    },
  };
}

/**
 * 模型供应商注册表：供应商即提供 `model-provider` 能力的插件（以插件名为供应商名）。
 * 同时支持 `model-provider@1`（经 {@link adaptModelProviderV1} 适配）与 `@2`；
 * 同一插件两者都提供时用 `@2`。`@2` 的 `listModels()` 结果先过 `assertValidDeclarations`，
 * 不合规的供应商不可用（不可重试）。
 * Each provider's model list (`@2`-shaped) is cached in Redis (`@Cacheable`, key
 * `cache:capk:models:<provider>:v<major>:<plugin version>:<config digest>`, 600 s), never in
 * process memory: every replica shares it.
 */
@Injectable()
export class ProviderRegistry {
  constructor(
    @Inject(ExtensionRegistry) private readonly host: ProviderHost,
    @Inject(CacheService) readonly cacheService: CacheService,
    @Inject(REDIS) private readonly kv: Redis,
    @Inject(KERNEL_LOGGER) private readonly log?: Pick<Logger, "warn">,
    /** The `listModels()` time limit. */
    @Optional()
    @Inject(LIST_MODELS_TIMEOUT)
    private readonly listTimeoutMs: number = LIST_MODELS_TIMEOUT_MS,
  ) {}

  /** `listModels()` 加时限（到时按失败处理，供应商的调用留在后台、结果丢弃）。 */
  private async listModelsWithTimeout(impl: ModelProvider): Promise<ModelInfo[]> {
    const ms = this.listTimeoutMs;
    let timer: NodeJS.Timeout | undefined;
    const call = Promise.resolve().then(() => impl.listModels());
    call.catch(() => {});
    try {
      return await Promise.race([
        call,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`listModels timed out after ${ms}ms`)), ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** 每个插件取一个实现（`@2` 优先），按插件首次出现的顺序；不支持的主版本记 warn 后忽略。 */
  private providers(): ProviderEntry[] {
    const chosen = new Map<
      string,
      { major: 1 | 2; impl: unknown; version: string | undefined; configHash: string | undefined }
    >();
    for (const p of this.host.list(CAPABILITY)) {
      const { major } = parseExtensionPoint(p.capability);
      if (major !== 1 && major !== 2) {
        this.log?.warn("unsupported model-provider major version; ignored", {
          provider: p.plugin,
          capability: p.capability,
        });
        continue;
      }
      const prev = chosen.get(p.plugin);
      if (!prev || major > prev.major) {
        chosen.set(p.plugin, {
          major,
          impl: p.impl,
          version: p.version,
          configHash: p.configHash,
        });
      }
    }
    return [...chosen].map(([plugin, { major, impl, version, configHash }]) => ({
      plugin,
      major,
      version,
      configHash,
      impl: major === 2 ? (impl as ModelProvider) : adaptModelProviderV1(impl as ModelProviderV1),
    }));
  }

  private models(p: ProviderEntry): Promise<ModelInfo[]> {
    return this.validatedModels(modelsKey(p), p);
  }

  /** The provider's validated model list, cached under `key` (see {@link modelsKey}). */
  @Cacheable({ key: "#{0}", ttl: MODELS_TTL_SECONDS })
  private async validatedModels(_key: string, p: ProviderEntry): Promise<ModelInfo[]> {
    const { plugin: provider, major, impl } = p;
    let models: ModelInfo[];
    try {
      models = await this.listModelsWithTimeout(impl);
    } catch (err) {
      throw new ProviderListError(provider, err);
    }
    if (major === 2) {
      try {
        for (const m of models) assertValidDeclarations(provider, m.parameters);
      } catch (err) {
        const e = new ApiError(
          "agent.model_unavailable",
          `Model provider ${provider} declared invalid model parameters`,
        );
        e.cause = err;
        throw e;
      }
    }
    return models;
  }

  /** 每个已安装供应商及其模型（按插件加载顺序）；列模型失败或声明不合规的供应商跳过并记 warn。 */
  async list(): Promise<{ provider: string; models: ModelInfo[] }[]> {
    return (await this.listWithStatus()).flatMap((p) =>
      p.status === "ok" ? [{ provider: p.provider, models: p.models }] : [],
    );
  }

  /**
   * 每个已安装供应商及其状态（按插件加载顺序，后台用）：列模型失败（含超过 {@link LIST_MODELS_TIMEOUT_MS}）或声明
   * 不合规的标 `error`、`models` 为空，不影响其他供应商；列模型失败的在 {@link LIST_FAILURE_TTL_SECONDS} 秒内不再请求。`error` 只是内核自己的英文说明（不透出上游错误原文，原文记 warn 日志）。
   */
  async listWithStatus(): Promise<ProviderStatus[]> {
    const providers = this.providers();
    const settled = await Promise.allSettled(
      providers.map(async (p) => {
        // 刚失败过的供应商：短时间内直接标 error，不再等它（每个供应商另有时限）
        if ((await this.kv.get(listFailedKey(p))) !== null) {
          throw new ProviderListError(p.plugin, new Error("listModels failed recently"));
        }
        try {
          return await this.models(p);
        } catch (err) {
          if (err instanceof ProviderListError) {
            await this.kv.set(listFailedKey(p), "1", "EX", LIST_FAILURE_TTL_SECONDS);
          }
          throw err;
        }
      }),
    );
    return settled.map((r, i): ProviderStatus => {
      const provider = (providers[i] as { plugin: string }).plugin;
      if (r.status === "fulfilled") {
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
   * 解析模型引用，返回 `@2` 形状的供应商实现（`@1` 已适配）与模型信息。
   * 供应商未安装、模型不存在或参数声明不合规 → `agent.model_unavailable`；
   * 供应商 `listModels()` 失败 → `ProviderListError`（同一错误码，运行时视为可重试）。
   */
  async resolve(ref: ModelRef): Promise<{ provider: ModelProvider; info: ModelInfo }> {
    const p = this.providers().find((x) => x.plugin === ref.provider);
    const info = p && (await this.models(p)).find((m) => m.id === ref.model);
    if (!p || !info) {
      throw new ApiError(
        "agent.model_unavailable",
        `Model ${ref.provider}/${ref.model} is not available`,
      );
    }
    return { provider: p.impl, info };
  }
}

/** The model provider registry (one instance; the models and agents domains read it). */
@Module({
  imports: [ExtensionRegistryModule],
  providers: [ProviderRegistry],
  exports: [ProviderRegistry],
})
export class ProvidersModule {}
