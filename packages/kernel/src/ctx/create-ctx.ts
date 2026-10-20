import {
  CAPABILITIES,
  type CapabilityRef,
  CapabilityUnavailableError,
  type Logger,
  type PluginContext,
  type PluginManifest,
  PluginPermissionError,
  parseCapability,
  type ToolHandler,
  type ToolSpec,
  validateToolSpec,
} from "@capybara-hq/plugin-sdk";
import type { Redis } from "ioredis";
import {
  Command,
  ConnectionBuilder,
  ControlledTransactionBuilder,
  Kysely,
  TransactionBuilder,
} from "kysely";
import { conversationTopic } from "../conversations/event-log.js";
import { kernelDb } from "../db/kernel-schema.js";
import { audit } from "../identity/audit.js";
import {
  orgUiTopic,
  PluginUiRegistration,
  type UiActionHandler,
  type UiBusMessage,
  type UiRender,
} from "../ui/registry.js";
import { type BusSubscriber, createBus } from "./bus.js";
import { createKv } from "./kv.js";
import { createLock } from "./lock.js";
import { createQueue } from "./queue.js";
import { createSecrets, type Keyring } from "./secrets.js";

/** 内核提供给插件宿主的共享依赖。 */
export interface KernelDeps {
  // biome-ignore lint/suspicious/noExplicitAny: 内核不持有表结构类型
  db: Kysely<any>;
  dbUrl: string;
  /** PG 建立连接的超时（迁移器的独立连接使用）。 */
  connectTimeoutMs?: number;
  redis: Redis;
  busSubscriber: BusSubscriber;
  redisUrl: string;
  keyring: Keyring;
  runWorkers: boolean;
  log: Logger;
}

/** 插件 HTTP 路由；`path` 已含 `/plugins/<name>` 前缀。 */
export type Route = {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  handler: (req: Request) => Promise<Response>;
};

/** 插件经 `ctx.tools.register` 注册的工具。 */
export type RegisteredTool = { spec: ToolSpec; handler: ToolHandler };

/** 插件经 `ctx.capabilities` 取用其他插件能力时，内核注入的访问接口。 */
export interface CapabilityAccess {
  /** 已加载（setup 完成）的提供方，按加载顺序；按完整引用（含主版本）精确匹配。 */
  providers(ref: CapabilityRef): { plugin: string; impl: unknown }[];
  /** 在该组织启用的插件名（`plugin_org_configs.enabled`）；每次查询，不缓存。 */
  enabledPlugins(orgId: string): Promise<Set<string>>;
}

/** 查询在该组织启用的插件名（`plugin_org_configs.enabled = true`），不缓存。 */
// biome-ignore lint/suspicious/noExplicitAny: 内核不持有表结构类型
export async function queryEnabledPlugins(db: Kysely<any>, orgId: string): Promise<Set<string>> {
  const rows = await kernelDb(db)
    .selectFrom("plugin_org_configs")
    .select("plugin")
    .where("org_id", "=", orgId)
    .where("enabled", "=", true)
    .execute();
  return new Set(rows.map((r) => r.plugin));
}

/** 越权审计去重键的 TTL：同一插件同一项在此期间只记一次。 */
const DENIAL_DEDUPE_TTL_SECONDS = 30 * 24 * 3600;

/**
 * 记一条 `plugin.permission_denied` 审计；按 (插件, 项) 经 Redis `SET NX EX` 去重（跨副本只记一次）。
 * 写审计失败时撤销去重键（下次越权再试）并记 warn，不向插件抛出（插件已收到 PluginPermissionError）。
 */
