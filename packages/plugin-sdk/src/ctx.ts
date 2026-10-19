import type { Kysely } from "kysely";
import type { CapabilityRef } from "./capability.js";
import type { ToolHandler, ToolSpec } from "./tool.js";

/** 日志接口。 */
export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

/** 分布式锁租约。 */
export interface Lease {
  renew(): Promise<boolean>;
  release(): Promise<void>;
}

/** 传给插件 `setup` 的上下文。不提供定时器与进程内共享状态；kv 写入必须带 TTL。 */
export interface PluginContext {
  kv: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string, opts: { ttlSeconds: number }): Promise<void>;
    del(key: string): Promise<void>;
    incr(key: string, opts: { ttlSeconds: number }): Promise<number>;
  };
  lock: {
    acquire(key: string, opts: { ttlMs: number }): Promise<Lease | null>;
  };
  bus: {
    publish(topic: string, payload: unknown): Promise<void>;
    subscribe(topic: string, handler: (payload: unknown) => void): Promise<() => Promise<void>>;
  };
  queue: {
    define<T>(
      name: string,
      handler: (data: T) => Promise<void>,
      opts?: { concurrency?: number },
    ): void;
    add<T>(name: string, data: T, opts?: { delayMs?: number; jobId?: string }): Promise<void>;
  };
  secrets: {
    get(orgId: string, key: string): Promise<string | null>;
    set(orgId: string, key: string, value: string): Promise<void>;
  };
  /** 已切到本插件 schema（withSchema）的 Kysely 实例。 */
  // biome-ignore lint/suspicious/noExplicitAny: 插件自带表结构，内核无法静态得知
  db: Kysely<any>;
  http: {
    /** 实际挂载到 `/plugins/<name><path>`。 */
    route(
      method: "GET" | "POST" | "PUT" | "DELETE",
      path: string,
      handler: (req: Request) => Promise<Response>,
    ): void;
  };
  tools: {
    /** 注册一个工具；只能在 `setup` 期间调用，名称不可重复。 */
    register(spec: ToolSpec, handler: ToolHandler): void;
  };
  /**
   * 取用其他插件提供的能力：只能取清单 `requires` / `optional` 中声明的、非 brokered 的能力。
   * 不传 orgId 是部署级视角，同步返回；传 orgId 时返回 Promise——orgScoped 能力（如 `channel`、`directory`）
   * 按该组织的启用状态过滤（每次查询、不缓存），`get` 的提供方在该组织未启用时 reject `CapabilityUnavailableError`。
   * 提供方不存在时 `get` 抛 `CapabilityUnavailableError`，`list` 返回空列表。
   */
  capabilities: {
    /** 单选能力可不传 provider；多选能力必须传。 */
    get<T>(ref: CapabilityRef, provider?: string): T;
    get<T>(ref: CapabilityRef, provider: string | undefined, opts: { orgId: string }): Promise<T>;
    list<T>(ref: CapabilityRef): { plugin: string; impl: T }[];
    list<T>(ref: CapabilityRef, opts: { orgId: string }): Promise<{ plugin: string; impl: T }[]>;
  };
  provide(capability: CapabilityRef, impl: unknown): void;
  /** 部署级配置，已按插件 schema 校验。 */
  config: unknown;
  log: Logger;
}
