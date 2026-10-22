import {
  assertValidDeclarations,
  type CapabilityRef,
  EFFORT_VALUES,
  type Effort,
  type Logger,
  type ModelInfo,
  type ModelInfoV1,
  type ModelParameter,
  type ModelProvider,
  type ModelProviderV1,
  type ModelRequestV1,
  parseCapability,
} from "@capybara-hq/plugin-sdk";
import type { Redis } from "ioredis";
import type { ModelRef } from "../agents/definition.js";
import { ApiError } from "../errors.js";

/** 供应商模型列表在 Redis 中的缓存时长（秒）。 */
const MODELS_TTL_SECONDS = 600;
/**
 * 键带供应商的契约主版本：插件从 `@1` 升级到 `@2` 后不会读到 `@1`（经适配）时写入的列表
 * （两者都是 `@2` 形状，按形状分辨不出来）。
 * 键还带插件版本与部署配置摘要：插件升级（参数声明可能变了）或改部署配置（如增删模型）后，
 * 各副本立即按新声明校验，不必等旧缓存 TTL 到期。摘要只是哈希，不含配置明文（secret 不进键）。
 * 旧键按 TTL 自然过期。没有版本 / 摘要的条目（测试替身）用 `-` 占位。
 */
const modelsKey = (p: ProviderEntry) =>
  `capk:models:${p.plugin}:v${p.major}:${p.version ?? "-"}:${p.configHash ?? "-"}`;

interface ProviderEntry {
  plugin: string;
  major: 1 | 2;
  impl: ModelProvider;
  version?: string | undefined;
  configHash?: string | undefined;
}

/** 注册表需要的宿主视图：`PluginHost.list` 的子集（版本与摘要可缺省，便于测试替身）。 */
export interface ProviderHost {
  list(capabilityName: string): {
    plugin: string;
    capability: CapabilityRef;
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

/** 缓存里的条目必须是 `@2` 形状（旧版本内核写入的 `@1` 原始结果没有 `parameters`，视为未命中）。 */
const isCurrentShape = (models: unknown): models is ModelInfo[] =>
  Array.isArray(models) &&
  models.every(
    (m) => typeof m === "object" && m !== null && Array.isArray((m as ModelInfo).parameters),
  );

/**
 * 模型供应商注册表：供应商即提供 `model-provider` 能力的插件（以插件名为供应商名）。
 * 同时支持 `model-provider@1`（经 {@link adaptModelProviderV1} 适配）与 `@2`；
 * 同一插件两者都提供时用 `@2`。`@2` 的 `listModels()` 结果先过 `assertValidDeclarations`，
 * 不合规的供应商不可用（不可重试）。
 * 每个供应商的模型列表（`@2` 形状）缓存在 Redis `capk:models:<provider>:v<主版本>:<插件版本>:<部署配置摘要>`（EX 600），不放进程内存，
 * 多副本共享同一份缓存。
 */
export class ProviderRegistry {
  constructor(
    private readonly host: ProviderHost,
    private readonly kv: Redis,
    private readonly log?: Pick<Logger, "warn">,
  ) {}

  /** 每个插件取一个实现（`@2` 优先），按插件首次出现的顺序；不支持的主版本记 warn 后忽略。 */
  private providers(): ProviderEntry[] {
    const chosen = new Map<
      string,
      { major: 1 | 2; impl: unknown; version: string | undefined; configHash: string | undefined }
    >();
    for (const p of this.host.list(CAPABILITY)) {
      const { major } = parseCapability(p.capability);
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

  private async models(p: ProviderEntry): Promise<ModelInfo[]> {
    const { plugin: provider, major, impl } = p;
    const key = modelsKey(p);
    const cached = await this.kv.get(key);
    if (cached !== null) {
      const parsed: unknown = JSON.parse(cached);
      if (isCurrentShape(parsed)) return parsed;
    }
    let models: ModelInfo[];
    try {
      models = await impl.listModels();
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
    await this.kv.set(key, JSON.stringify(models), "EX", MODELS_TTL_SECONDS);
    return models;
  }

  /** 每个已安装供应商及其模型（按插件加载顺序）；列模型失败或声明不合规的供应商跳过并记 warn。 */
  async list(): Promise<{ provider: string; models: ModelInfo[] }[]> {
    return (await this.listWithStatus()).flatMap((p) =>
      p.status === "ok" ? [{ provider: p.provider, models: p.models }] : [],
    );
  }

  /**
   * 每个已安装供应商及其状态（按插件加载顺序，后台用）：列模型失败或声明不合规的标 `error`、`models` 为空，
   * 不影响其他供应商。`error` 只是内核自己的英文说明（不透出上游错误原文，原文记 warn 日志）。
   */
  async listWithStatus(): Promise<ProviderStatus[]> {
    const providers = this.providers();
    const settled = await Promise.allSettled(providers.map((p) => this.models(p)));
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
