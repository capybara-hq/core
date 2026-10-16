import type { CapabilityRef, Logger, PluginContext, PluginManifest } from "@capybara-hq/plugin-sdk";
import type { Redis } from "ioredis";
import type { Kysely } from "kysely";
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
  const queue = createQueue(deps.redisUrl, name, { runWorkers: deps.runWorkers });
  const { close: closeQueue, ...queueApi } = queue;

  return {
    kv: createKv(deps.redis, name),
    lock: createLock(deps.redis, name),
    bus: createBus(deps.redis, deps.busSubscriber, name),
    queue: queueApi,
    secrets: createSecrets(deps.db, deps.keyring, name),
    db: deps.db.withSchema(pluginSchemaName(name)),
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
    log: deps.log,
    routes,
    provided,
    close: closeQueue,
  };
}