async function recordDenial(deps: KernelDeps, plugin: string, item: string): Promise<void> {
  const key = `capk:plugin-permission-denied:${plugin}:${item}`;
  try {
    const first = await deps.redis.set(key, "1", "EX", DENIAL_DEDUPE_TTL_SECONDS, "NX");
    if (first !== "OK") return;
    try {
      await audit(kernelDb(deps.db), {
        action: "plugin.permission_denied",
        target: plugin,
        detail: { plugin, item },
      });
    } catch (e) {
      await deps.redis.del(key).catch(() => {});
      throw e;
    }
  } catch (e) {
    deps.log.warn("plugin permission denial audit failed", { plugin, item, err: e });
  }
}

/** 插件的 PG schema 名：`plugin_<name>`，name 中的 `-` 换成 `_`。 */
export function pluginSchemaName(name: string): string {
  return `plugin_${name.replaceAll("-", "_")}`;
}

/**
 * 包装插件拿到的 Kysely：`destroy`（及 `Symbol.asyncDispose`）换成抛错的函数（连接池归内核所有，插件销毁会拖垮整个进程的 DB 访问），
 * 其余属性透传。方法绑定到原对象（Kysely 用私有字段，以 Proxy 作 this 调用会失败）。
 * 递归包裹一切能再拿到 Kysely 的路径，使 `destroy` 在任何路径都被拦截：
 * - 方法返回的新 Kysely（`withSchema` / `withPlugin` 等）；
 * - 方法返回的构建器（`transaction()` / `connection()` / `startTransaction()` 及其链式方法、
 *   受控事务的 `Command`）：其方法收到的回调拿到的 Kysely（`transaction().execute(cb)`、
 *   `connection().execute(cb)`）与返回的 Promise 结果（`startTransaction().execute()` 得到的受控事务）。
 */
// biome-ignore lint/suspicious/noExplicitAny: 内核不持有表结构类型
function guardDb(db: Kysely<any>, plugin: string): Kysely<any> {
  return new Proxy(db, {
    get(target, prop) {
      // `await using` 经 Symbol.asyncDispose 调用 destroy，同样拦截
      if (prop === "destroy" || prop === Symbol.asyncDispose) {
        return () => {
          throw new Error(
            `plugin ${plugin}: ctx.db.destroy() is not allowed; the kernel owns the connection pool`,
          );
        };
      }
      const value: unknown = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) =>
        guardValue((value as (...a: unknown[]) => unknown).apply(target, args), plugin);
    },
  });
}

/** 能（经回调或返回值）再拿到 Kysely 的构建器类。 */
const BUILDERS = [ConnectionBuilder, TransactionBuilder, ControlledTransactionBuilder, Command];

const isBuilder = (v: unknown): v is object => BUILDERS.some((B) => v instanceof B);

/** Kysely → guardDb；构建器 → guardBuilder；其余原样返回。 */
function guardValue(v: unknown, plugin: string): unknown {
  // biome-ignore lint/suspicious/noExplicitAny: 内核不持有表结构类型
  if (v instanceof Kysely) return guardDb(v as Kysely<any>, plugin);
  if (isBuilder(v)) return guardBuilder(v, plugin);
  return v;
}

/** 包装构建器：回调参数里的 Kysely、返回值与 Promise 结果都经 guardValue。 */
function guardBuilder<T extends object>(builder: T, plugin: string): T {
  return new Proxy(builder, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const wrapped = args.map((a) =>
          typeof a === "function"
            ? (...cbArgs: unknown[]) =>
                (a as (...x: unknown[]) => unknown)(...cbArgs.map((c) => guardValue(c, plugin)))
            : a,
        );
        const out = guardValue(
          (value as (...a: unknown[]) => unknown).apply(target, wrapped),
          plugin,
        );
        return out instanceof Promise ? out.then((r: unknown) => guardValue(r, plugin)) : out;
      };
    },
  });
}

/** 未注入能力访问时（单独构造 ctx 的测试等）：没有任何提供方，组织启用照常查库。 */
const noProviders = (deps: KernelDeps): CapabilityAccess => ({
  providers: () => [],
  enabledPlugins: (orgId) => queryEnabledPlugins(deps.db, orgId),
});

