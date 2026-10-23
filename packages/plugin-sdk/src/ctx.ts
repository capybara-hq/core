import type { Kysely } from "kysely";
import type { CapabilityRef } from "./capability.js";
import type { AvailableHook, HookHandler, HookOptions } from "./hooks.js";
import type { ObjectHead, PresignedUpload, PresignGetOptions } from "./storage.js";
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
  /**
   * 不存在返回 null。`range` 为闭区间字节范围，缺省 `end` 表示读到末尾。
   * 带 `range` 时 `head.size` 仍是整个对象的大小；存储忽略 Range 时 body 可能是整个对象。
   */
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
  presignGet(orgId: string, key: string, opts: PresignGetOptions): Promise<string>;
  presignPut(
    orgId: string,
    key: string,
    opts: { contentType: string; maxSize: number; ttlSeconds: number },
  ): Promise<PresignedUpload>;
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
  /**
   * Hooks (`permissions.hooks`): observe model and tool calls, or deny them with a policy hook.
   * `on` is only allowed during `setup`; the mount point must be declared in `permissions.hooks` and be
   * one of `HOOKS_AVAILABLE`; `mode: "policy"` only on `POLICY_HOOKS`. Hooks fire only for organizations
   * that enabled the plugin, only in chat conversations (never in eval replays), serially by plugin
   * name. Unloading, upgrading or disabling the plugin instance revokes them.
   */
  hooks: {
    on<K extends AvailableHook>(mount: K, handler: HookHandler<K>, opts: HookOptions): void;
  };
  provide(capability: CapabilityRef, impl: unknown): void;
  /**
   * 本插件实例的生命周期信号：实例被撤销（停用、卸载、升级）时、在途调用排空之后中止。
   * 插件自己起的长任务（轮询循环、长连接等）据此收尾。
   */
  signal: AbortSignal;
  /**
   * 部署级配置，已按插件 schema 校验（启动配置与企业管理员在后台保存的值合并后）。这是一个 getter：
   * 标了 `hot`（`.meta({ hot: true })`）的字段改动时内核就地替换，插件**在用时读** `ctx.config` 才能拿到新值，
   * 不要在 setup 里把 hot 字段拷进闭包；改了非 hot 字段时内核重新加载插件实例（新的 setup）。
   */
  readonly config: unknown;
  log: Logger;
}
