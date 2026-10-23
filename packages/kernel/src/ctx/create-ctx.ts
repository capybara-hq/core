import {
  type AvailableHook,
  CAPABILITIES,
  type CapabilityRef,
  CapabilityUnavailableError,
  type HookHandler,
  type Logger,
  OBJECT_STORE_CAPABILITY,
  type ObjectStore,
  type PluginContext,
  type PluginManifest,
  PluginPermissionError,
  type PluginStorage,
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
import type { OrgRole } from "../orgs/roles.js";
import { checkHookRegistration, type RegisteredHook } from "../plugins/hooks.js";
import { RegistrationLedger } from "../plugins/ledger.js";
import { StorageService } from "../storage/storage.service.js";
import { EmbedTokens } from "../ui/embed-token.js";
import {
  canUsePlace,
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
  /** 内核 logger（`debug` 可选：插件 Logger 没有它，测试可不给）。 */
  log: Logger & { debug?(msg: string, fields?: Record<string, unknown>): void };
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

/**
 * 嵌入令牌校验时的一条查询：插件在该组织启用、组织未删除、账号 active、仍是成员；返回此刻的角色，不满足返回 undefined。
 */
async function currentEmbedRole(
  db: KernelDeps["db"],
  plugin: string,
  orgId: string,
  accountId: string,
): Promise<OrgRole | undefined> {
  const row = await kernelDb(db)
    .selectFrom("memberships")
    .innerJoin("orgs", "orgs.id", "memberships.org_id")
    .innerJoin("accounts", "accounts.id", "memberships.account_id")
    .innerJoin("plugin_org_configs", (j) =>
      j
        .onRef("plugin_org_configs.org_id", "=", "memberships.org_id")
        .on("plugin_org_configs.plugin", "=", plugin)
        .on("plugin_org_configs.enabled", "=", true),
    )
    .select("memberships.role")
    .where("memberships.org_id", "=", orgId)
    .where("memberships.account_id", "=", accountId)
    .where("orgs.deleted_at", "is", null)
    .where("accounts.status", "=", "active")
    .executeTakeFirst();
  return row?.role;
}

/** `ui.invalidate` 目标的一条查询：插件在该组织启用，且（带对话时）对话属于该组织。 */
async function invalidateTargetOk(
  db: KernelDeps["db"],
  plugin: string,
  orgId: string,
  conversationId: string | undefined,
): Promise<boolean> {
  const k = kernelDb(db);
  let q = k
    .selectFrom("plugin_org_configs")
    .select("plugin_org_configs.plugin")
    .where("plugin_org_configs.plugin", "=", plugin)
    .where("plugin_org_configs.org_id", "=", orgId)
    .where("plugin_org_configs.enabled", "=", true);
  if (conversationId !== undefined) {
    q = q.where((eb) =>
      eb.exists(
        eb
          .selectFrom("conversations")
          .select("conversations.id")
          .where("conversations.id", "=", conversationId)
          .whereRef("conversations.org_id", "=", "plugin_org_configs.org_id"),
      ),
    );
  }
  return (await q.executeTakeFirst()) !== undefined;
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
  /** 本实例的登记账（C17）：每次登记记一笔，撤销时逐项撤销。 */
  ledger: RegistrationLedger;
  /**
   * 撤销第一步：停止取新的队列任务；`deadline`（epoch 毫秒）之后撤销队列 worker 时不再等进行中的任务。
   */
  beginDispose(deadline: number): Promise<void>;
  /** 等本实例队列 worker 进行中的任务结束，最多等到 `deadline`（epoch 毫秒）。 */
  drainQueues(deadline: number): Promise<"drained" | "timeout">;
  /** 中止 `ctx.signal`（幂等）。 */
  abort(): void;
  routes: Route[];
  provided: Map<CapabilityRef, unknown>;
  /** 已注册的工具（按注册顺序）。 */
  registeredTools: RegisteredTool[];
  /** Hooks registered through `ctx.hooks.on` (registration order). */
  registeredHooks: RegisteredHook[];
  /** 经 `ctx.ui.view` 注册的视图（按贡献 id）。 */
  uiViews: ReadonlyMap<string, UiRender>;
  /** 经 `ctx.ui.action` 注册的动作处理函数（按贡献 id）。 */
  uiActions: ReadonlyMap<string, UiActionHandler>;
  /** setup 结束后调用：此后 `tools.register`、`ui.view`、`ui.action`、`hooks.on` 抛错。 */
  sealTools(): void;
  /** 中止 signal、封账并逐项撤销仍在账上的登记、关闭队列连接（幂等）。 */
  close(): Promise<void>;
};

/**
 * 插件实例的部署配置（已校验）：`ctx.config` 是读它的 getter。hot 字段改动时宿主替换 `value`（C10），
 * 插件下次读 `ctx.config` 就是新值；非 hot 改动重新加载实例（新 ctx）。
 */
export class LiveConfig {
  constructor(public value: unknown) {}
}

/**
 * 为单个插件按权限清单构建命名空间化的 ctx，同时返回其注册的路由、提供的能力与关闭函数。
 * `deploymentConfig` 可以是 {@link LiveConfig}（实例共用、可就地替换），否则按固定值包一层。
 * - 自动授予：`kv`、`lock`、`bus`、`queue`、`log`、`db`、`config`、`provide`；
 * - `secrets` 仅当 `permissions.secrets`，`storage` 仅当 `permissions.storage`；`http.route` 只允许 `permissions.http` 声明的 method + path；
 *   `tools.register` 只允许 `permissions.tools` 声明的名字；`ui.view` / `ui.action` 只允许 `permissions.ui.views`
 *   声明的 id（只在 setup 期间）；`ui.invalidate` 经内核 bus（命名空间 `kernel`）发刷新，跨副本；
 *   `ui.verifyEmbedToken` 校验内核签发的嵌入令牌，`claims.plugin` 必须是本插件、插件仍在该组织启用、
 *   调用者仍是该组织的 active 成员（组织未删除），返回此刻的角色；
 * - `capabilities` 只能取 `requires` / `optional` 声明的、非 brokered 的能力（经 `capabilityAccess`）。
 * - `hooks.on` only during setup, only mount points declared in `permissions.hooks` and available
 *   (`HOOKS_AVAILABLE`), `policy` only on `POLICY_HOOKS`; kept on the ctx (`registeredHooks`, read by
 *   the host's `HookRegistry` from active instances only) and recorded in the ledger.
 * 未声明的访问抛 `PluginPermissionError` 并写审计 `plugin.permission_denied`（每个插件每项只记一次）。
 */
export function createPluginContext(
  deps: KernelDeps,
  manifest: PluginManifest,
  deploymentConfig: unknown,
  capabilityAccess: CapabilityAccess = noProviders(deps),
): KernelPluginContext {
  const name = manifest.name;
  const live =
    deploymentConfig instanceof LiveConfig ? deploymentConfig : new LiveConfig(deploymentConfig);
  const routes: Route[] = [];
  const provided = new Map<CapabilityRef, unknown>();
  const registeredTools: RegisteredTool[] = [];
  let toolsSealed = false;
  const queue = createQueue(deps.redisUrl, name, { runWorkers: deps.runWorkers, log: deps.log });
  const bus = createBus(deps.redis, deps.busSubscriber, name, deps.log);
  // 界面刷新发在内核命名空间（会话主题 conv.<id> / 组织主题 org-ui.<orgId>），不在插件自己的命名空间
  const kernelBus = createBus(deps.redis, deps.busSubscriber, "kernel", deps.log);
  const ledger = new RegistrationLedger(name);
  const lifecycle = new AbortController();
  /** 撤销时队列 worker 排空的截止时刻（epoch 毫秒）；undefined = 一直等（停机路径）。 */
  let drainDeadline: number | undefined;
  const lock = createLock(deps.redis, name);
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
  // ctx.storage：经已加载的 object-store@1 提供方（按调用时取；依赖排序保证提供方先于本插件 setup），
  // 键加前缀 plugins/<name>/<orgId>/。没有提供方时各方法 reject storage.unavailable
  // （宿主不会加载这样的插件，见 approvals.ts；单独构造 ctx 的测试会走到这里）
  const storageApi: PluginStorage | undefined = perms.storage
    ? new StorageService({
        provider: () =>
          capabilityAccess.providers(OBJECT_STORE_CAPABILITY)[0]?.impl as ObjectStore | undefined,
        plugins: async () => [name],
      }).forPlugin(name)
    : undefined;
  const declaredRoutes = new Set((perms.http ?? []).map((r) => `${r.method} ${r.path}`));
  const declaredTools = new Set(perms.tools ?? []);
  const declaredHooks = new Set<string>(perms.hooks ?? []);
  const registeredHooks: RegisteredHook[] = [];
  const declaredCaps = new Set<CapabilityRef>([
    ...(manifest.requires ?? []),
    ...(manifest.optional ?? []),
  ]);

  const uiReg = new PluginUiRegistration(manifest, deny);
  const embedTokens = new EmbedTokens(deps.keyring);
  const uiPlaces = new Map((manifest.ui ?? []).map((c) => [c.id, c.place]));

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

  const ctx: Omit<KernelPluginContext, "secrets" | "storage"> = {
    kv: createKv(deps.redis, name),
    lock: {
      // 取到的租约记账：实例撤销时释放仍持有的；插件自己 release 时销账
      async acquire(key, opts) {
        const lease = await lock.acquire(key, opts);
        if (!lease) return null;
        const settle = ledger.add({ kind: "lease", key, dispose: () => lease.release() });
        return {
          renew: () => lease.renew(),
          async release() {
            settle();
            await lease.release();
          },
        };
      },
    },
    capabilities,
    bus: {
      publish: bus.publish,
      async subscribe(topic, handler) {
        const closedError = () =>
          new Error(`plugin ${name}: ctx is closed; bus.subscribe is not allowed after close`);
        if (closing || ledger.sealed) throw closedError();
        const un = await bus.subscribe(topic, handler);
        // 订阅期间 ctx 被关闭 / 实例开始撤销：账已封，这里自己退订，不留下无人管的订阅
        if (closing || ledger.sealed) {
          await un();
          throw closedError();
        }
        const settle = ledger.add({ kind: "bus", key: topic, dispose: un });
        return async () => {
          settle();
          await un();
        };
      },
    },
    queue: {
      define(qname, handler, o) {
        queue.define(qname, handler, o);
        ledger.add({
          kind: "queue",
          key: qname,
          dispose: () => queue.stopWorker(qname, drainDeadline),
        });
      },
      add: queue.add,
    },
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
        const route: Route = { method, path: full, handler };
        routes.push(route);
        ledger.add({
          kind: "route",
          key: `${method} ${path}`,
          dispose: async () => {
            const i = routes.indexOf(route);
            if (i >= 0) routes.splice(i, 1);
          },
        });
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
        const tool: RegisteredTool = { spec, handler };
        registeredTools.push(tool);
        ledger.add({
          kind: "tool",
          key: spec.name,
          dispose: async () => {
            const i = registeredTools.indexOf(tool);
            if (i >= 0) registeredTools.splice(i, 1);
          },
        });
      },
    },
    hooks: {
      on(mount, handler, opts) {
        if (toolsSealed) {
          throw new Error(
            `plugin ${name}: hooks.on is only allowed during setup; setup has completed`,
          );
        }
        // not-available / malformed registrations are programming errors, not permission denials
        checkHookRegistration(name, mount, handler, opts);
        if (!declaredHooks.has(mount)) deny(`permissions.hooks ${mount}`);
        const hook: RegisteredHook = {
          mount: mount as AvailableHook,
          handler: handler as HookHandler<AvailableHook>,
          mode: opts.mode,
        };
        registeredHooks.push(hook);
        ledger.add({
          kind: "hook",
          key: mount,
          dispose: async () => {
            const i = registeredHooks.indexOf(hook);
            if (i >= 0) registeredHooks.splice(i, 1);
          },
        });
      },
    },
    ui: {
      view(id, render) {
        uiReg.view(id, render);
        ledger.add({
          kind: "ui.view",
          key: id,
          dispose: async () => {
            if (uiReg.views.get(id) === render) uiReg.views.delete(id);
          },
        });
      },
      action(id, handler) {
        uiReg.action(id, handler);
        ledger.add({
          kind: "ui.action",
          key: id,
          dispose: async () => {
            if (uiReg.actions.get(id) === handler) uiReg.actions.delete(id);
          },
        });
      },
      // 目标先核对（一条查询）：插件在 orgId 启用；带对话时对话属于 orgId。不满足就只记 debug、不发
      // （插件拿着过期或别的组织的 id 调用不是错误，但不能借它往别的组织的流里发刷新）
      async invalidate(target) {
        const t = uiReg.target(target);
        if (!(await invalidateTargetOk(deps.db, name, t.orgId, t.conversationId))) {
          deps.log.debug?.(
            "plugin ui invalidate ignored: plugin not enabled or conversation not in org",
            {
              plugin: name,
              orgId: t.orgId,
              ...(t.conversationId !== undefined && { conversationId: t.conversationId }),
              contribution: t.contribution,
            },
          );
          return;
        }
        const msg: UiBusMessage = { kind: "ui", plugin: name, contribution: t.contribution };
        await kernelBus.publish(
          t.conversationId !== undefined
            ? conversationTopic(t.conversationId)
            : orgUiTopic(t.orgId),
          msg,
        );
      },
      // 只认签给本插件、未过期、未篡改的令牌（见 ui/embed-token.ts）；再用一条查询核对此刻：本插件仍在该组织
      // 启用、组织未删除、账号 active 且仍是成员（每次查 PG、不缓存：停用插件、离职、停用账号后已签出的令牌立即失效）。
      // 返回的 role 是此刻的角色；组织页面的令牌在调用者已降为 guest 时失效（A38）。其余一律 null
      async verifyEmbedToken(token) {
        const claims = embedTokens.verify(token, name);
        if (claims === null) return null;
        const role = await currentEmbedRole(deps.db, name, claims.orgId, claims.accountId);
        if (role === undefined) return null;
        if (!canUsePlace(uiPlaces.get(claims.contribution) ?? "page", role)) return null;
        return { ...claims, role };
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
      ledger.add({
        kind: "provide",
        key: capability,
        dispose: async () => {
          if (provided.get(capability) === impl) provided.delete(capability);
        },
      });
    },
    signal: lifecycle.signal,
    // getter：hot 字段改动就地替换（C10），插件用时读到新值
    get config(): unknown {
      return live.value;
    },
    log: {
      info: (msg, fields) => deps.log.info(msg, tag(fields)),
      warn: (msg, fields) => deps.log.warn(msg, tag(fields)),
      error: (msg, fields) => deps.log.error(msg, tag(fields)),
    },
    routes,
    provided,
    registeredTools,
    registeredHooks,
    uiViews: uiReg.views,
    uiActions: uiReg.actions,
    ledger,
    async beginDispose(deadline) {
      drainDeadline = deadline;
      await queue.pauseWorkers();
    },
    drainQueues: (deadline) => queue.drainWorkers(deadline),
    abort() {
      if (!lifecycle.signal.aborted) lifecycle.abort();
    },
    sealTools() {
      toolsSealed = true;
      uiReg.seal();
    },
    /** 幂等：重复 / 并发调用共享同一次关闭。 */
    close() {
      closing ??= (async () => {
        if (!lifecycle.signal.aborted) lifecycle.abort();
        await ledger.disposeAll((r, err) =>
          deps.log.warn("plugin registration dispose failed", {
            plugin: name,
            kind: r.kind,
            key: r.key,
            err,
          }),
        );
        await queue.close();
        await Promise.allSettled([...audits]);
      })();
      return closing;
    },
  };
  // 声明了 secrets / storage 时是普通属性；未声明时是不可枚举的抛错 getter——展开 / 打印 ctx 不会触发越权与审计
  const gated = (key: "secrets" | "storage", api: unknown): void => {
    if (api) {
      Object.assign(ctx, { [key]: api });
      return;
    }
    Object.defineProperty(ctx, key, {
      get: () => deny(`permissions.${key}`),
      enumerable: false,
      configurable: false,
    });
  };
  gated("secrets", secretsApi);
  gated("storage", storageApi);
  return ctx as KernelPluginContext;
}
