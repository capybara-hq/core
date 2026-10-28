import "reflect-metadata";
import type { Logger } from "@capybara-hq/plugin-sdk";
import fastifyCookie from "@fastify/cookie";
import { type DynamicModule, Module } from "@nestjs/common";
import { APP_FILTER, NestFactory } from "@nestjs/core";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { FastifyInstance, FastifyReply, InjectOptions, LightMyRequestResponse } from "fastify";
import type { Route } from "../ctx/create-ctx.js";
import { ApiError, errorBody } from "../errors.js";
import { type AuthServices, authorizeEnterpriseAdmin } from "../identity/auth.guard.js";
import { CHECK_TIMEOUT_MS, HealthController } from "../infra/health/health.controller.js";
import { HealthModule } from "../infra/health/health.module.js";
import {
  HEALTH_CHECKS,
  HEALTH_TIMEOUT_MS,
  type HealthOptions,
} from "../infra/health/health.options.js";
import { SHUTDOWN_STATE } from "../infra/health/shutdown-state.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import { withLogContext } from "../log-context.js";
import { createKernelAdapter } from "./adapter.js";
import { ErrorFilter, redactPath } from "./error.filter.js";
import { type GatewayRoutes, registerGatewayRoutes } from "./gateway.module.js";
import { NestLogAdapter } from "./nest-logger.js";
import {
  createPluginRouter,
  type PluginRouteTable,
  registerPluginDispatch,
  staticRouteTable,
} from "./plugin-dispatch.js";
import { ACCOUNTS, API_TOKENS, SESSIONS } from "./tokens.js";

export type { HealthOptions } from "../infra/health/health.options.js";

/** 内核 HTTP 的只读视图：进程内注入请求与列出路由（测试与元测试用）。 */
export interface KernelHttp {
  inject(opts: InjectOptions): Promise<LightMyRequestResponse>;
  /** 已注册的全部路由（Fastify onRoute 收集），供元测试遍历。 */
  routes(): { method: string; url: string }[];
  /** 服务端当前打开的 TCP 连接数（测试观察连接是否被释放）。 */
  connections(): Promise<number>;
}

/** 内核 HTTP 应用。 */
export interface KernelHttpApp extends KernelHttp {
  /**
   * Mounts extension routes; paths must start with `/plugins/`. May be called only once. With a route
   * source ({@link PluginRouteTable}) routes are resolved live per request (an extension revoked /
   * replaced takes effect right away), and a revoked extension answers 503 `extension.unavailable`.
   */
  mountPlugins(routes: Route[] | PluginRouteTable): void;
  /** 监听 0.0.0.0，返回实际端口。 */
  listen(port: number): Promise<number>;
  close(): Promise<void>;
  /** 中止进行中（及此后到达）的插件请求的 `req.signal`：停机开始时调用，插件长连接据此收尾。 */
  abortPluginRequests(): void;
  /** 强制断开所有连接（含进行中的请求）；停机时 `close()` 超时后调用。 */
  closeAllConnections(): void;
}

export interface CreateHttpAppOptions {
  log: Logger;
  health: HealthOptions;
  /** 是否提供内核 API（`apiModule`）。 */
  serveApi: boolean;
  /** 是否转发 `/plugins/*` 到插件路由。 */
  servePlugins: boolean;
  /**
   * Gateway-role routes (the channel webhook), registered only when given: the kernel passes them
   * when `roles` includes `gateway` (`serveGateway`).
   */
  gateway?: GatewayRoutes;
  apiModule?: DynamicModule;
  /** 信任哪些代理跳：false、跳数，或受信代理 IP / CIDR 列表（见 `http.trustProxy` 配置）。 */
  trustProxy?: boolean | number | string[];
  /** 副本标识（`http.replicaId`）：设置时每个响应带 `x-capybara-replica` 头。 */
  replicaId?: string | undefined;
  /**
   * The size limit for package uploads ({@link PACKAGE_UPLOAD_ROUTES}: extension packages and
   * enterprise catalog packages, `application/octet-stream`), i.e. `packages.maxBytes`. The route
   * bodyLimit is one byte more: a package exactly one byte over reaches the handler and returns
   * `extension.package_too_large`; larger ones are refused by Fastify itself (413
   * `payload_too_large`).
   */
  packageMaxBytes?: number;
}

