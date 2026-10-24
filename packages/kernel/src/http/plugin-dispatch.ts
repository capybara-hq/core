import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import type { Logger } from "@capybara-hq/plugin-sdk";
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import FindMyWay from "find-my-way";
import type { Route } from "../ctx/create-ctx.js";
import { errorBody } from "../errors.js";
import { ACCESS_COOKIE, REFRESH_COOKIE } from "../identity/cookies.js";
import { codeForStatus, redactPath } from "./error.filter.js";

/** 插件路由都在此前缀下（ctx.http.route 已加 `/plugins/<name>` 前缀）。 */
export const PLUGIN_PREFIX = "/plugins/";

/** 插件路由表：按方法与路径（不含查询串）找到插件 handler；HEAD 没有专门路由时按 GET 匹配。 */
export interface PluginRouter {
  find(method: string, path: string): Route["handler"] | undefined;
}

/**
 * The live source of extension routes (C17): routes change as extension instances are revoked /
 * replaced, and the route table is rebuilt when `revision()` changes.
 * `unavailable(plugin)`: the extension belongs to this deployment but is not in the registry right
 * now (revoked / pending approval / failed to load), and its `/plugins/<plugin>/*` all answer 503
 * `extension.unavailable` (the routes stay mounted and only gate).
 */
export interface PluginRouteTable {
  routes(): Route[];
  revision(): number;
  unavailable(plugin: string): boolean | Promise<boolean>;
  /**
   * 插件实例变化（撤销 / 替换）的通知：转发层据此中止该插件进行中请求的 `req.signal`
   * （SSE 等长连接随之收尾，不留在旧实例上）。返回取消订阅函数。
   */
  onChange?(listener: (plugin: string) => void): () => void;
}

/** 固定的路由列表（测试与只挂一次的调用方）：版本不变、没有不可用的插件。 */
export function staticRouteTable(routes: Route[]): PluginRouteTable {
  return { routes: () => routes, revision: () => 0, unavailable: () => false };
}

/** 路径里的插件名（`/plugins/<name>/...` 的 `<name>`）；不在插件前缀下返回 undefined。 */
export function pluginOfPath(path: string): string | undefined {
  if (!path.startsWith(PLUGIN_PREFIX)) return undefined;
  const name = path.slice(PLUGIN_PREFIX.length).split("/", 1)[0];
  return name === undefined || name === "" ? undefined : name;
}

/** 用 find-my-way 建立插件路由表，路径语法与 Fastify 相同；路径不在 `/plugins/` 下时抛错。 */
export function createPluginRouter(routes: Route[]): PluginRouter {
  const router = FindMyWay();
  for (const r of routes) {
    if (!r.path.startsWith(PLUGIN_PREFIX)) {
      throw new Error(`plugin route ${r.method} ${r.path} is outside ${PLUGIN_PREFIX}`);
    }
    router.on(r.method, r.path, () => {}, { handler: r.handler });
  }
  return {
    find(method, path) {
      const lookup = (m: string) =>
        (
          router.find(m as FindMyWay.HTTPMethod, path)?.store as
            | { handler: Route["handler"] }
            | undefined
        )?.handler;
      return lookup(method) ?? (method === "HEAD" ? lookup("GET") : undefined);
    },
  };
}

/**
 * Registers `/plugins/*` in its own encapsulated scope and hands each request to the extension handler
 * as a Web `Request`: the scope removes the default parsers and takes every content type as a raw
 * Buffer, so the body the extension gets is the bytes the client sent.
 * - The extension belongs to this deployment but is not in the registry (revoked and so on) -> 503
 *   `extension.unavailable`; when an extension instance is revoked or replaced, the `req.signal` of
 *   that extension's in-progress requests is aborted (`abortPlugin`, triggered by the route source's
 *   `onChange`);
 * - not mounted or no match -> 404 `not_found`; HEAD without its own route is handled as GET, with no
 *   body in the response.
 * - A `Request` that cannot be built (e.g. a malformed Host) -> 400 `validation_failed`, not logged as
 *   an error.
 * - `req.signal` aborts only when the client disconnects before the response is written (not on
 *   normal completion); long-lived handlers use it to unsubscribe;
 * - a throwing handler is logged (path redacted with `redactPath`) and returns 500 `internal` (the
 *   error message is not echoed).
 * - Fastify's own errors (a body over 1 MiB and so on) are mapped to the error envelope by the
 *   scope's error handler: 4xx by the common error code table (413 `payload_too_large`, 415
 *   `unsupported_media_type` and so on), 5xx are logged and return `internal`.
 * - Shutdown: the returned `abortAll()` aborts the `req.signal` of every in-progress request (the
 *   extension's SSE and other long connections wind down by it without using the http shutdown
 *   budget); requests arriving afterwards start with an aborted `req.signal`. In-progress
 *   AbortControllers are held only for the request's lifetime.
 *   So extension handlers either finish quickly or tolerate the abort (see
 *   .agents/skills/writing-extensions "Extension route matching semantics").
 * Must be called before Nest `app.init()`.
 */
