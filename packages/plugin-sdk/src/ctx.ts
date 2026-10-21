import type { Kysely } from "kysely";
import type { CapabilityRef } from "./capability.js";
import type { ObjectHead } from "./storage.js";
import type { ToolHandler, ToolSpec } from "./tool.js";
import type { EmbedClaims, UiActionArgs, UiActionResult, UiRenderArgs, UiView } from "./ui.js";

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

/**
 * 插件的对象存储（`ctx.storage`，需 `permissions.storage`）：与 `ObjectStore` 同形，但每个方法的第一个参数是
 * `orgId`，键与前缀由内核自动加上 `plugins/<插件名>/<orgId>/`——插件只能看到自己在该组织下的对象。
 * 底层是部署配置的 `object-store@1` 提供方；没有提供方时各方法抛错。
 */
export interface PluginStorage {
  put(
    orgId: string,
    key: string,
    body: Uint8Array | ReadableStream<Uint8Array>,
    opts: { contentType: string; size?: number; signal?: AbortSignal },
  ): Promise<ObjectHead>;
  get(
    orgId: string,
    key: string,
    opts?: { signal?: AbortSignal; range?: { start: number; end?: number } },
  ): Promise<{ head: ObjectHead; body: ReadableStream<Uint8Array> } | null>;
  head(orgId: string, key: string): Promise<ObjectHead | null>;
  /** 不存在也算成功。 */
  delete(orgId: string, key: string): Promise<void>;
  deletePrefix(orgId: string, prefix: string): Promise<number>;
  list(
    orgId: string,
    prefix: string,
    opts?: { cursor?: string; limit?: number },
  ): Promise<{ items: ObjectHead[]; cursor?: string }>;
  presignGet(
    orgId: string,
    key: string,
    opts: { ttlSeconds: number; downloadName?: string },
  ): Promise<string>;
  presignPut(
    orgId: string,
    key: string,
    opts: { contentType: string; maxSize: number; ttlSeconds: number },
  ): Promise<{ url: string; headers: Record<string, string> }>;
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
  /** 对象存储（需 `permissions.storage`，见 {@link PluginStorage}）。 */
  storage: PluginStorage;
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
  /**
   * 界面贡献的运行时（清单 `ui` + `permissions.ui`）：
   * - `view` / `action`：只能在 `setup` 期间注册，id 是清单里 kind view 的贡献 id；
   *   `action` 收到视图里按钮或表单提交（`args.actionId` 区分是哪一个）；
   * - `invalidate`：告诉内核「这个贡献变了」，打开着它的网页会重新取视图（经 bus，跨副本）；
   * - `verifyEmbedToken`：校验 embed 页面拿到的嵌入令牌，只认签给本插件、未过期的，且此刻插件仍在该组织启用、
   *   调用者仍是 active 成员（组织页面还要求 member 以上），否则返回 null；返回的 `role` 是此刻的角色。
   */
  ui: {
    view(id: string, render: (args: UiRenderArgs) => Promise<UiView>): void;
    action(id: string, handler: (args: UiActionArgs) => Promise<UiActionResult>): void;
    invalidate(target: {
      orgId: string;
      conversationId?: string;
      contribution: string;
    }): Promise<void>;
    verifyEmbedToken(token: string): Promise<EmbedClaims | null>;
  };
  provide(capability: CapabilityRef, impl: unknown): void;
  /** 部署级配置，已按插件 schema 校验。 */
  config: unknown;
  log: Logger;
}