/** The extension package upload route (Fastify route template). */
export const EXTENSION_PACKAGE_UPLOAD_ROUTE = "/api/v1/admin/extensions/packages/file";
/** The plugin package upload route of the catalog import (Fastify route template). */
export const CATALOG_UPLOAD_ROUTE = "/api/v1/admin/catalog/import/file";
/**
 * The upload routes that take raw bytes (`application/octet-stream`, limit `packages.maxBytes`,
 * the enterprise admin is authenticated before the body is read).
 */
export const PACKAGE_UPLOAD_ROUTES: ReadonlySet<string> = new Set([
  EXTENSION_PACKAGE_UPLOAD_ROUTE,
  CATALOG_UPLOAD_ROUTE,
]);

/** Paths without an access log line (probes). */
const QUIET_PATHS = new Set(["/healthz", "/readyz"]);

/**
 * Request ids and the access log. Every request runs in a log context with its `reqId` (records
 * logged while handling it carry it) and answers with `x-request-id` (set on the raw response, so
 * hijacked SSE streams carry it too). One access line per request when the response is done:
 * `info`, except event streams (`debug`, when they close) and the probes (none).
 */
function registerRequestLog(fastify: FastifyInstance, log: Logger & { debug?: Logger["info"] }) {
  fastify.addHook("onRequest", (req, reply, done) => {
    reply.raw.setHeader("x-request-id", req.id);
    const started = performance.now();
    const path = req.url.split("?")[0] ?? "";
    let logged = false;
    const accessLine = () => {
      if (logged || QUIET_PATHS.has(path)) return;
      logged = true;
      const type = String(reply.raw.getHeader("content-type") ?? "");
      const fields = {
        method: req.method,
        url: redactPath(req.url),
        status: reply.raw.statusCode,
        ms: Math.round(performance.now() - started),
        reqId: req.id,
      };
      if (type.startsWith("text/event-stream")) log.debug?.("request", fields);
      else log.info("request", fields);
    };
    reply.raw.once("finish", accessLine);
    reply.raw.once("close", accessLine);
    withLogContext({ reqId: req.id }, done);
  });
}

/** 允许较大请求体的路由（Fastify 路由模板，只读常量表）及其上限。 */
const LARGE_BODY_ROUTES = new Set([
  "/api/v1/orgs/:orgId/connectors",
  "/api/v1/orgs/:orgId/connectors/preview",
]);
const LARGE_BODY_LIMIT = 6 * 1024 * 1024;

/** Root module: always has the health endpoints; imports `apiModule` when `serveApi`; the global error filter. */
function rootModule(opts: CreateHttpAppOptions): DynamicModule {
  @Module({})
  class RootModule {}
  return {
    module: RootModule,
    imports: [HealthModule, ...(opts.serveApi && opts.apiModule ? [opts.apiModule] : [])],
    controllers: [HealthController],
    providers: [
      { provide: KERNEL_LOGGER, useValue: opts.log },
      { provide: HEALTH_CHECKS, useValue: opts.health.checks },
      { provide: HEALTH_TIMEOUT_MS, useValue: opts.health.timeoutMs ?? CHECK_TIMEOUT_MS },
      { provide: SHUTDOWN_STATE, useValue: { isShuttingDown: opts.health.isStopping } },
      { provide: APP_FILTER, useClass: ErrorFilter },
    ],
  };
}

/**
 * Sets up the kernel HTTP application (NestJS + Fastify) without connecting to anything.
 * Extension routes do not go through Nest: `/plugins/*` is dispatched in its own Fastify scope
 * (see plugin-dispatch.ts) and answers 404 until extensions are loaded. Unmatched kernel routes
 * answer the 404 error envelope as well.
 *
 * With `existing` (the kernel's single Nest application, built by `createKernelApp` from `KernelModule`)
 * the Fastify side of that application is configured and returned uninitialized: `init()` is the
 * caller's (it runs the start sequence), `close()` closes only the HTTP server (the rest of the
 * application is closed by the caller's shutdown). Without it, a standalone application is
 * created from `opts` (health checks, `apiModule` when `serveApi`) and initialized; `close()` closes
 * it.
 */
