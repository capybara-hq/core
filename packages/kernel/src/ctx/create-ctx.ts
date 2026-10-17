import type { CapabilityRef, Logger, PluginContext, PluginManifest } from "@capybara-hq/plugin-sdk";
import type { Redis } from "ioredis";
import { Kysely } from "kysely";
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
 * 包装插件拿到的 Kysely：`destroy` 换成抛错的函数（连接池归内核所有，插件销毁会拖垮整个进程的 DB 访问），
 * 其余属性透传。方法绑定到原对象（Kysely 用私有字段，以 Proxy 作 this 调用会失败）；
 * 返回新 Kysely 实例的方法（如 `withSchema` / `withPlugin`）其结果同样包装。
 */
// biome-ignore lint/suspicious/noExplicitAny: 内核不持有表结构类型
function guardDb(db: Kysely<any>, plugin: string): Kysely<any> {
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "destroy") {
        return () => {
          throw new Error(
            `plugin ${plugin}: ctx.db.destroy() is not allowed; the kernel owns the connection pool`,
          );
        };
      }
      const value: unknown = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const out: unknown = (value as (...a: unknown[]) => unknown).apply(target, args);
        return out instanceof Kysely ? guardDb(out, plugin) : out;
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