/** 内核视角的插件 ctx：插件契约之外还带宿主要用的登记信息与关闭方法。 */
export type KernelPluginContext = PluginContext & {
  routes: Route[];
  provided: Map<CapabilityRef, unknown>;
  /** 已注册的工具（按注册顺序）。 */
  registeredTools: RegisteredTool[];
  /** 经 `ctx.ui.view` 注册的视图（按贡献 id）。 */
  uiViews: ReadonlyMap<string, UiRender>;
  /** 经 `ctx.ui.action` 注册的动作处理函数（按贡献 id）。 */
  uiActions: ReadonlyMap<string, UiActionHandler>;
  /** setup 结束后调用：此后 `tools.register`、`ui.view`、`ui.action` 抛错。 */
  sealTools(): void;
  close(): Promise<void>;
};

/**
 * 为单个插件按权限清单构建命名空间化的 ctx，同时返回其注册的路由、提供的能力与关闭函数。
 * - 自动授予：`kv`、`lock`、`bus`、`queue`、`log`、`db`、`config`、`provide`；
 * - `secrets` 仅当 `permissions.secrets`；`http.route` 只允许 `permissions.http` 声明的 method + path；
 *   `tools.register` 只允许 `permissions.tools` 声明的名字；`ui.view` / `ui.action` 只允许 `permissions.ui.views`
 *   声明的 id（只在 setup 期间）；`ui.invalidate` 经内核 bus（命名空间 `kernel`）发刷新，跨副本；
 * - `capabilities` 只能取 `requires` / `optional` 声明的、非 brokered 的能力（经 `capabilityAccess`）。
 * 未声明的访问抛 `PluginPermissionError` 并写审计 `plugin.permission_denied`（每个插件每项只记一次）。
 */