export async function registerPluginDispatch(
  fastify: FastifyInstance,
  getTable: () => PluginRouteTable | undefined,
  log: Logger,
): Promise<{ abortAll(): void; abortPlugin(plugin: string): void }> {
  /** 进行中的请求 → 所属插件（停机时全部中止；插件实例变化时只中止该插件的）。 */
  const inFlight = new Map<AbortController, string>();
  let stopping = false;
  // 按路由来源的版本缓存路由表（插件撤销 / 替换时版本变化才重建）
  let cached: { table: PluginRouteTable; revision: number; router: PluginRouter } | undefined;
  const routerOf = (table: PluginRouteTable): PluginRouter => {
    const revision = table.revision();
    if (!cached || cached.table !== table || cached.revision !== revision) {
      cached = { table, revision, router: createPluginRouter(table.routes()) };
    }
    return cached.router;
  };
  const handler = async (req: FastifyRequest, reply: FastifyReply) => {
    const path = req.url.split("?")[0] as string;
    const table = getTable();
    const plugin = pluginOfPath(path);
    if (table && plugin !== undefined && (await table.unavailable(plugin))) {
      return reply
        .code(503)
        .send(errorBody("extension.unavailable", `Extension ${plugin} is not available right now`));
    }
    const pluginHandler = table ? routerOf(table).find(req.method, path) : undefined;
    if (!pluginHandler) {
      return reply.code(404).send(errorBody("not_found", `Route ${req.method} ${path} not found`));
    }
    // 只在响应写完之前连接就关了（客户端断开）时中止 `req.signal`：长连接（SSE）的 handler 据此退订、收尾。
    // 正常写完后的 close 不中止（writableFinished 为 true）。
    const ac = new AbortController();
    inFlight.set(ac, plugin ?? "");
    if (stopping) ac.abort();
    reply.raw.once("close", () => {
      inFlight.delete(ac);
      if (!reply.raw.writableFinished) ac.abort();
    });
    let webReq: Request;
    try {
      webReq = toWebRequest(req, ac.signal);
    } catch {
      return reply.code(400).send(errorBody("validation_failed", "Malformed request"));
    }
    let res: Response;
    try {
      res = await pluginHandler(webReq);
    } catch (err) {
      log.error("plugin handler failed", { method: req.method, path: redactPath(path), err });
      return reply.code(500).send(errorBody("internal", "Internal error"));
    }
    reply.code(res.status);
    for (const [name, value] of res.headers) {
      if (name !== "set-cookie") reply.header(name, value);
    }
    for (const cookie of res.headers.getSetCookie()) reply.header("set-cookie", cookie);
    if (res.body === null) return reply.send();
    if (req.method === "HEAD") {
      await res.body.cancel().catch(() => {});
      return reply.send();
    }
    return reply.send(Readable.fromWeb(res.body as NodeReadableStream<Uint8Array>));
  };

  await fastify.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
    scope.setErrorHandler((err: FastifyError, req, reply) => {
      const status = typeof err.statusCode === "number" ? err.statusCode : 500;
      if (status >= 400 && status < 500) {
        return reply.code(status).send(errorBody(codeForStatus(status), err.message));
      }
      log.error("plugin request failed", { method: req.method, path: redactPath(req.url), err });
      return reply.code(status >= 500 ? status : 500).send(errorBody("internal", "Internal error"));
    });
    scope.all(`${PLUGIN_PREFIX}*`, handler);
  });
  return {
    abortAll() {
      stopping = true;
      for (const ac of [...inFlight.keys()]) ac.abort();
    },
    abortPlugin(plugin) {
      for (const [ac, p] of [...inFlight]) if (p === plugin) ac.abort();
    },
  };
}

const KERNEL_COOKIES: ReadonlySet<string> = new Set([ACCESS_COOKIE, REFRESH_COOKIE]);

/**
 * 从 Cookie 头里去掉内核会话 Cookie（`cap_at` / `cap_rt`）：插件 handler 不经内核鉴权，
 * 拿到这两个 Cookie 就能冒充用户调内核 API。全部去掉后返回 undefined（不传 Cookie 头）。
 */
export function stripKernelCookies(cookie: string): string | undefined {
  const kept = cookie
    .split(";")
    .map((p) => p.trim())
    .filter((p) => p !== "" && !KERNEL_COOKIES.has(p.split("=", 1)[0]?.trim() ?? ""));
  return kept.length > 0 ? kept.join("; ") : undefined;
}

/**
 * Fastify 请求 → Web `Request`：数组头用 `, ` 合并（`set-cookie` 逐条保留）；GET / HEAD 不带 body；
 * Cookie 头去掉内核会话 Cookie；`signal` 在响应写完之前客户端断开时中止。
 */
function toWebRequest(req: FastifyRequest, signal: AbortSignal): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (name === "cookie") {
      const kept = stripKernelCookies(Array.isArray(value) ? value.join("; ") : value);
      if (kept !== undefined) headers.set(name, kept);
      continue;
    }
    if (Array.isArray(value)) {
      if (name === "set-cookie") for (const v of value) headers.append(name, v);
      else headers.set(name, value.join(", "));
    } else {
      headers.set(name, value);
    }
  }
  const hasBody = req.method !== "GET" && req.method !== "HEAD" && Buffer.isBuffer(req.body);
  return new Request(`http://${req.headers.host ?? "localhost"}${req.url}`, {
    method: req.method,
    headers,
    signal,
    ...(hasBody && { body: req.body as Buffer }),
  });
}
