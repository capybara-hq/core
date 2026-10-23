import "reflect-metadata";
import type { Logger } from "@capybara-hq/plugin-sdk";
import fastifyCookie from "@fastify/cookie";
import { type DynamicModule, Module } from "@nestjs/common";
import { APP_FILTER, NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import type { FastifyReply, InjectOptions, LightMyRequestResponse } from "fastify";
import type { Route } from "../ctx/create-ctx.js";
import { ApiError, errorBody } from "../errors.js";
import { type AuthServices, authorizeEnterpriseAdmin } from "../identity/auth.guard.js";
import { ErrorFilter, redactPath } from "./error.filter.js";
import { type GatewayRoutes, registerGatewayRoutes } from "./gateway.module.js";
import { HealthController, type HealthOptions } from "./health.controller.js";
import { NestLogAdapter } from "./nest-logger.js";
import {
  createPluginRouter,
  type PluginRouteTable,
  registerPluginDispatch,
  staticRouteTable,
} from "./plugin-dispatch.js";
import { ACCOUNTS, API_TOKENS, HEALTH_OPTIONS, KERNEL_LOG, SESSIONS } from "./tokens.js";

export type { HealthOptions } from "./health.controller.js";

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
   * 挂载插件路由；路径必须以 `/plugins/` 开头。只能调用一次。传路由来源（{@link PluginRouteTable}）时
   * 每个请求实时取路由（插件撤销 / 替换后立即生效），撤销的插件返回 503 `plugin.unavailable`。
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
   * 包上传（{@link PACKAGE_UPLOAD_ROUTES}：插件包与企业目录包，`application/octet-stream`）的大小上限，
   * 即 `packages.maxBytes`。路由的 bodyLimit 多给 1 字节：恰好超出一个字节的包能到达处理函数、返回
   * `plugin.package_too_large`，更大的由 Fastify 直接拒绝（413 `payload_too_large`）。
   */
  packageMaxBytes?: number;
}

/** 插件包上传路由（Fastify 路由模板）。 */
export const PACKAGE_UPLOAD_ROUTE = "/api/v1/admin/plugins/packages/file";
/** 企业目录包上传路由（Fastify 路由模板）。 */
export const DIRECTORY_UPLOAD_ROUTE = "/api/v1/admin/directory/import/file";
/** 应用包上传路由（Fastify 路由模板）。 */
export const APP_UPLOAD_ROUTE = "/api/v1/admin/directory/apps/prepare/file";
/** 收原始字节（`application/octet-stream`、上限 `packages.maxBytes`、读请求体前先认证企业管理员）的上传路由。 */
export const PACKAGE_UPLOAD_ROUTES: ReadonlySet<string> = new Set([
  PACKAGE_UPLOAD_ROUTE,
  DIRECTORY_UPLOAD_ROUTE,
  APP_UPLOAD_ROUTE,
]);

/**
 * 把 `http.trustProxy` 配置转成 Fastify 的 trustProxy。布尔与 IP / CIDR 列表原样传入；
 * 跳数转成 `(addr, hop) => hop < n`：Fastify 5.12 起对 number 一律 fail closed（不信任任何一跳），
 * 所以由这里实现跳数语义——前提是服务只能经由这 n 层代理访问（配置说明里已写明，并推荐 CIDR 列表）。
 */
function fastifyTrustProxy(
  tp: boolean | number | string[],
): boolean | string[] | ((addr: string, hop: number) => boolean) {
  return typeof tp === "number" ? (_addr, hop) => hop < tp : tp;
}

/** 允许较大请求体的路由（Fastify 路由模板，只读常量表）及其上限。 */
const LARGE_BODY_ROUTES = new Set([
  "/api/v1/orgs/:orgId/connectors",
  "/api/v1/orgs/:orgId/connectors/preview",
]);
const LARGE_BODY_LIMIT = 6 * 1024 * 1024;

/** 根模块：总是含健康检查；`serveApi` 时 import `apiModule`；全局错误过滤器。 */
function rootModule(opts: CreateHttpAppOptions): DynamicModule {
  @Module({})
  class RootModule {}
  return {
    module: RootModule,
    imports: opts.serveApi && opts.apiModule ? [opts.apiModule] : [],
    controllers: [HealthController],
    providers: [
      { provide: KERNEL_LOG, useValue: opts.log },
      { provide: HEALTH_OPTIONS, useValue: opts.health },
      { provide: APP_FILTER, useClass: ErrorFilter },
    ],
  };
}

/**
 * 创建并初始化内核 HTTP 应用（NestJS + Fastify），不连接任何外部资源。
 * 插件路由不经过 Nest：在 Fastify 的独立作用域里统一转发 `/plugins/*`（见 plugin-dispatch.ts）；
 * 插件加载前 `/plugins/*` 一律 404。未匹配的内核路由同样返回 404 错误信封。
 */
export async function createHttpApp(opts: CreateHttpAppOptions): Promise<KernelHttpApp> {
  const app = await NestFactory.create<NestFastifyApplication>(
    rootModule(opts),
    new FastifyAdapter({ trustProxy: fastifyTrustProxy(opts.trustProxy ?? false) }),
    { logger: new NestLogAdapter(opts.log), abortOnError: false },
  );
  // Cookie 解析（会话 Cookie）；必须在 init 之前注册
  await app.register(fastifyCookie);
  const fastify = app.getHttpAdapter().getInstance();
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
  await app.init();

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
      return app.close();
    },
    abortPluginRequests: () => dispatch?.abortAll(),
    closeAllConnections: () => fastify.server.closeAllConnections(),
  };
}