export function createPluginContext(
  deps: KernelDeps,
  manifest: PluginManifest,
  deploymentConfig: unknown,
  capabilityAccess: CapabilityAccess = noProviders(deps),
): KernelPluginContext {
  const name = manifest.name;
  const routes: Route[] = [];
  const provided = new Map<CapabilityRef, unknown>();
  const registeredTools: RegisteredTool[] = [];
  let toolsSealed = false;
  const queue = createQueue(deps.redisUrl, name, { runWorkers: deps.runWorkers, log: deps.log });
  const { close: closeQueue, ...queueApi } = queue;
  const bus = createBus(deps.redis, deps.busSubscriber, name, deps.log);
  // 界面刷新发在内核命名空间（会话主题 conv.<id> / 组织主题 org-ui.<orgId>），不在插件自己的命名空间
  const kernelBus = createBus(deps.redis, deps.busSubscriber, "kernel", deps.log);
  const unsubs = new Set<() => Promise<void>>();
  const tag = (fields?: Record<string, unknown>) => ({ ...fields, plugin: name });
  let closing: Promise<void> | undefined;
  const perms = manifest.permissions ?? {};
  /** 进行中的越权审计写入（close 时等待，保证不比 ctx 活得久）。 */
  const audits = new Set<Promise<void>>();
  const deny = (item: string): never => {
    const p: Promise<void> = recordDenial(deps, name, item).finally(() => audits.delete(p));
    audits.add(p);
    throw new PluginPermissionError(name, item);
  };
  // 只暴露插件契约中的 get / set（KernelSecrets 的 delete 仅供内核使用）
  const secretsApi = perms.secrets
    ? (({ get, set }) => ({ get, set }))(createSecrets(deps.db, deps.keyring, name))
    : undefined;
  const declaredRoutes = new Set((perms.http ?? []).map((r) => `${r.method} ${r.path}`));
  const declaredTools = new Set(perms.tools ?? []);
  const declaredCaps = new Set<CapabilityRef>([
    ...(manifest.requires ?? []),
    ...(manifest.optional ?? []),
  ]);

  const uiReg = new PluginUiRegistration(manifest, deny);

  type Entry = { plugin: string; impl: unknown };
  /** 校验能力可取用（非 brokered、已在清单声明），返回其登记信息。 */
  const checkCapability = (ref: CapabilityRef) => {
    const capName = parseCapability(ref).name;
    const info = Object.hasOwn(CAPABILITIES, capName) ? CAPABILITIES[capName] : undefined;
    if (info?.brokered) {
      throw new Error(
        `plugin ${name}: capability ${ref} is brokered and can only be used through the platform API`,
      );
    }
    if (!info || !declaredCaps.has(ref)) return deny(`requires/optional ${ref}`);
    return info;
  };
  /** 部署级视角选出提供方：指定 provider 时按名找；单选能力取唯一提供方；多选能力必须指定。 */
  const pick = (ref: CapabilityRef, provider: string | undefined) => {
    const info = checkCapability(ref);
    const providers = capabilityAccess.providers(ref);
    if (provider !== undefined) {
      const chosen = providers.find((p) => p.plugin === provider);
      if (!chosen) {
        throw new CapabilityUnavailableError(
          `capability ${ref} is not provided by plugin ${provider}`,
        );
      }
      return { info, chosen };
    }
    if (info.cardinality === "multi") {
      // 多选能力即使只有一个提供者也要显式指定，避免新增提供者后行为悄悄变化
      throw new Error(
        `plugin ${name}: capability ${ref} is multi-provider; specify a provider name (available: ${providers.map((p) => p.plugin).join(", ") || "none"})`,
      );
    }
    const chosen = providers[0];
    if (!chosen) throw new CapabilityUnavailableError(`capability ${ref} has no provider`);
    return { info, chosen };
  };
  /** 组织视角过滤提供方：orgScoped 能力只留该组织已启用的（每次查询，不缓存）。 */
  const forOrg = async (orgScoped: boolean, orgId: string, entries: Entry[]) => {
    if (!orgScoped || entries.length === 0) return entries;
    const enabled = await capabilityAccess.enabledPlugins(orgId);
    return entries.filter((e) => enabled.has(e.plugin));
  };
  const listAll = (ref: CapabilityRef) => {
    const info = checkCapability(ref);
    return { info, entries: capabilityAccess.providers(ref).map((p) => ({ ...p })) };
  };

  // 不传 orgId：同步返回；传 orgId：返回 Promise，所有错误都以 reject 交出
  const capabilities = {
    get(ref: CapabilityRef, provider?: string, opts?: { orgId?: string }): unknown {
      const orgId = opts?.orgId;
      if (orgId === undefined) return pick(ref, provider).chosen.impl;
      return (async () => {
        const { info, chosen } = pick(ref, provider);
        if ((await forOrg(info.orgScoped, orgId, [chosen])).length === 0) {
          throw new CapabilityUnavailableError(
            `capability ${ref} provider ${chosen.plugin} is not enabled in organization ${orgId}`,
          );
        }
        return chosen.impl;
      })();
    },
    list(ref: CapabilityRef, opts?: { orgId?: string }): unknown {
      const orgId = opts?.orgId;
      if (orgId === undefined) return listAll(ref).entries;
      return (async () => {
        const { info, entries } = listAll(ref);
        return forOrg(info.orgScoped, orgId, entries);
      })();
    },
  } as PluginContext["capabilities"];

  const ctx: Omit<KernelPluginContext, "secrets"> = {
    kv: createKv(deps.redis, name),
    lock: createLock(deps.redis, name),
    capabilities,
    bus: {
      publish: bus.publish,
      async subscribe(topic, handler) {
        const closedError = () =>
          new Error(`plugin ${name}: ctx is closed; bus.subscribe is not allowed after close`);
        if (closing) throw closedError();
        const un = await bus.subscribe(topic, handler);
        // 订阅期间 ctx 被关闭：close 已清空退订集合，这里自己退订，不留下无人管的订阅
        if (closing) {
          await un();
          throw closedError();
        }
        unsubs.add(un);
        return async () => {
          unsubs.delete(un);
          await un();
        };
      },
    },
    queue: queueApi,
    db: guardDb(deps.db.withSchema(pluginSchemaName(name)), name),
    http: {
      route(method, path, handler) {
        if (typeof path !== "string" || !path.startsWith("/")) {
          throw new Error(`plugin ${name}: route path "${path}" must start with "/"`);
        }
        if (!declaredRoutes.has(`${method} ${path}`)) deny(`permissions.http ${method} ${path}`);
        const full = `/plugins/${name}${path}`;
        if (routes.some((r) => r.method === method && r.path === full)) {
          throw new Error(`plugin ${name}: duplicate route ${method} ${path}`);
        }
        routes.push({ method, path: full, handler });
      },
    },
    tools: {
      register(spec, handler) {
        if (toolsSealed) {
          throw new Error(
            `plugin ${name}: tools.register is only allowed during setup; setup has completed`,
          );
        }
        const problems = validateToolSpec(spec);
        if (problems.length > 0) {
          throw new Error(`plugin ${name}: invalid tool spec: ${problems.join("; ")}`);
        }
        if (!declaredTools.has(spec.name)) deny(`permissions.tools ${spec.name}`);
        if (typeof handler !== "function") {
          throw new Error(`plugin ${name}: tool "${spec.name}" handler must be a function`);
        }
        if (registeredTools.some((t) => t.spec.name === spec.name)) {
          throw new Error(`plugin ${name}: duplicate tool "${spec.name}"`);
        }
        registeredTools.push({ spec, handler });
      },
    },
    ui: {
      view(id, render) {
        uiReg.view(id, render);
      },
      action(id, handler) {
        uiReg.action(id, handler);
      },
      async invalidate(target) {
        const t = uiReg.target(target);
        const msg: UiBusMessage = { kind: "ui", plugin: name, contribution: t.contribution };
        await kernelBus.publish(
          t.conversationId !== undefined
            ? conversationTopic(t.conversationId)
            : orgUiTopic(t.orgId),
          msg,
        );
      },
      // TODO(M4 T26)：校验内核签发的嵌入令牌；在那之前一律不认
      async verifyEmbedToken() {
        return null;
      },
    },
    provide(capability, impl) {
      if (!manifest.provides.includes(capability)) {
        throw new Error(
          `plugin ${name}: provided capability ${capability} not declared in provides`,
        );
      }
      if (provided.has(capability)) {
        throw new Error(`plugin ${name}: capability ${capability} provided more than once`);
      }
      provided.set(capability, impl);
    },
    config: deploymentConfig,
    log: {
      info: (msg, fields) => deps.log.info(msg, tag(fields)),
      warn: (msg, fields) => deps.log.warn(msg, tag(fields)),
      error: (msg, fields) => deps.log.error(msg, tag(fields)),
    },
    routes,
    provided,
    registeredTools,
    uiViews: uiReg.views,
    uiActions: uiReg.actions,
    sealTools() {
      toolsSealed = true;
      uiReg.seal();
    },
    /** 幂等：重复 / 并发调用共享同一次关闭。 */
    close() {
      closing ??= (async () => {
        const pending = [...unsubs];
        unsubs.clear();
        await Promise.allSettled(pending.map((u) => u()));
        await closeQueue();
        await Promise.allSettled([...audits]);
      })();
      return closing;
    },
  };
  // 声明了 secrets 时是普通属性；未声明时是不可枚举的抛错 getter——展开 / 打印 ctx 不会触发越权与审计
  if (secretsApi) return Object.assign(ctx, { secrets: secretsApi });
  Object.defineProperty(ctx, "secrets", {
    get: () => deny("permissions.secrets"),
    enumerable: false,
    configurable: false,
  });
  return ctx as KernelPluginContext;
}