export async function createHttpApp(
  opts: CreateHttpAppOptions,
  existing?: NestFastifyApplication,
): Promise<KernelHttpApp> {
  const app =
    existing ??
    (await NestFactory.create<NestFastifyApplication>(
      rootModule(opts),
      createKernelAdapter(opts.trustProxy ?? false),
      { logger: new NestLogAdapter(opts.log), abortOnError: false },
    ));
  // Cookie 解析（会话 Cookie）；必须在 init 之前注册
  await app.register(fastifyCookie);
  const fastify = app.getHttpAdapter().getInstance();
  registerRequestLog(fastify, opts.log);
  const replicaId = opts.replicaId;
  if (replicaId !== undefined) {
    // 直接设在原始响应上：hijack 后自己 writeHead 的 SSE 流也会带上（writeHead 合并已 setHeader 的头）
    fastify.addHook("onRequest", async (_req, reply) => {
      reply.raw.setHeader("x-capybara-replica", replicaId);
    });
  }
  const routes: { method: string; url: string }[] = [];
  fastify.addHook("onRoute", (r) => {
    for (const method of [r.method].flat()) routes.push({ method, url: r.url });
    // 安装 / 预览连接器的请求体可带最大 2 MB 的 OpenAPI 文档（JSON 转义后更大），其余路由保持默认 1 MiB
    if (LARGE_BODY_ROUTES.has(r.url) && [r.method].flat().includes("POST")) {
      r.bodyLimit = LARGE_BODY_LIMIT;
    }
    if (PACKAGE_UPLOAD_ROUTES.has(r.url) && opts.packageMaxBytes !== undefined) {
      r.bodyLimit = opts.packageMaxBytes + 1;
    }
  });
  // 读请求体之前：包上传（插件包、企业目录包）先认证（未认证 / 非企业管理员的大请求体不读进内存）；其余内核路由不收
  // application/octet-stream（415）。插件路由 /plugins/* 在自己的作用域里收任何类型，不受影响
  let authServices: AuthServices | undefined;
  const services = (): AuthServices => {
    authServices ??= {
      accounts: app.get(ACCOUNTS, { strict: false }),
      sessions: app.get(SESSIONS, { strict: false }),
      tokens: app.get(API_TOKENS, { strict: false }),
    };
    return authServices;
  };
  const sendError = (reply: FastifyReply, e: unknown, method: string, url: string) => {
    if (e instanceof ApiError) {
      return reply.code(e.status).send(errorBody(e.code, e.message, e.details));
    }
    opts.log.error("http handler failed", { method, path: redactPath(url), err: e });
    return reply.code(500).send(errorBody("internal", "Internal error"));
  };
  fastify.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/api/")) return;
    if (req.method === "POST" && PACKAGE_UPLOAD_ROUTES.has(req.routeOptions.url ?? "")) {
      try {
        await authorizeEnterpriseAdmin(req, services());
      } catch (e) {
        return sendError(reply, e, req.method, req.url);
      }
      return;
    }
    const type = String(req.headers["content-type"] ?? "")
      .split(";")[0]
      ?.trim()
      .toLowerCase();
    if (type === "application/octet-stream") {
      return reply
        .code(415)
        .send(
          errorBody(
            "unsupported_media_type",
            "This endpoint does not accept application/octet-stream request bodies",
          ),
        );
    }
  });
  // 原始字节的请求体（只有包上传路由能走到这里，见上面的 onRequest）：交给处理函数一个 Buffer
  fastify.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer" },
    (_req, body, done) => done(null, body),
  );

  let table: PluginRouteTable | undefined;
  let unwatch: (() => void) | undefined;
  const dispatch = opts.servePlugins
    ? await registerPluginDispatch(fastify, () => table, opts.log)
    : undefined;
  if (opts.gateway) await registerGatewayRoutes(fastify, opts.gateway, opts.log);
  if (!existing) await app.init();

  return {
    inject: (o) => fastify.inject(o),
    routes: () => [...routes],
    connections: () =>
      new Promise<number>((resolve, reject) =>
        fastify.server.getConnections((err, n) => (err ? reject(err) : resolve(n))),
      ),
    mountPlugins(pluginRoutes) {
      if (table) throw new Error("plugin routes already mounted");
      const t = Array.isArray(pluginRoutes) ? staticRouteTable(pluginRoutes) : pluginRoutes;
      // 先建一次：路径不在 /plugins/ 下的立即报错
      createPluginRouter(t.routes());
      table = t;
      // 插件实例撤销 / 替换：中止它进行中的请求（SSE 等长连接不留在旧实例上）
      unwatch = t.onChange?.((plugin) => dispatch?.abortPlugin(plugin));
    },
    async listen(port) {
      await app.listen(port, "0.0.0.0");
      const addr = fastify.server.address();
      return addr && typeof addr === "object" ? addr.port : port;
    },
    close: () => {
      unwatch?.();
      dispatch?.abortAll();
      return existing ? fastify.close() : app.close();
    },
    abortPluginRequests: () => dispatch?.abortAll(),
    closeAllConnections: () => fastify.server.closeAllConnections(),
  };
}
