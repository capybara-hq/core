import type { CapabilityRef, Logger, PluginContext, PluginManifest } from "@capybara-hq/plugin-sdk";
import type { Redis } from "ioredis";
import {
  Command,
  ConnectionBuilder,
  ControlledTransactionBuilder,
  Kysely,
  TransactionBuilder,
} from "kysely";
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

/** 为单个插件构建命名空间化的 ctx，同时返回其注册的路由、提供的能力与关闭函数。 */
export function createPluginContext(
  deps: KernelDeps,
  manifest: PluginManifest,
  deploymentConfig: unknown,
): PluginContext & {
  routes: Route[];
  provided: Map<CapabilityRef, unknown>;
  close(): Promise<void>;
} {
  const name = manifest.name;
  const routes: Route[] = [];
  const provided = new Map<CapabilityRef, unknown>();
  const queue = createQueue(deps.redisUrl, name, { runWorkers: deps.runWorkers, log: deps.log });
  const { close: closeQueue, ...queueApi } = queue;
  const bus = createBus(deps.redis, deps.busSubscriber, name, deps.log);
  const unsubs = new Set<() => Promise<void>>();
  const tag = (fields?: Record<string, unknown>) => ({ ...fields, plugin: name });
  let closing: Promise<void> | undefined;

  return {
    kv: createKv(deps.redis, name),
    lock: createLock(deps.redis, name),
    bus: {
      publish: bus.publish,
      async subscribe(topic, handler) {
        const un = await bus.subscribe(topic, handler);
        unsubs.add(un);
        return async () => {
          unsubs.delete(un);
          await un();
        };
      },
    },
    queue: queueApi,
    // 只暴露插件契约中的 get / set（KernelSecrets 的 delete 仅供内核使用）
    secrets: (({ get, set }) => ({ get, set }))(createSecrets(deps.db, deps.keyring, name)),
    db: guardDb(deps.db.withSchema(pluginSchemaName(name)), name),
    http: {
      route(method, path, handler) {
        if (typeof path !== "string" || !path.startsWith("/")) {
          throw new Error(`plugin ${name}: route path "${path}" must start with "/"`);
        }
        const full = `/plugins/${name}${path}`;
        if (routes.some((r) => r.method === method && r.path === full)) {
          throw new Error(`plugin ${name}: duplicate route ${method} ${path}`);
        }
        routes.push({ method, path: full, handler });
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
    /** 幂等：重复 / 并发调用共享同一次关闭。 */
    close() {
      closing ??= (async () => {
        const pending = [...unsubs];
        unsubs.clear();
        await Promise.allSettled(pending.map((u) => u()));
        await closeQueue();
      })();
      return closing;
    },
  };
}
